import { EVENT_SCHEMAS } from '#generated/event-schemas';
import { checkpointDigest, checkpointSelection, checkpointStateVersions, foldCheckpointEvent, newCheckpointEntityState,
    type CheckpointChunk, type CheckpointEntityState, type CheckpointEvent, type CheckpointManifest, type CheckpointPage,
    type CheckpointSelector, type LogMaintenance, type MaintenanceJob, type CompactionPreview } from '@hearthlog/contracts/history/checkpoint';
import { LedgerError, validationError } from './errors';

/** Events archived per compaction step. */
const PAGE = 128;
/** Source events folded per snapshot step (also bounded by the byte window of the reader). */
const FOLD_EVENTS = 512;
/** Entities indexed into snapshot pages per step. */
const INDEX_ENTITIES = 256;
const CLEAN_ROWS = 256;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_STATE_BYTES = 1_500_000;
const MAX_MARKER_BYTES = 1_000_000;
/** Automatic attempts before a job stops and waits for an explicit retry. */
export const MAX_ATTEMPTS = 5;
const DEFAULT_DAY_WRITE_BUDGET = 10_000;
const standardTypes = new Set(Object.keys(EVENT_SCHEMAS));
const directives = ['EVENT_TOMBSTONED', 'WORKSPACE_RESTORED', 'EVENTS_EXCISED'];
const SELECTORS: readonly CheckpointSelector[] = [
    event => typeof event.payload.status === 'string' ? `status:${event.payload.status}` : null,
    event => typeof event.payload.thumbnailRef === 'string' ? 'thumbnail:string' : null,
];
type Row = Record<string, SqlStorageValue>;
type Phase = 'reset' | 'seed' | 'fold' | 'index' | 'pages';
interface JobRow extends Row {
    id: string; log_id: string; kind: MaintenanceJob['kind']; through_version: number;
    status: MaintenanceJob['status']; cursor: number; entity_cursor: string; pages: string;
    error: string | null; updated_at: string; day: string; writes: number; reads: number;
    phase: Phase | null; version_cursor: number; attempts: number; retry_at: string | null;
    resume_at: string | null; pause_reason: 'writes' | 'reads' | null; paused_status: MaintenanceJob['status'] | null;
    markers: string | null;
}
interface LayoutRow extends Row { log_id: string; compacted_through: number; generation: number; checkpoint: string | null; }
/** Replay slots for one entity plus the claim it held at the last source event. */
interface WorkState { s: CheckpointEntityState; c: { currentVersion: number; logVersion: number }; }
type Marker = Pick<CheckpointEvent, 'id' | 'type' | 'version' | 'payload'>;
type ReadEvents = (logId: string, after: number, through: number, limit: number) => Promise<CheckpointEvent[]>;
type ReadVersions = (logId: string, versions: number[]) => Promise<CheckpointEvent[]>;

/** Durable job state lives in SQLite; immutable payloads live in the private bucket. */
export class LogMaintenanceStore {
    private cursors: Array<{ readonly rowsRead: number; readonly rowsWritten: number }> = [];
    private io = { r2Reads: 0, r2Writes: 0, r2Deletes: 0, r2ReadBytes: 0, r2WrittenBytes: 0 };

    /** Also meter the bounded source scan provided by LedgerApp. */
    observeSql<T extends { readonly rowsRead: number; readonly rowsWritten: number }>(cursor: T): T {
        this.cursors.push(cursor);
        return cursor;
    }

    /** Run a statement to completion so its row counts are final, and meter it. */
    private query<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(statement: string, ...bindings: SqlStorageValue[]): T[] {
        const cursor = this.observeSql(this.storage.sql.exec<T>(statement, ...bindings));
        return cursor.toArray();
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
        private readonly appId: string, private readonly readEvents: ReadEvents, private readonly readVersions: ReadVersions,
        private readonly assertWritable: () => void = () => undefined,
        private readonly dayWriteBudget = DEFAULT_DAY_WRITE_BUDGET, private readonly dayReadBudget = 1_000_000) {}

