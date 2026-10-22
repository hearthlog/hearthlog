import { EVENT_SCHEMAS } from '#generated/event-schemas';
import { checkpointDigest, checkpointEntityEvents, checkpointSelection, type CheckpointChunk, type CheckpointEvent, type CheckpointManifest,
    type CheckpointPage, type LogMaintenance, type MaintenanceJob, type CompactionPreview } from '@hearthlog/contracts/history/checkpoint';
import { LedgerError, validationError } from './errors';

const PAGE = 128;
const MAX_PAGE_BYTES = 1_500_000;
const DEFAULT_DAY_WRITE_BUDGET = 10_000;
const standardTypes = new Set(Object.keys(EVENT_SCHEMAS));
const directives = ['EVENT_TOMBSTONED', 'WORKSPACE_RESTORED', 'EVENTS_EXCISED'];
type Row = Record<string, SqlStorageValue>;
interface JobRow extends Row {
    id: string; log_id: string; kind: MaintenanceJob['kind']; through_version: number;
    status: MaintenanceJob['status']; cursor: number; entity_cursor: string; pages: string;
    error: string | null; updated_at: string; day: string; writes: number; reads: number;
}
interface LayoutRow extends Row { log_id: string; compacted_through: number; generation: number; checkpoint: string | null; }
type ReadEvents = (logId: string, after: number, through: number, limit: number, entityId?: string) => Promise<CheckpointEvent[]>;

/** Durable job state lives in SQLite; immutable payloads live in the private bucket. */
export class LogMaintenanceStore {
    private cursors: Array<{ readonly rowsRead: number; readonly rowsWritten: number }> = [];
    private io = { r2Reads: 0, r2Writes: 0, r2Deletes: 0, r2ReadBytes: 0, r2WrittenBytes: 0 };

    /** Also meter the bounded source scan provided by LedgerApp. */
    observeSql<T extends { readonly rowsRead: number; readonly rowsWritten: number }>(cursor: T): T {
        this.cursors.push(cursor);
        return cursor;
    }

