import { EVENT_SCHEMAS } from '#generated/event-schemas';
import { checkpointDigest, checkpointSelection, checkpointStateVersions, foldCheckpointEvent, newCheckpointEntityState,
    type CheckpointChunk, type CheckpointEntityState, type CheckpointEvent, type CheckpointManifest, type CheckpointPage,
    type CheckpointSelector, type LogMaintenance, type MaintenanceJob, type CompactionPreview } from '@hearthlog/contracts/history/checkpoint';
import { LedgerError, validationError } from './errors';

/** Events archived per compaction step. */
const PAGE = 128;
/** Source events per read while folding (also bounded by the byte window of the reader). */
const FOLD_EVENTS = 512;
/** Retained events read per query while writing snapshot pages. */
const READ_VERSIONS = 256;
const CLAIMS_PER_PAGE = 4096;
/** Wall time one snapshot step keeps working before it saves its state. */
const STEP_MS = 4000;
const MAX_WORK_BYTES = 64_000_000;
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
type Phase = 'seed' | 'fold' | 'pages';
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
            const start = kind === 'snapshot' ? this.initialBuild(logId, log.version) : { phase: null, cursor: 0 };
            this.query(`INSERT INTO log_maintenance_jobs (id, log_id, kind, through_version, status, cursor, entity_cursor, pages, updated_at, day, writes, phase)
                VALUES (?, ?, ?, ?, ?, ?, '', '[]', ?, ?, 0, ?)`, id, logId, kind,
                kind === 'compact' ? checkpoint!.throughVersion : log.version, kind === 'compact' ? 'archiving' : 'building', start.cursor,
                new Date().toISOString(), day(), start.phase);
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
            else if (job.status === 'cleaning') await this.clean(job);
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
        if (!job.phase || !['seed', 'fold', 'pages'].includes(job.phase)) return this.reset(job);
        if (job.phase === 'pages') return this.pages(job);
        return this.fold(job);
    }

    /** Where a new snapshot starts: from the previous one's retained facts when no later replay directive can reach behind it. */
    private initialBuild(logId: string, through: number): { phase: Phase; cursor: number } {
        const checkpoint = this.state(logId).checkpoint;
        if (checkpoint && checkpoint.throughVersion > 0 && checkpoint.throughVersion <= through
            && !this.query(`SELECT 1 FROM log_events WHERE log_id = ? AND version > ? AND event_type IN ('EVENT_TOMBSTONED', 'WORKSPACE_RESTORED', 'EVENTS_EXCISED') LIMIT 1`,
                logId, checkpoint.throughVersion).length) {
            return { phase: 'seed', cursor: checkpoint.throughVersion };
        }
        return { phase: 'fold', cursor: 0 };
    }

    /** Discard partial work (including work files of earlier builders) and start the build again. */
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
        const reference = workReference(job.entity_cursor);
        if (reference) await this.deleteObject(reference.key);
        const start = this.initialBuild(job.log_id, job.through_version);
        this.assertWritable();
        this.query(`UPDATE log_maintenance_jobs SET phase = ?, cursor = ?, version_cursor = 0, entity_cursor = '', pages = '[]', markers = NULL, updated_at = ?
            WHERE id = ?`, start.phase, start.cursor, new Date().toISOString(), job.id);
    }

    /**
     * The whole job's replay slots live in one private object, read and written once per step,
     * so SQL writes grow with steps rather than with entities. null when it was lost (the build restarts).
     */
    private async loadState(job: JobRow): Promise<Map<string, WorkState> | null> {
        const reference = workReference(job.entity_cursor);
        if (!reference) return new Map();
        const object = await this.getObject(reference.key);
        const value = object ? await object.text() : null;
        if (value === null || await checkpointDigest(value) !== reference.sha256) {
            console.warn('ledger_maintenance_state_lost', { appId: this.appId, logId: job.log_id, jobId: job.id });
            this.assertWritable();
            this.query("UPDATE log_maintenance_jobs SET entity_cursor = '', phase = NULL WHERE id = ?", job.id);
            return null;
        }
        return new Map(Object.entries(JSON.parse(value) as Record<string, WorkState>));
    }

    private async saveState(job: JobRow, states: Map<string, WorkState>, next: { phase: Phase; cursor: number; versionCursor: number }): Promise<void> {
        let value = '{';
        let first = true;
        for (const [entityId, state] of states) {
            const encoded = JSON.stringify(state);
            if (encoded.length > MAX_STATE_BYTES) throw new Error('Entity replay state exceeds the snapshot work budget');
            value += `${first ? '' : ','}${JSON.stringify(entityId)}:${encoded}`;
            first = false;
        }
        value += '}';
        if (value.length > MAX_WORK_BYTES) throw new Error('Snapshot work state exceeds the snapshot work budget');
        const key = `v1/${this.appId}/${job.log_id}/work/${job.id}/${next.phase}-${next.cursor}-${next.versionCursor}.json`;
        const sha256 = await this.put(key, value);
        this.assertWritable();
        this.query('UPDATE log_maintenance_jobs SET phase = ?, cursor = ?, version_cursor = ?, entity_cursor = ?, updated_at = ? WHERE id = ?',
            next.phase, next.cursor, next.versionCursor, `${key}#${sha256}`, new Date().toISOString(), job.id);
        const previous = workReference(job.entity_cursor);
        if (previous && previous.key !== key) await this.deleteObject(previous.key);
    }

    /** Seed from the previous snapshot, then fold source events, for as long as one step allows. */
    private async fold(job: JobRow): Promise<void> {
        const states = await this.loadState(job);
        if (!states) return;
        const started = Date.now();
        const work = (entityId: string): WorkState => {
            let state = states.get(entityId);
            if (!state) { state = { s: newCheckpointEntityState(), c: { currentVersion: 0, logVersion: 0 } }; states.set(entityId, state); }
            return state;
        };
        let phase = job.phase as Phase, cursor = job.cursor, versionCursor = job.version_cursor;
        if (phase === 'seed') {
            const layout = this.layout(job.log_id);
            const checkpoint = layout.checkpoint ? JSON.parse(layout.checkpoint) as CheckpointManifest : null;
            if (!checkpoint || checkpoint.throughVersion !== job.cursor) throw new Error('The previous snapshot changed while seeding');
            while (versionCursor < checkpoint.pages.length && Date.now() - started < STEP_MS) {
                const chunk = await this.chunk(job.log_id, versionCursor);
                for (const event of [...chunk.events].sort((a, b) => a.version - b.version)) foldCheckpointEvent(work(event.entityId).s, event, SELECTORS, standardTypes);
                for (const claim of chunk.claims) work(claim.entityId).c = { currentVersion: claim.currentVersion, logVersion: claim.logVersion };
                versionCursor++;
            }
            if (versionCursor >= checkpoint.pages.length) { phase = 'fold'; versionCursor = 0; }
        }
        if (phase === 'fold') {
            const selected = cursor < job.through_version ? this.selection(job) : () => true;
            while (cursor < job.through_version && Date.now() - started < STEP_MS) {
                const events = await this.readEvents(job.log_id, cursor, job.through_version, FOLD_EVENTS);
                if (!events.length || events[0]!.version !== cursor + 1 || events[events.length - 1]!.version - events[0]!.version !== events.length - 1) {
                    throw new Error('Snapshot source contains a gap');
                }
                for (const event of events) {
                    const state = work(event.entityId);
                    if (selected(event) && !directives.includes(event.type)) foldCheckpointEvent(state.s, event, SELECTORS, standardTypes);
                    state.c = { currentVersion: event.entityVersion, logVersion: event.version };
                }
                cursor = events[events.length - 1]!.version;
            }
            if (cursor >= job.through_version) { phase = 'pages'; versionCursor = 0; }
        }
        await this.saveState(job, states, { phase, cursor, versionCursor });
    }

    /** Write claim pages and the retained source events in version order, then publish the manifest. */
    private async pages(job: JobRow): Promise<void> {
        const states = await this.loadState(job);
        if (!states) return;
        const started = Date.now();
        const pages = JSON.parse(job.pages) as CheckpointPage[];
        const pageKey = () => `v1/${this.appId}/${job.log_id}/snapshots/${job.id}/${pages.length}.json`;
        const write = async (chunk: CheckpointChunk) => {
            const value = JSON.stringify(chunk);
            const key = pageKey();
            pages.push({ key, sha256: await this.put(key, value), count: chunk.events.length, bytes: new TextEncoder().encode(value).byteLength });
        };
        if (!pages.length && job.version_cursor === 0) {
            const claims = [...states].filter(([, state]) => state.c.logVersion > 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
                .map(([entityId, state]) => ({ entityId, currentVersion: state.c.currentVersion, logVersion: state.c.logVersion }));
            for (let offset = 0; offset < claims.length; offset += CLAIMS_PER_PAGE) await write({ events: [], claims: claims.slice(offset, offset + CLAIMS_PER_PAGE) });
        }
        const retained = new Set<number>();
        for (const state of states.values()) for (const version of checkpointStateVersions(state.s)) retained.add(version);
        const versions = [...retained].filter(version => version > job.version_cursor).sort((a, b) => a - b);
        let versionCursor = job.version_cursor;
        let chunk: CheckpointChunk = { events: [], claims: [] };
        let bytes = 2;
        let offset = 0;
        while (offset < versions.length && Date.now() - started < STEP_MS) {
            const wanted = versions.slice(offset, offset + READ_VERSIONS);
            const events = await this.readVersions(job.log_id, wanted);
            if (events.length !== wanted.length || events.some((event, index) => event.version !== wanted[index])) throw new Error('Snapshot source is missing retained events');
            for (const event of events) {
                const size = new TextEncoder().encode(JSON.stringify(event)).byteLength + 1;
                if (chunk.events.length && bytes + size >= MAX_PAGE_BYTES) {
                    await write(chunk);
                    versionCursor = chunk.events[chunk.events.length - 1]!.version;
                    chunk = { events: [], claims: [] }; bytes = 2;
                }
                chunk.events.push(event); bytes += size;
            }
            offset += wanted.length;
        }
        if (chunk.events.length) {
            await write(chunk);
            versionCursor = chunk.events[chunk.events.length - 1]!.version;
        }
        this.assertWritable();
        if (offset < versions.length) {
            this.query('UPDATE log_maintenance_jobs SET version_cursor = ?, pages = ?, updated_at = ? WHERE id = ?',
                versionCursor, JSON.stringify(pages), new Date().toISOString(), job.id);
            return;
        }
        const manifest: CheckpointManifest = { format: 1, appId: this.appId, logId: job.log_id, id: job.id,
            throughVersion: job.through_version, createdAt: new Date().toISOString(), pages,
            eventCount: pages.reduce((count, page) => count + page.count, 0), sourceEventCount: job.through_version,
            sha256: await checkpointDigest(JSON.stringify(pages)) };
        this.storage.transactionSync(() => {
            this.assertWritable();
            this.query(`INSERT INTO log_storage (log_id, compacted_through, generation, checkpoint) VALUES (?, 0, 0, ?)
                ON CONFLICT(log_id) DO UPDATE SET checkpoint = excluded.checkpoint`, job.log_id, JSON.stringify(manifest));
            this.query("UPDATE log_maintenance_jobs SET status = 'cleaning', version_cursor = ?, pages = ?, updated_at = ? WHERE id = ?",
                versionCursor, JSON.stringify(pages), new Date().toISOString(), job.id);
        });
    }

    private async clean(job: JobRow): Promise<void> {
        const reference = workReference(job.entity_cursor);
        if (reference) await this.deleteObject(reference.key);
        this.assertWritable();
        this.query("UPDATE log_maintenance_jobs SET status = 'complete', entity_cursor = '', updated_at = ? WHERE id = ?", new Date().toISOString(), job.id);
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
            this.query('UPDATE log_storage SET archived_through = MAX(archived_through, ?) WHERE log_id = ?', events[events.length - 1]!.version, job.log_id);
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

/** The job's current work-state object, stored as `key#sha256` in the job row. */
function workReference(value: string): { key: string; sha256: string } | null {
    const separator = value.lastIndexOf('#');
    return separator > 0 ? { key: value.slice(0, separator), sha256: value.slice(separator + 1) } : null;
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