    state(logId: string, jobId?: string): LogMaintenance {
        const layout = this.layout(logId);
        // Polled often: leave out the large work columns (pages, markers).
        const job = this.query<JobRow>(`SELECT id, log_id, kind, through_version, status, cursor, error, updated_at, attempts, retry_at,
            resume_at, pause_reason FROM log_maintenance_jobs WHERE log_id = ? ${jobId ? 'AND id = ?' : ''} ORDER BY rowid DESC LIMIT 1`,
            logId, ...(jobId ? [jobId] : []))[0];
        return { compactedThroughVersion: layout.compacted_through, storageGeneration: layout.generation,
            checkpoint: layout.checkpoint ? JSON.parse(layout.checkpoint) : null,
            job: job ? publicJob(job) : null, available: Boolean(this.bucket) };
    }

    preview(logId: string): CompactionPreview {
        const state = this.state(logId);
        const totals = this.query<{ count: number; bytes: number }>(`SELECT COUNT(*) AS count,
            COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes FROM log_events
            WHERE log_id = ? AND version <= ? AND archive_key IS NULL`, logId, state.checkpoint?.throughVersion ?? 0)[0]!;
        return { checkpointId: state.checkpoint?.id ?? null, storageGeneration: state.storageGeneration,
            throughVersion: state.checkpoint?.throughVersion ?? 0, activePayloadEvents: totals.count, activePayloadBytes: totals.bytes,
            snapshotBytes: state.checkpoint?.pages.reduce((bytes, page) => bytes + page.bytes, 0) ?? 0 };
    }

    start(logId: string, id: string, kind: MaintenanceJob['kind'], expectedCheckpointId?: string, expectedGeneration?: number): LogMaintenance {
        if (!this.bucket) throw new LedgerError(503, { error: 'Unavailable', code: 'archive_unconfigured', message: 'Configure private Ledger archive storage first.' });
        this.storage.transactionSync(() => {
            this.assertWritable();
            const prior = this.query<JobRow>('SELECT id, log_id, kind FROM log_maintenance_jobs WHERE id = ?', id)[0];
            if (prior) {
                if (prior.log_id !== logId || prior.kind !== kind) throw validationError('Maintenance request ID already used');
                return;
            }
            const active = this.query<JobRow>("SELECT id FROM log_maintenance_jobs WHERE log_id = ? AND status NOT IN ('complete', 'failed') LIMIT 1", logId)[0];
            if (active) throw new LedgerError(409, { error: 'Conflict', code: 'maintenance_in_progress', message: 'Resume the existing maintenance operation.' });
            const log = this.query<{ version: number; status: string }>('SELECT version, status FROM logs WHERE id = ?', logId)[0];
            if (!log || log.status !== 'ready') throw validationError('Choose a ready log');
            const boundary = this.query<{ action_index: number | null; action_size: number | null }>('SELECT action_index, action_size FROM log_events WHERE log_id = ? AND version = ?', logId, log.version)[0];
            if (boundary?.action_size && boundary.action_index !== boundary.action_size - 1) throw validationError('Incomplete action boundary');
            const checkpoint = this.state(logId).checkpoint;
            if (kind === 'compact' && (expectedCheckpointId !== checkpoint?.id || expectedGeneration !== this.layout(logId).generation)) {
                throw new LedgerError(409, { error: 'Conflict', code: 'stale_maintenance_preview', message: 'The snapshot changed. Review compaction again.' });
            }
            if (kind === 'compact' && (!checkpoint || checkpoint.throughVersion <= this.layout(logId).compacted_through)) {
                throw new LedgerError(409, { error: 'Conflict', code: 'snapshot_required', message: 'Create a newer verified snapshot before compacting.' });
            }
            // A new snapshot can start from the previous one's retained facts
            // instead of re-reading the whole (archived) history, unless a
            // replay directive since then could reach back behind it.
            let phase: Phase = 'fold', cursor = 0;
            if (kind === 'snapshot' && checkpoint && checkpoint.throughVersion > 0 && checkpoint.throughVersion <= log.version
                && !this.query(`SELECT 1 FROM log_events WHERE log_id = ? AND version > ? AND event_type IN ('EVENT_TOMBSTONED', 'WORKSPACE_RESTORED', 'EVENTS_EXCISED') LIMIT 1`,
                    logId, checkpoint.throughVersion).length) {
                phase = 'seed'; cursor = checkpoint.throughVersion;
            }
            this.query(`INSERT INTO log_maintenance_jobs (id, log_id, kind, through_version, status, cursor, entity_cursor, pages, updated_at, day, writes, phase)
                VALUES (?, ?, ?, ?, ?, ?, '', '[]', ?, ?, 0, ?)`, id, logId, kind,
                kind === 'compact' ? checkpoint!.throughVersion : log.version, kind === 'compact' ? 'archiving' : 'building', cursor,
                new Date().toISOString(), day(), kind === 'compact' ? null : phase);
        });
        return this.state(logId, id);
    }