    private exec<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): SqlStorageCursor<T> {
        return this.observeSql(this.storage.sql.exec<T>(query, ...bindings));
    }

    private async getObject(key: string): Promise<R2ObjectBody | null> {
        this.io.r2Reads++;
        const object = await this.bucket!.get(key);
        this.io.r2ReadBytes += object?.size ?? 0;
        return object;
    }

    private async deleteObject(key: string): Promise<void> {
        this.io.r2Deletes++;
        await this.bucket!.delete(key);
    }

    constructor(private readonly storage: DurableObjectStorage, private readonly bucket: R2Bucket | undefined,
        private readonly appId: string, private readonly readEvents: ReadEvents, private readonly assertWritable: () => void = () => undefined,
        private readonly dayWriteBudget = DEFAULT_DAY_WRITE_BUDGET, private readonly dayReadBudget = 1_000_000) {}

    state(logId: string, jobId?: string): LogMaintenance {
        const layout = this.layout(logId);
        const job = this.exec<JobRow>(`SELECT * FROM log_maintenance_jobs WHERE log_id = ? ${jobId ? 'AND id = ?' : ''} ORDER BY rowid DESC LIMIT 1`, logId, ...(jobId ? [jobId] : [])).toArray()[0];
        return { compactedThroughVersion: layout.compacted_through, storageGeneration: layout.generation,
            checkpoint: layout.checkpoint ? JSON.parse(layout.checkpoint) : null,
            job: job ? publicJob(job) : null, available: Boolean(this.bucket) };
    }

    preview(logId: string): CompactionPreview {
        const state = this.state(logId);
        const totals = this.exec<{ count: number; bytes: number }>(`SELECT COUNT(*) AS count,
            COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes FROM log_events
            WHERE log_id = ? AND version <= ? AND archive_key IS NULL`, logId, state.checkpoint?.throughVersion ?? 0).one();
        return { checkpointId: state.checkpoint?.id ?? null, storageGeneration: state.storageGeneration,
            throughVersion: state.checkpoint?.throughVersion ?? 0, activePayloadEvents: totals.count, activePayloadBytes: totals.bytes,
            snapshotBytes: state.checkpoint?.pages.reduce((bytes, page) => bytes + page.bytes, 0) ?? 0 };
    }

    start(logId: string, id: string, kind: MaintenanceJob['kind'], expectedCheckpointId?: string, expectedGeneration?: number): LogMaintenance {
        if (!this.bucket) throw new LedgerError(503, { error: 'Unavailable', code: 'archive_unconfigured', message: 'Configure private Ledger archive storage first.' });
        this.storage.transactionSync(() => {
            this.assertWritable();
            const prior = this.exec<JobRow>('SELECT * FROM log_maintenance_jobs WHERE id = ?', id).toArray()[0];
            if (prior) {
                if (prior.log_id !== logId || prior.kind !== kind) throw validationError('Maintenance request ID already used');
                return;
            }
            const active = this.exec<JobRow>("SELECT * FROM log_maintenance_jobs WHERE log_id = ? AND status NOT IN ('complete', 'failed') LIMIT 1", logId).toArray()[0];
            if (active) throw new LedgerError(409, { error: 'Conflict', code: 'maintenance_in_progress', message: 'Resume the existing maintenance operation.' });
            const log = this.exec<{ version: number; status: string }>('SELECT version, status FROM logs WHERE id = ?', logId).toArray()[0];
            if (!log || log.status !== 'ready') throw validationError('Choose a ready log');
            const boundary = this.exec<{ action_index: number | null; action_size: number | null }>('SELECT action_index, action_size FROM log_events WHERE log_id = ? AND version = ?', logId, log.version).toArray()[0];
            if (boundary?.action_size && boundary.action_index !== boundary.action_size - 1) throw validationError('Incomplete action boundary');
            const checkpoint = this.state(logId).checkpoint;
            if (kind === 'compact' && (expectedCheckpointId !== checkpoint?.id || expectedGeneration !== this.layout(logId).generation)) {
                throw new LedgerError(409, { error: 'Conflict', code: 'stale_maintenance_preview', message: 'The snapshot changed. Review compaction again.' });
            }
            if (kind === 'compact' && (!checkpoint || checkpoint.throughVersion <= this.layout(logId).compacted_through)) {
                throw new LedgerError(409, { error: 'Conflict', code: 'snapshot_required', message: 'Create a newer verified snapshot before compacting.' });
            }
            this.exec(`INSERT INTO log_maintenance_jobs (id, log_id, kind, through_version, status, cursor, entity_cursor, pages, updated_at, day, writes)
                VALUES (?, ?, ?, ?, ?, 0, '', '[]', ?, ?, 0)`, id, logId, kind,
                kind === 'compact' ? checkpoint!.throughVersion : log.version, kind === 'compact' ? 'archiving' : 'building', new Date().toISOString(), day());
        });
        return this.state(logId, id);
    }

    async step(logId: string, id: string): Promise<LogMaintenance> {
        this.cursors = [];
        this.io = { r2Reads: 0, r2Writes: 0, r2Deletes: 0, r2ReadBytes: 0, r2WrittenBytes: 0 };
        const started = Date.now();
        let result: LogMaintenance | undefined;
        try {
            const before = this.exec<JobRow>('SELECT * FROM log_maintenance_jobs WHERE id = ? AND log_id = ?', id, logId).toArray()[0];
            result = await this.stepValue(logId, id);
            this.assertWritable();
            this.exec('UPDATE log_maintenance_jobs SET reads = ?, writes = ? WHERE id = ? AND log_id = ?',
                (before?.day === day() ? before.reads : 0) + this.cursors.reduce((count, cursor) => count + cursor.rowsRead, 0),
                (before?.day === day() ? before.writes : 0) + this.cursors.reduce((count, cursor) => count + cursor.rowsWritten, 0) + 1,
                id, logId);
            return result;
        } finally {
            console.info('ledger_maintenance_step', { appId: this.appId, logId, jobId: id,
                status: result?.job?.status, cursor: result?.job?.cursor, elapsedMs: Date.now() - started,
                rowsRead: this.cursors.reduce((count, cursor) => count + cursor.rowsRead, 0),
                rowsWritten: this.cursors.reduce((count, cursor) => count + cursor.rowsWritten, 0), ...this.io,
                snapshotEvents: result?.checkpoint?.eventCount, sourceEvents: result?.checkpoint?.sourceEventCount });
        }
    }

    private async stepValue(logId: string, id: string): Promise<LogMaintenance> {
        if (!this.bucket) throw new Error('Archive storage unavailable');
        this.assertWritable();
        let job = this.exec<JobRow>('SELECT * FROM log_maintenance_jobs WHERE id = ? AND log_id = ?', id, logId).toArray()[0];
        if (!job) throw validationError('Maintenance operation not found');
        if (job.status === 'complete') return this.state(logId, id);
        if (this.state(logId).job?.id !== id) throw new LedgerError(409, { error: 'Conflict', code: 'stale_maintenance', message: 'A newer maintenance operation replaced this one.' });
        if (job.status === 'failed') {
            this.exec("UPDATE log_maintenance_jobs SET status = ?, error = NULL WHERE id = ?", job.kind === 'snapshot' ? 'building' : 'archiving', id);
            job = { ...job, status: job.kind === 'snapshot' ? 'building' : 'archiving', error: null };
        }
        if (job.day !== day()) {
            this.exec('UPDATE log_maintenance_jobs SET day = ?, writes = 0, reads = 0, status = ? WHERE id = ?', day(), job.kind === 'snapshot' ? 'building' : 'archiving', id);
            job = { ...job, day: day(), writes: 0, reads: 0, status: job.kind === 'snapshot' ? 'building' : 'archiving' };
        }
        if (job.writes >= this.dayWriteBudget || job.reads >= this.dayReadBudget) {
            this.exec("UPDATE log_maintenance_jobs SET status = 'paused' WHERE id = ?", id);
            return this.state(logId, id);
        }
        try {
            if (job.status === 'building') await this.build(job);
            else if (job.status === 'cleaning') await this.clean(job);
            else if (job.status === 'archiving' || job.status === 'reclaiming') await this.archive(job);
        } catch (cause) {
            // Keep source rows and page cursors untouched when verification fails.
            this.assertWritable();
            this.exec("UPDATE log_maintenance_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
                cause instanceof Error ? cause.message : 'Maintenance failed', new Date().toISOString(), id);
        }
        return this.state(logId, id);
    }

    async chunk(logId: string, index: number): Promise<CheckpointChunk> {
        const manifest = this.state(logId).checkpoint;
        const page = manifest?.pages[index];
        if (!page || !this.bucket) throw validationError('Snapshot page not found');
        const object = await this.getObject(page.key);
        if (!object) throw archiveError('Snapshot page is missing');
        const value = await object.text();
        if (await checkpointDigest(value) !== page.sha256) throw archiveError('Snapshot checksum mismatch');
        return JSON.parse(value) as CheckpointChunk;
    }

    /** Bounded archive pages are verified before any accepted payload is reclaimed. */
    async hydrate(logId: string, events: CheckpointEvent[]): Promise<CheckpointEvent[]> {
        if (!events.length) return events;
        const references = this.exec<{ event_id: string; archive_key: string }>(
            'SELECT event_id, archive_key FROM log_events WHERE log_id = ? AND event_id IN (SELECT value FROM json_each(?)) AND archive_key IS NOT NULL',
            logId, JSON.stringify(events.map(event => event.id))).toArray();
        if (!references.length) return events;
        if (!this.bucket) throw archiveError('Archive storage unavailable');
        const wanted = new Set(events.map(event => event.id));
        const payloads = new Map<string, CheckpointEvent>();
        for (const key of new Set(references.map(row => row.archive_key))) {
            if (!key.startsWith(`v1/${this.appId}/`)) throw archiveError('Archive scope mismatch');
            const reference = this.exec<{ sha256: string }>('SELECT sha256 FROM log_archive_pages WHERE object_key = ? LIMIT 1', key).toArray()[0];
            if (!reference) throw archiveError('Archive manifest is missing');
            const object = await this.getObject(key);
            if (!object) throw archiveError('Archived history is missing');
            const value = await object.text();
            if (await checkpointDigest(value) !== reference.sha256) throw archiveError('Archive checksum mismatch');
            for (const event of JSON.parse(value) as CheckpointEvent[]) if (wanted.has(event.id)) payloads.set(event.id, event);
        }
        const archivedIds = new Set(references.map(row => row.event_id));
        return events.map(event => {
            if (!archivedIds.has(event.id)) return event;
            const original = payloads.get(event.id);
            if (!original || original.version !== event.version || original.entityId !== event.entityId
                || original.entityVersion !== event.entityVersion || original.type !== event.type || original.timestamp !== event.timestamp) throw archiveError('Archive identity mismatch');
            return original;
        });
    }

    private layout(logId: string): LayoutRow {
        return this.exec<LayoutRow>('SELECT * FROM log_storage WHERE log_id = ?', logId).toArray()[0]
            ?? { log_id: logId, compacted_through: 0, generation: 0, checkpoint: null };
    }

    private async build(job: JobRow): Promise<void> {
        if (job.cursor < job.through_version) {
            // Scan the primary log index once. Work records are populated in
            // budgeted batches rather than building an index over old history
            // during a schema migration (which could exhaust free-tier writes).
            const events = await this.readEvents(job.log_id, job.cursor, job.through_version, 16);
            if (!events.length || events[0]!.version !== job.cursor + 1) throw new Error('Snapshot source contains a gap');
            const selected = this.selection(job.log_id, job.through_version);
            const groups = new Map<string, CheckpointEvent[]>();
            for (const event of events) {
                const group = groups.get(event.entityId) ?? [];
                group.push(event); groups.set(event.entityId, group);
            }
            for (const [entityId, source] of groups) {
                const prior = this.exec<{ object_key: string }>('SELECT object_key FROM log_checkpoint_entities WHERE job_id = ? AND entity_id = ?', job.id, entityId).toArray()[0];
                const previous = prior ? await this.readWork(prior.object_key) : { events: [], claims: [] };
                const last = source[source.length - 1]!;
                const witnesses = checkpointEntityEvents([...previous.events, ...source.filter(event => selected(event) && !directives.includes(event.type))], [
                    event => typeof event.payload.status === 'string' ? `status:${event.payload.status}` : null,
                    event => typeof event.payload.thumbnailRef === 'string' ? 'thumbnail:string' : null,
                ], standardTypes);
                const value = JSON.stringify({ events: witnesses, claims: [{ entityId, currentVersion: last.entityVersion, logVersion: last.version }] });
                if (new TextEncoder().encode(value).byteLength > 8_000_000) throw new Error('Entity replay state exceeds the snapshot work budget');
                const key = `v1/${this.appId}/${job.log_id}/work/${job.id}/${last.version}.json`;
                await this.putVerified(key, value);
                this.storage.transactionSync(() => {
                    this.assertWritable();
                    this.exec(`INSERT INTO log_checkpoint_entities (job_id, entity_id, object_key) VALUES (?, ?, ?)
                        ON CONFLICT(job_id, entity_id) DO UPDATE SET object_key = excluded.object_key`, job.id, entityId, key);
                    this.exec('UPDATE log_maintenance_jobs SET writes = writes + 2 WHERE id = ?', job.id);
                });
                if (prior && prior.object_key !== key) await this.deleteObject(prior.object_key);
            }
            this.assertWritable();
            this.exec('UPDATE log_maintenance_jobs SET cursor = ?, writes = writes + 1, updated_at = ? WHERE id = ?',
                events[events.length - 1]!.version, new Date().toISOString(), job.id);
            return;
        }
        const pages = JSON.parse(job.pages) as CheckpointPage[];
        const entities = this.exec<{ entity_id: string; object_key: string }>(`SELECT entity_id, object_key FROM log_checkpoint_entities
            WHERE job_id = ? AND entity_id > ? ORDER BY entity_id LIMIT 16`, job.id, job.entity_cursor).toArray();
        if (!entities.length) {
            const manifest: CheckpointManifest = { format: 1, appId: this.appId, logId: job.log_id, id: job.id,
                throughVersion: job.through_version, createdAt: new Date().toISOString(), pages,
                eventCount: pages.reduce((count, page) => count + page.count, 0), sourceEventCount: job.through_version,
                sha256: await checkpointDigest(JSON.stringify(pages)) };
            this.storage.transactionSync(() => {
                this.assertWritable();
                this.exec(`INSERT INTO log_storage (log_id, compacted_through, generation, checkpoint) VALUES (?, 0, 0, ?)
                    ON CONFLICT(log_id) DO UPDATE SET checkpoint = excluded.checkpoint`, job.log_id, JSON.stringify(manifest));
                this.exec("UPDATE log_maintenance_jobs SET status = 'cleaning', updated_at = ? WHERE id = ?", new Date().toISOString(), job.id);
            });
            return;
        }
        const chunk: CheckpointChunk = { events: [], claims: [] };
        let last = job.entity_cursor;
        for (const entity of entities) {
            const part = await this.readWork(entity.object_key);
            chunk.events.push(...part.events); chunk.claims.push(...part.claims);
            last = entity.entity_id;
            if (new TextEncoder().encode(JSON.stringify(chunk)).byteLength >= MAX_PAGE_BYTES) break;
        }
        chunk.events.sort((a, b) => a.version - b.version);
        const value = JSON.stringify(chunk);
        const key = `v1/${this.appId}/${job.log_id}/snapshots/${job.id}/${pages.length}.json`;
        const sha256 = await this.putVerified(key, value);
        pages.push({ key, sha256, count: chunk.events.length, bytes: new TextEncoder().encode(value).byteLength });
        this.assertWritable();
        this.exec('UPDATE log_maintenance_jobs SET entity_cursor = ?, pages = ?, writes = writes + 1, updated_at = ? WHERE id = ?',
            last, JSON.stringify(pages), new Date().toISOString(), job.id);
    }

    private async readWork(key: string): Promise<CheckpointChunk> {
        const object = await this.getObject(key);
        if (!object) throw new Error('Snapshot work page is missing');
        const encoded = await object.text();
        if (await checkpointDigest(encoded) !== object.customMetadata?.sha256) throw new Error('Snapshot work checksum mismatch');
        return JSON.parse(encoded) as CheckpointChunk;
    }

    private async clean(job: JobRow): Promise<void> {
        const rows = this.exec<{ entity_id: string; object_key: string }>('SELECT entity_id, object_key FROM log_checkpoint_entities WHERE job_id = ? LIMIT 16', job.id).toArray();
        for (const row of rows) {
            await this.deleteObject(row.object_key);
            this.assertWritable();
            this.exec('DELETE FROM log_checkpoint_entities WHERE job_id = ? AND entity_id = ?', job.id, row.entity_id);
        }
        this.exec('UPDATE log_maintenance_jobs SET status = ?, writes = writes + ?, updated_at = ? WHERE id = ?',
            rows.length ? 'cleaning' : 'complete', rows.length + 1, new Date().toISOString(), job.id);
    }

    private async putVerified(key: string, value: string): Promise<string> {
        const sha256 = await checkpointDigest(value);
        this.io.r2Writes++;
        this.io.r2WrittenBytes += new TextEncoder().encode(value).byteLength;
        await this.bucket!.put(key, value, { customMetadata: { sha256 }, httpMetadata: { contentType: 'application/json' } });
        const check = await this.getObject(key);
        if (!check || await checkpointDigest(await check.text()) !== sha256) throw new Error('Snapshot verification failed');
        return sha256;
    }

    private async archive(job: JobRow): Promise<void> {
        // Metadata stays as the compact identity/action registry. Only payloads
        // move, so historical boundaries and event/request uniqueness survive.
        const rows = this.exec<{ version: number }>(`SELECT version FROM log_events WHERE log_id = ?
            AND version <= ? AND version > ? AND archive_key IS NULL ORDER BY version LIMIT ?`, job.log_id, job.through_version, job.cursor, PAGE).toArray();
        if (!rows.length) {
            this.storage.transactionSync(() => {
            this.assertWritable();
                this.exec('UPDATE log_storage SET compacted_through = MAX(compacted_through, ?), generation = generation + 1 WHERE log_id = ?', job.through_version, job.log_id);
                this.exec("UPDATE log_maintenance_jobs SET status = 'complete', cursor = ?, updated_at = ? WHERE id = ?", job.through_version, new Date().toISOString(), job.id);
            });
            return;
        }
        const first = rows[0]!.version;
        const events = await this.readEvents(job.log_id, first - 1, rows[rows.length - 1]!.version, PAGE);
        const value = JSON.stringify(events);
        const sha256 = await checkpointDigest(value);
        const key = `v1/${this.appId}/${job.log_id}/archive/${job.id}/${first}.json`;
        await this.putVerified(key, value);
        this.storage.transactionSync(() => {
            this.assertWritable();
            this.exec(`INSERT OR IGNORE INTO log_archive_pages (log_id, first_version, last_version, object_key, sha256) VALUES (?, ?, ?, ?, ?)`,
                job.log_id, first, events[events.length - 1]!.version, key, sha256);
            const reclaimed = this.exec(`UPDATE log_events SET archive_key = ?, payload_bytes = COALESCE(payload_bytes, length(CAST(payload AS BLOB))), payload = CASE WHEN event_type IN
                ('EVENT_TOMBSTONED', 'WORKSPACE_RESTORED', 'EVENTS_EXCISED') THEN payload ELSE '{}' END
                WHERE log_id = ? AND version >= ? AND version <= ? AND archive_key IS NULL`, key, job.log_id, first, events[events.length - 1]!.version);
            reclaimed.toArray();
            this.exec("UPDATE log_maintenance_jobs SET status = 'archiving', cursor = ?, writes = writes + ?, updated_at = ? WHERE id = ?",
                events[events.length - 1]!.version, reclaimed.rowsWritten + 2, new Date().toISOString(), job.id);
        });
    }

    private selection(logId: string, through: number): (event: CheckpointEvent) => boolean {
        const rows = this.exec<{ version: number; event_id: string; event_type: string; payload: string }>(`SELECT version, event_id, event_type, payload FROM log_events
            WHERE log_id = ? AND version <= ? AND event_type IN ('EVENT_TOMBSTONED', 'WORKSPACE_RESTORED', 'EVENTS_EXCISED') ORDER BY version DESC`, logId, through).toArray();
        return checkpointSelection(rows.map(event => ({ id: event.event_id, type: event.event_type,
            version: event.version, payload: JSON.parse(event.payload) as Record<string, unknown> })), through);
    }
}

function day(): string { return new Date().toISOString().slice(0, 10); }
function archiveError(message: string): LedgerError { return new LedgerError(503, { error: 'Unavailable', code: 'archive_unavailable', message }); }
function publicJob(row: JobRow): MaintenanceJob {
    return { id: row.id, logId: row.log_id, kind: row.kind, throughVersion: row.through_version, status: row.status,
        cursor: row.cursor, error: row.error, updatedAt: row.updated_at };
}