    async step(logId: string, id: string): Promise<LogMaintenance> {
        this.cursors = [];
        this.io = { r2Reads: 0, r2Writes: 0, r2Deletes: 0, r2ReadBytes: 0, r2WrittenBytes: 0 };
        const started = Date.now();
        let result: LogMaintenance | undefined;
        try {
            const before = this.query<JobRow>('SELECT day, reads, writes FROM log_maintenance_jobs WHERE id = ? AND log_id = ?', id, logId)[0];
            result = await this.stepValue(logId, id);
            this.assertWritable();
            this.query('UPDATE log_maintenance_jobs SET reads = ?, writes = ? WHERE id = ? AND log_id = ?',
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

    /** Active jobs whose next step is due now, least recently advanced first. */
    dueJobs(now = Date.now()): Array<{ logId: string; id: string }> {
        return this.activeJobs().filter(job => job.wake <= now).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
            .map(job => ({ logId: job.logId, id: job.id }));
    }

    /** Earliest time any active job needs another step, or null when none does. */
    nextWake(): number | null {
        const wakes = this.activeJobs().map(job => job.wake);
        return wakes.length ? Math.min(...wakes) : null;
    }

    hasActiveJob(): boolean {
        return this.query("SELECT 1 FROM log_maintenance_jobs WHERE status NOT IN ('complete', 'failed') LIMIT 1").length > 0;
    }

    private activeJobs(): Array<{ id: string; logId: string; wake: number; updatedAt: string }> {
        const now = Date.now();
        return this.query<JobRow>(`SELECT id, log_id, status, day, updated_at, retry_at, resume_at FROM log_maintenance_jobs
            WHERE status NOT IN ('complete', 'failed')`).map(job => {
            let wake = now;
            if (job.status === 'paused') wake = job.resume_at ? Date.parse(job.resume_at) : nextMidnight(job.day);
            else if (job.retry_at) wake = Date.parse(job.retry_at);
            return { id: job.id, logId: job.log_id, wake: Number.isFinite(wake) ? wake : now, updatedAt: job.updated_at };
        });
    }

    private async stepValue(logId: string, id: string): Promise<LogMaintenance> {
        if (!this.bucket) throw new Error('Archive storage unavailable');
        this.assertWritable();
        let job = this.query<JobRow>('SELECT * FROM log_maintenance_jobs WHERE id = ? AND log_id = ?', id, logId)[0];
        if (!job) throw validationError('Maintenance operation not found');
        if (job.status === 'complete') return this.state(logId, id);
        if (this.state(logId).job?.id !== id) throw new LedgerError(409, { error: 'Conflict', code: 'stale_maintenance', message: 'A newer maintenance operation replaced this one.' });
        const resumeStatus = (row: JobRow): MaintenanceJob['status'] => row.paused_status && row.paused_status !== 'paused' && row.paused_status !== 'failed'
            ? row.paused_status : row.kind === 'snapshot' ? 'building' : 'archiving';
        if (job.status === 'failed') {
            // An explicit retry: start counting attempts again from the failed step.
            this.query("UPDATE log_maintenance_jobs SET status = ?, error = NULL, attempts = 0, retry_at = NULL, paused_status = NULL WHERE id = ?", resumeStatus(job), id);
            job = { ...job, status: resumeStatus(job), error: null, attempts: 0, retry_at: null, paused_status: null };
        }
        if (job.day !== day()) {
            const status = job.status === 'paused' ? resumeStatus(job) : job.status;
            this.query('UPDATE log_maintenance_jobs SET day = ?, writes = 0, reads = 0, status = ?, pause_reason = NULL, resume_at = NULL, paused_status = NULL WHERE id = ?', day(), status, id);
            job = { ...job, day: day(), writes: 0, reads: 0, status, pause_reason: null, resume_at: null, paused_status: null };
        }
        if (job.status === 'paused' || job.writes >= this.dayWriteBudget || job.reads >= this.dayReadBudget) {
            if (job.status !== 'paused') {
                const reason = job.writes >= this.dayWriteBudget ? 'writes' : 'reads';
                this.query("UPDATE log_maintenance_jobs SET status = 'paused', paused_status = ?, pause_reason = ?, resume_at = ?, updated_at = ? WHERE id = ?",
                    job.status, reason, new Date(nextMidnight(job.day)).toISOString(), new Date().toISOString(), id);
            }
            return this.state(logId, id);
        }
        try {
            if (job.status === 'building') await this.build(job);
            else if (job.status === 'cleaning') this.clean(job);
            else if (job.status === 'archiving' || job.status === 'reclaiming') await this.archive(job);
            if (job.attempts > 0 || job.error) {
                this.query('UPDATE log_maintenance_jobs SET attempts = 0, error = NULL, retry_at = NULL WHERE id = ?', id);
            }
        } catch (cause) {
            // Access problems are not job failures; source rows and cursors stay untouched.
            this.assertWritable();
            const attempts = job.attempts + 1;
            const message = cause instanceof Error ? cause.message : 'Maintenance failed';
            const now = new Date().toISOString();
            if (attempts >= MAX_ATTEMPTS) {
                this.query("UPDATE log_maintenance_jobs SET status = 'failed', paused_status = ?, error = ?, attempts = ?, retry_at = NULL, updated_at = ? WHERE id = ?",
                    job.status, message, attempts, now, id);
            } else {
                // Stay in the current stage and let the alarm retry with backoff; the error stays visible meanwhile.
                this.query('UPDATE log_maintenance_jobs SET error = ?, attempts = ?, retry_at = ?, updated_at = ? WHERE id = ?',
                    message, attempts, new Date(Date.now() + Math.min(600_000, 15_000 * 2 ** (attempts - 1))).toISOString(), now, id);
            }
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
        const references = this.query<{ event_id: string; archive_key: string }>(
            'SELECT event_id, archive_key FROM log_events WHERE log_id = ? AND event_id IN (SELECT value FROM json_each(?)) AND archive_key IS NOT NULL',
            logId, JSON.stringify(events.map(event => event.id)));
        if (!references.length) return events;
        if (!this.bucket) throw archiveError('Archive storage unavailable');
        const wanted = new Set(events.map(event => event.id));
        const payloads = new Map<string, CheckpointEvent>();
        for (const key of new Set(references.map(row => row.archive_key))) {
            if (!key.startsWith(`v1/${this.appId}/`)) throw archiveError('Archive scope mismatch');
            const reference = this.query<{ sha256: string }>('SELECT sha256 FROM log_archive_pages WHERE object_key = ? LIMIT 1', key)[0];
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
        return this.query<LayoutRow>('SELECT * FROM log_storage WHERE log_id = ?', logId)[0]
            ?? { log_id: logId, compacted_through: 0, generation: 0, checkpoint: null };
    }

    private async build(job: JobRow): Promise<void> {
        switch (job.phase ?? 'reset') {
            case 'reset': return this.reset(job);
            case 'seed': return this.seed(job);
            case 'fold':
                if (job.cursor < job.through_version) return this.fold(job);
                this.setPhase(job, 'index');
                return this.index({ ...job, phase: 'index' });
            case 'index': return this.index(job);
            case 'pages': return this.pages(job);
        }
    }

    private setPhase(job: JobRow, phase: Phase, extra: { cursor?: number; versionCursor?: number; entityCursor?: string; pages?: CheckpointPage[] } = {}): void {
        this.assertWritable();
        this.query('UPDATE log_maintenance_jobs SET phase = ?, cursor = ?, version_cursor = ?, entity_cursor = ?, pages = ?, updated_at = ? WHERE id = ?',
            phase, extra.cursor ?? job.cursor, extra.versionCursor ?? 0, extra.entityCursor ?? '', JSON.stringify(extra.pages ?? []),
            new Date().toISOString(), job.id);
    }

    /** Discard partial work (including work files of the former R2-based builder) and restart from the first event. */
    private async reset(job: JobRow): Promise<void> {
        const legacy = this.query<{ entity_id: string; object_key: string }>('SELECT entity_id, object_key FROM log_checkpoint_entities WHERE job_id = ? LIMIT 16', job.id);
        if (legacy.length) {
            for (const row of legacy) {
                if (row.object_key) await this.deleteObject(row.object_key);
                this.assertWritable();
                this.query('DELETE FROM log_checkpoint_entities WHERE job_id = ? AND entity_id = ?', job.id, row.entity_id);
            }
            return;
        }
        if (this.deleteWork(job.id)) return;
        this.setPhase(job, 'fold', { cursor: 0 });
    }

    /** Delete a bounded batch of work rows; true while any remain. */
    private deleteWork(jobId: string): boolean {
        this.assertWritable();
        const entities = this.query<{ entity_id: string }>('SELECT entity_id FROM log_checkpoint_work WHERE job_id = ? LIMIT ?', jobId, CLEAN_ROWS);
        if (entities.length) {
            this.query('DELETE FROM log_checkpoint_work WHERE job_id = ? AND entity_id IN (SELECT value FROM json_each(?))', jobId, JSON.stringify(entities.map(row => row.entity_id)));
            return true;
        }
        const versions = this.query<{ version: number }>('SELECT version FROM log_checkpoint_versions WHERE job_id = ? LIMIT ?', jobId, CLEAN_ROWS * 2);
        if (versions.length) {
            this.query('DELETE FROM log_checkpoint_versions WHERE job_id = ? AND version IN (SELECT value FROM json_each(?))', jobId, JSON.stringify(versions.map(row => row.version)));
            return true;
        }
        return false;
    }

    private loadWork(jobId: string, entityIds: string[]): Map<string, WorkState> {
        return new Map(this.query<{ entity_id: string; state: string }>(
            'SELECT entity_id, state FROM log_checkpoint_work WHERE job_id = ? AND entity_id IN (SELECT value FROM json_each(?))',
            jobId, JSON.stringify(entityIds)).map(row => [row.entity_id, JSON.parse(row.state) as WorkState]));
    }

    /** Persist updated entity states in one statement. */
    private saveWork(jobId: string, states: Map<string, WorkState>): void {
        const rows: Array<{ id: string; state: WorkState }> = [];
        for (const [id, state] of states) {
            if (JSON.stringify(state).length > MAX_STATE_BYTES) throw new Error('Entity replay state exceeds the snapshot work budget');
            rows.push({ id, state });
        }
        this.query(`INSERT INTO log_checkpoint_work (job_id, entity_id, state)
            SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.state') FROM json_each(?) WHERE true
            ON CONFLICT(job_id, entity_id) DO UPDATE SET state = excluded.state`, jobId, JSON.stringify(rows));
    }

    /** Start from the previous snapshot's retained facts: one of its pages per step. */
    private async seed(job: JobRow): Promise<void> {
        const checkpoint = this.layout(job.log_id).checkpoint ? JSON.parse(this.layout(job.log_id).checkpoint!) as CheckpointManifest : null;
        if (!checkpoint || checkpoint.throughVersion !== job.cursor) throw new Error('The previous snapshot changed while seeding');
        if (job.version_cursor >= checkpoint.pages.length) {
            this.setPhase(job, 'fold');
            return;
        }
        const chunk = await this.chunk(job.log_id, job.version_cursor);
        const touched = new Set<string>([...chunk.events.map(event => event.entityId), ...chunk.claims.map(claim => claim.entityId)]);
        const states = this.loadWork(job.id, [...touched]);
        const work = (entityId: string): WorkState => {
            let state = states.get(entityId);
            if (!state) { state = { s: newCheckpointEntityState(), c: { currentVersion: 0, logVersion: 0 } }; states.set(entityId, state); }
            return state;
        };
        for (const event of [...chunk.events].sort((a, b) => a.version - b.version)) foldCheckpointEvent(work(event.entityId).s, event, SELECTORS, standardTypes);
        for (const claim of chunk.claims) work(claim.entityId).c = { currentVersion: claim.currentVersion, logVersion: claim.logVersion };
        this.storage.transactionSync(() => {
            this.assertWritable();
            this.saveWork(job.id, states);
            this.query('UPDATE log_maintenance_jobs SET version_cursor = ?, updated_at = ? WHERE id = ?', job.version_cursor + 1, new Date().toISOString(), job.id);
        });
    }

    /** Fold the next window of source events into per-entity replay slots. */
    private async fold(job: JobRow): Promise<void> {
        const events = await this.readEvents(job.log_id, job.cursor, job.through_version, FOLD_EVENTS);
        if (!events.length || events[0]!.version !== job.cursor + 1 || events[events.length - 1]!.version - events[0]!.version !== events.length - 1) {
            throw new Error('Snapshot source contains a gap');
        }
        const selected = this.selection(job);
        const groups = new Map<string, CheckpointEvent[]>();
        for (const event of events) {
            const group = groups.get(event.entityId) ?? [];
            group.push(event); groups.set(event.entityId, group);
        }
        const states = this.loadWork(job.id, [...groups.keys()]);
        for (const [entityId, source] of groups) {
            const state = states.get(entityId) ?? { s: newCheckpointEntityState(), c: { currentVersion: 0, logVersion: 0 } };
            for (const event of source) if (selected(event) && !directives.includes(event.type)) foldCheckpointEvent(state.s, event, SELECTORS, standardTypes);
            const last = source[source.length - 1]!;
            state.c = { currentVersion: last.entityVersion, logVersion: last.version };
            states.set(entityId, state);
        }
        this.storage.transactionSync(() => {
            this.assertWritable();
            this.saveWork(job.id, states);
            this.query('UPDATE log_maintenance_jobs SET cursor = ?, updated_at = ? WHERE id = ?',
                events[events.length - 1]!.version, new Date().toISOString(), job.id);
        });
    }

    /** Turn entity slots into claim pages and the list of source versions to retain. */
    private async index(job: JobRow): Promise<void> {
        const pages = JSON.parse(job.pages) as CheckpointPage[];
        const rows = this.query<{ entity_id: string; state: string }>(`SELECT entity_id, state FROM log_checkpoint_work
            WHERE job_id = ? AND entity_id > ? ORDER BY entity_id LIMIT ?`, job.id, job.entity_cursor, INDEX_ENTITIES);
        if (!rows.length) {
            this.setPhase(job, 'pages', { pages });
            return;
        }
        const versions = new Set<number>();
        const claims: CheckpointChunk['claims'] = [];
        for (const row of rows) {
            const work = JSON.parse(row.state) as WorkState;
            for (const version of checkpointStateVersions(work.s)) versions.add(version);
            if (work.c.logVersion > 0) claims.push({ entityId: row.entity_id, currentVersion: work.c.currentVersion, logVersion: work.c.logVersion });
        }
        if (claims.length) {
            const value = JSON.stringify({ events: [], claims } satisfies CheckpointChunk);
            const key = `v1/${this.appId}/${job.log_id}/snapshots/${job.id}/${pages.length}.json`;
            pages.push({ key, sha256: await this.put(key, value), count: 0, bytes: new TextEncoder().encode(value).byteLength });
        }
        this.storage.transactionSync(() => {
            this.assertWritable();
            if (versions.size) this.query('INSERT OR IGNORE INTO log_checkpoint_versions (job_id, version) SELECT ?, value FROM json_each(?)', job.id, JSON.stringify([...versions]));
            this.query('UPDATE log_maintenance_jobs SET entity_cursor = ?, pages = ?, updated_at = ? WHERE id = ?',
                rows[rows.length - 1]!.entity_id, JSON.stringify(pages), new Date().toISOString(), job.id);
        });
    }

    /** Write retained source events in version order, then publish the manifest. */
    private async pages(job: JobRow): Promise<void> {
        const pages = JSON.parse(job.pages) as CheckpointPage[];
        const rows = this.query<{ version: number }>(`SELECT version FROM log_checkpoint_versions WHERE job_id = ? AND version > ?
            ORDER BY version LIMIT ?`, job.id, job.version_cursor, PAGE);
        if (!rows.length) {
            const manifest: CheckpointManifest = { format: 1, appId: this.appId, logId: job.log_id, id: job.id,
                throughVersion: job.through_version, createdAt: new Date().toISOString(), pages,
                eventCount: pages.reduce((count, page) => count + page.count, 0), sourceEventCount: job.through_version,
                sha256: await checkpointDigest(JSON.stringify(pages)) };
            this.storage.transactionSync(() => {
                this.assertWritable();
                this.query(`INSERT INTO log_storage (log_id, compacted_through, generation, checkpoint) VALUES (?, 0, 0, ?)
                    ON CONFLICT(log_id) DO UPDATE SET checkpoint = excluded.checkpoint`, job.log_id, JSON.stringify(manifest));
                this.query("UPDATE log_maintenance_jobs SET status = 'cleaning', updated_at = ? WHERE id = ?", new Date().toISOString(), job.id);
            });
            return;
        }
        const wanted = rows.map(row => row.version);
        const events = await this.readVersions(job.log_id, wanted);
        if (events.length !== wanted.length || events.some((event, index) => event.version !== wanted[index])) throw new Error('Snapshot source is missing retained events');
        const chunk: CheckpointChunk = { events: [], claims: [] };
        let bytes = 2;
        for (const event of events) {
            const size = new TextEncoder().encode(JSON.stringify(event)).byteLength + 1;
            if (chunk.events.length && bytes + size >= MAX_PAGE_BYTES) break;
            chunk.events.push(event); bytes += size;
        }
        const value = JSON.stringify(chunk);
        const key = `v1/${this.appId}/${job.log_id}/snapshots/${job.id}/${pages.length}.json`;
        pages.push({ key, sha256: await this.put(key, value), count: chunk.events.length, bytes: new TextEncoder().encode(value).byteLength });
        this.assertWritable();
        this.query('UPDATE log_maintenance_jobs SET version_cursor = ?, pages = ?, updated_at = ? WHERE id = ?',
            chunk.events[chunk.events.length - 1]!.version, JSON.stringify(pages), new Date().toISOString(), job.id);
    }

    private clean(job: JobRow): void {
        if (this.deleteWork(job.id)) {
            this.query('UPDATE log_maintenance_jobs SET updated_at = ? WHERE id = ?', new Date().toISOString(), job.id);
            return;
        }
        this.query("UPDATE log_maintenance_jobs SET status = 'complete', updated_at = ? WHERE id = ?", new Date().toISOString(), job.id);
    }

    /** R2 rejects an upload whose bytes do not match the digest, so no read-back is needed. */
    private async put(key: string, value: string): Promise<string> {
        const sha256 = await checkpointDigest(value);
        this.io.r2Writes++;
        this.io.r2WrittenBytes += new TextEncoder().encode(value).byteLength;
        await this.bucket!.put(key, value, { sha256, customMetadata: { sha256 }, httpMetadata: { contentType: 'application/json' } });
        return sha256;
    }

    private async archive(job: JobRow): Promise<void> {
        // Metadata stays as the compact identity/action registry. Only payloads
        // move, so historical boundaries and event/request uniqueness survive.
        const rows = this.query<{ version: number }>(`SELECT version FROM log_events WHERE log_id = ?
            AND version <= ? AND version > ? AND archive_key IS NULL ORDER BY version LIMIT ?`, job.log_id, job.through_version, job.cursor, PAGE);
        if (!rows.length) {
            this.storage.transactionSync(() => {
                this.assertWritable();
                this.query('UPDATE log_storage SET compacted_through = MAX(compacted_through, ?), generation = generation + 1 WHERE log_id = ?', job.through_version, job.log_id);
                this.query("UPDATE log_maintenance_jobs SET status = 'complete', cursor = ?, updated_at = ? WHERE id = ?", job.through_version, new Date().toISOString(), job.id);
            });
            return;
        }
        const first = rows[0]!.version;
        const events = await this.readEvents(job.log_id, first - 1, rows[rows.length - 1]!.version, PAGE);
        const value = JSON.stringify(events);
        const key = `v1/${this.appId}/${job.log_id}/archive/${job.id}/${first}.json`;
        const sha256 = await this.put(key, value);
        this.storage.transactionSync(() => {
            this.assertWritable();
            this.query(`INSERT OR IGNORE INTO log_archive_pages (log_id, first_version, last_version, object_key, sha256) VALUES (?, ?, ?, ?, ?)`,
                job.log_id, first, events[events.length - 1]!.version, key, sha256);
            this.query(`UPDATE log_events SET archive_key = ?, payload_bytes = COALESCE(payload_bytes, length(CAST(payload AS BLOB))), payload = CASE WHEN event_type IN
                ('EVENT_TOMBSTONED', 'WORKSPACE_RESTORED', 'EVENTS_EXCISED') THEN payload ELSE '{}' END
                WHERE log_id = ? AND version >= ? AND version <= ? AND archive_key IS NULL`, key, job.log_id, first, events[events.length - 1]!.version);
            this.query("UPDATE log_maintenance_jobs SET status = 'archiving', cursor = ?, updated_at = ? WHERE id = ?",
                events[events.length - 1]!.version, new Date().toISOString(), job.id);
        });
    }

    /** Replay directives up to the snapshot boundary, resolved once per job. */
    private selection(job: JobRow): (event: CheckpointEvent) => boolean {
        let markers: Marker[];
        if (job.markers) {
            markers = JSON.parse(job.markers) as Marker[];
        } else {
            markers = this.query<{ version: number; event_id: string; event_type: string; payload: string }>(`SELECT version, event_id, event_type, payload FROM log_events
                WHERE log_id = ? AND version <= ? AND event_type IN ('EVENT_TOMBSTONED', 'WORKSPACE_RESTORED', 'EVENTS_EXCISED') ORDER BY version DESC`,
                job.log_id, job.through_version).map(event => ({ id: event.event_id, type: event.event_type,
                version: event.version, payload: JSON.parse(event.payload) as Record<string, unknown> }));
            const encoded = JSON.stringify(markers);
            if (encoded.length < MAX_MARKER_BYTES) {
                this.assertWritable();
                this.query('UPDATE log_maintenance_jobs SET markers = ? WHERE id = ?', encoded, job.id);
            }
        }
        return checkpointSelection(markers, job.through_version);
    }
}

function day(): string { return new Date().toISOString().slice(0, 10); }
/** Start of the UTC day after `dayValue` (YYYY-MM-DD). */
function nextMidnight(dayValue: string): number { return Date.parse(`${dayValue}T00:00:00.000Z`) + 86_400_000; }
function archiveError(message: string): LedgerError { return new LedgerError(503, { error: 'Unavailable', code: 'archive_unavailable', message }); }
function publicJob(row: JobRow): MaintenanceJob {
    return { id: row.id, logId: row.log_id, kind: row.kind, throughVersion: row.through_version, status: row.status,
        cursor: row.cursor, error: row.error, updatedAt: row.updated_at, attempts: row.attempts, retryAt: row.retry_at,
        pauseReason: row.pause_reason, resumeAt: row.resume_at };
}
