import type { LogMaintenance } from '@hearthlog/contracts/history/checkpoint';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalDatabase } from '../testing/local-database.js';
import type { StoredEvent, AppendEventsRequest } from '../ledger/types.js';
import type { Database } from '../db/index.js';
import type { Kysely } from 'kysely';

const state = vi.hoisted(() => ({
    database: null as unknown as Kysely<Database>,
    events: [] as StoredEvent[],
    interleave: null as null | (() => Promise<void>),
    appendError: null as null | Error,
    /** Runs as a conflict is raised: the other device's edit lands first. */
    onConflict: null as null | (() => void),
    rebuilds: 0,
    maintenance: null as LogMaintenance | null,
    notifications: 0,
    realtimeEnabled: false,
    readCursors: [] as number[],
    sockets: [] as Array<{ logId: string; cursor: number; opens: number; handlers: Map<string, (...args: unknown[]) => void> }>,
    context: { tenantId: 'person', logId: 'personal', principalId: 'owner', ledgerOrigin: 'test' },
}));
vi.mock('../db/index.js', () => ({
    get db() { return state.database; },
    requireActiveContext: async () => state.context,
}));
vi.mock('$app/navigation', () => ({ invalidate: async () => {} }));
vi.mock('../runtime/page-data.svelte.js', () => ({ waitForPageUpdates: async () => {} }));
vi.mock('../runtime/read-coordinator.js', () => ({ activateCurrentReadTarget: async () => {} }));
vi.mock('./events.svelte.js', () => ({ notifyEventsChanged() { state.notifications++; } }));
vi.mock('../commands/index.js', () => ({ onLocalCommandCommitted() {} }));
vi.mock('../db/kv.js', () => ({ get: async () => null, del: async () => {} }));
vi.mock('./local-context.js', () => ({
    getActiveContext: async () => state.context,
    getLedgerCacheKey: async (key: string) => key,
}));
vi.mock('../event/dynamic-entities.js', () => ({}));
vi.mock('../event/rebuild.js', async () => ({
    // Membership reconciliation is the part of a rebuild these tests observe.
    async rebuildReadModel() {
        state.rebuilds += 1;
        const { reconcileRestoredEvents } = await import('../history/legacy-replay.js');
        await reconcileRestoredEvents(state.database, state.context);
    },
    versionTracker: {
        async updateVersionsFromEvents(events: StoredEvent[]) {
            const { EntityVersionTracker } = await import('../ledger/version-tracker.js');
            await new EntityVersionTracker(state.database).updateVersionsFromEvents(events);
        },
    },
}));
vi.mock('../ledger/version-tracker-singleton.js', () => ({
    versionTracker: {
        async getCurrentVersion(entityId: string) {
            const { EntityVersionTracker } = await import('../ledger/version-tracker.js');
            return new EntityVersionTracker(state.database).getCurrentVersion(entityId);
        },
        async updateVersionsFromEvents(events: StoredEvent[]) {
            const { EntityVersionTracker } = await import('../ledger/version-tracker.js');
            return new EntityVersionTracker(state.database).updateVersionsFromEvents(events);
        },
    },
}));
vi.mock('../event/index.js', async () => ({
    ...await import('../event/handlers.js'),
    rebuildReadModel: async () => (await import('../event/rebuild.js')).rebuildReadModel(),
}));
vi.mock('../ledger/index.js', async () => {
    const errors = await import('../ledger/errors.js');
    class TestLedgerClient {
        async getLogMaintenance() { return state.maintenance; }
        async getActionMetadataSupport() { return false; }
        async getWorkspaceRestoreSupport() { return false; }
        async getEventPage(_log: string, after: number) {
            state.readCursors.push(after);
            return state.events.filter(e => e.version > after).slice(0, 512);
        }
        createEventSocket(logId: string, cursor: number) {
            const recorded = { logId, cursor, opens: 0, handlers: new Map<string, (...args: unknown[]) => void>() };
            state.sockets.push(recorded);
            return {
                on(name: string, handler: (...args: unknown[]) => void) { recorded.handlers.set(name, handler); return this; },
                async open() { recorded.opens += 1; },
                isReady() { return false; },
                acknowledge() {},
                pause() {},
                close() {},
                resetAfterVersion(version: number) { recorded.cursor = version; },
            };
        }
        async appendEvents(_log: string, request: AppendEventsRequest) {
            const appendError = state.appendError;
            state.appendError = null;
            if (appendError) {
                state.onConflict?.();
                state.onConflict = null;
                throw appendError;
            }
            await state.interleave?.();
            state.interleave = null;
            const events: StoredEvent[] = [];
            for (const event of request.events) {
                const known = [...state.events, ...events].filter(stored => stored.entityId === event.entityId);
                events.push({ ...event, version: state.events.length + events.length + 1,
                    entityVersion: known.length === 0 ? 1 : Math.max(...known.map(stored => stored.entityVersion)) + 1,
                    timestamp: event.timestamp ?? 1,
                } as StoredEvent);
            }
            state.events.push(...events);
            return { newVersion: state.events.length, events };
        }
    }
    const transport = new TestLedgerClient();
    return { ...errors, loadLedgerConfig: () => ({ enableRealtime: state.realtimeEnabled }), getLedgerClient: () => transport };
});

const clients: ReturnType<typeof createLocalDatabase>[] = [];
afterEach(async () => { vi.clearAllTimers(); for (const client of clients.splice(0)) await client.database.destroy(); });
function client() { const c = createLocalDatabase(); clients.push(c); return c; }
function event(version: number): StoredEvent {
    return { id: `event-${version}`, type: 'CALENDAR_EVENT_ADDED', timestamp: version,
        entityId: `calendar_event:ce-${version}`, entityVersion: 1, version,
        payload: { id: `ce-${version}`, title: `Event ${version}`, eventDate: '2026-10-12', notes: String(version) } };
}

describe('real local persistence and sync convergence', () => {
    it('refreshes the current page when catch-up installs only a baseline with no suffix events', async () => {
        const c = client(); state.database = c.database; state.events = []; state.notifications = 0; state.readCursors = [];
        const baseline = await import('../history/baseline.js');
        const install = vi.spyOn(baseline, 'installBaseline').mockImplementation(async () => {
            await c.database.insertInto('log_sync_state').values({ tenant_id: 'person', log_id: 'personal',
                downloaded_head_version: 100, projected_head_version: 100, last_synced_at: null }).execute();
        });
        state.maintenance = { compactedThroughVersion: 100, storageGeneration: 1, job: null, available: true,
            checkpoint: { format: 1, id: 'checkpoint', appId: 'app', logId: 'personal', throughVersion: 100,
                createdAt: '2026-10-22T00:00:00Z', pages: [], eventCount: 0, sourceEventCount: 100, sha256: '' } };
        try {
            const { sync, syncStatus } = await import('./sync.svelte.js');
            syncStatus.isOnline = true;
            await sync();
            expect(install).toHaveBeenCalledOnce();
            expect(state.readCursors).toEqual([100]);
            expect(state.notifications).toBeGreaterThan(0);
            expect(syncStatus.hasError).toBe(false);
        } finally { state.maintenance = null; install.mockRestore(); }
    });

    it('retains complete action metadata across split pages and duplicate ingestion', async () => {
        const { handleIncomingStoredEvents } = await import('../event/handlers.js');
        const c = client(); state.database = c.database;
        const first = { ...event(1), action: { id: 'action', index: 0, size: 2 } };
        const last = { ...event(2), action: { id: 'action', index: 1, size: 2 } };
        await handleIncomingStoredEvents([first]);
        await handleIncomingStoredEvents([last]);
        await handleIncomingStoredEvents([event(1), event(2)]);
        expect(c.sqlite.prepare('SELECT action_id,action_index,action_size FROM raw_events ORDER BY log_version').all())
            .toEqual([{ action_id: 'action', action_index: 0, action_size: 2 },
                { action_id: 'action', action_index: 1, action_size: 2 }]);
    });
    it('does not skip B at 11 when A uploads 12 after downloading through 10', async () => {
        const { handleIncomingStoredEvents, projectEntityById } = await import('../event/handlers.js');
        const { commitLocalEventBatch } = await import('../commands/local-commit.js');
        const { sync, syncStatus } = await import('./sync.svelte.js');
        const a = client(), b = client();
        state.events = Array.from({ length: 10 }, (_, i) => event(i + 1));
        for (const c of [a, b]) { state.database = c.database; await handleIncomingStoredEvents([...state.events]); }
        state.database = a.database;
        await commitLocalEventBatch({ database: a.database, context: state.context,
            events: [event(12) as never], submissionId: 'a-upload', projectEntity: projectEntityById });
        state.interleave = async () => {
            state.events.push(event(11));
            state.database = b.database;
            await handleIncomingStoredEvents([event(11)]);
            state.database = a.database;
        };
        syncStatus.isOnline = true;
        await sync();
        await sync();
        expect(syncStatus.hasError).toBe(false);
        expect(a.sqlite.prepare('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({ n: 12 });
        expect(a.sqlite.prepare("SELECT notes FROM calendar_events WHERE id='ce-11'").get()).toEqual({ notes: '11' });
        expect(a.sqlite.prepare('SELECT downloaded_head_version FROM log_sync_state').get()).toEqual({ downloaded_head_version: 12 });
        state.database = b.database;
        await sync();
        expect(b.sqlite.prepare('SELECT id,notes FROM calendar_events ORDER BY id').all())
            .toEqual(a.sqlite.prepare('SELECT id,notes FROM calendar_events ORDER BY id').all());
    });
    it('parks an already-accepted upload without blocking later batches', async () => {
        const { projectEntityById } = await import('../event/handlers.js');
        const { commitLocalEventBatch } = await import('../commands/local-commit.js');
        const { LedgerServiceError } = await import('../ledger/errors.js');
        const { sync, syncStatus } = await import('./sync.svelte.js');
        const a = client(); state.database = a.database; state.events = [];
        await commitLocalEventBatch({ database: a.database, context: state.context,
            events: [event(1) as never], submissionId: 'already-accepted', projectEntity: projectEntityById });
        state.appendError = new LedgerServiceError('Conflict', 409, { code: 'event_already_accepted' },
            'event_already_accepted');
        syncStatus.isOnline = true;
        await sync();
        expect(a.sqlite.prepare('SELECT status, retry_count, last_error_code FROM outbox_operations').all())
            .toEqual([{ status: 'needs_attention', retry_count: 1, last_error_code: 'event_already_accepted' }]);
        await commitLocalEventBatch({ database: a.database, context: state.context,
            events: [event(2) as never], submissionId: 'later', projectEntity: projectEntityById });
        await sync();
        expect(state.events.map(stored => stored.id)).toEqual(['event-2']);
    });
    it('keeps the recorded author of an accepted event, including after a repeated delivery', async () => {
        const { handleIncomingStoredEvents } = await import('../event/handlers.js');
        const a = client(); state.database = a.database;
        await handleIncomingStoredEvents([{ ...event(1), actor: 'jan@example.com' }, event(2)]);
        await handleIncomingStoredEvents([{ ...event(1), timestamp: 999, payload: { id: 'ce-1', title: 'Changed delivery', notes: '999' } }]);
        expect(a.sqlite.prepare('SELECT actor FROM raw_events ORDER BY log_version').all())
            .toEqual([{ actor: 'jan@example.com' }, { actor: null }]);
        expect(a.sqlite.prepare("SELECT timestamp,payload FROM raw_events WHERE id='event-1'").get())
            .toEqual({ timestamp: 1, payload: JSON.stringify(event(1).payload) });
    });

    describe('when another device edited the same record', () => {
        /** This device has ce-1 at version 1 and a pending edit; the other device's edit lands as the append is rejected. */
        async function conflictWith(localPayload: Record<string, unknown>, remote: Partial<StoredEvent> & { payload?: Record<string, unknown> }) {
            const { handleIncomingStoredEvents, projectEntityById } = await import('../event/handlers.js');
            const { commitLocalEventBatch } = await import('../commands/local-commit.js');
            const { VersionConflictError } = await import('../ledger/errors.js');
            const { sync, syncStatus } = await import('./sync.svelte.js');
            const a = client(); state.database = a.database; state.events = [event(1)];
            await handleIncomingStoredEvents([event(1)]);
            await commitLocalEventBatch({ database: a.database, context: state.context,
                events: [{ id: 'local-edit', type: 'CALENDAR_EVENT_UPDATED', timestamp: 10, payload: { id: 'ce-1', ...localPayload } } as never],
                submissionId: 'local-edit', projectEntity: projectEntityById });
            const remoteEvent = { id: 'remote-edit', type: 'CALENDAR_EVENT_UPDATED', timestamp: 5, entityId: 'calendar_event:ce-1',
                entityVersion: 2, version: 2, payload: { id: 'ce-1' }, ...remote } as StoredEvent;
            state.onConflict = () => { state.events.push(remoteEvent); };
            state.appendError = new VersionConflictError('Version conflict', { code: 'entity_conflict', entityId: 'calendar_event:ce-1',
                currentEntityVersion: 2, currentLogVersion: 2 });
            syncStatus.isOnline = true;
            await sync();
            return { a, sync };
        }
        const row = (a: ReturnType<typeof client>) =>
            a.sqlite.prepare("SELECT title, notes FROM calendar_events WHERE id='ce-1'").get();
        const operations = (a: ReturnType<typeof client>) =>
            a.sqlite.prepare('SELECT status, last_error_code FROM outbox_operations ORDER BY created_at, rowid').all();

        it('merges edits to different fields and sends the batch again without asking', async () => {
            const { a } = await conflictWith({ title: 'Mine' }, { payload: { id: 'ce-1', notes: '20' } });
            expect(operations(a)).toEqual([
                { status: 'superseded', last_error_code: null },
                { status: 'synced', last_error_code: null },
            ]);
            expect(state.events.map(stored => stored.id)).toContain('local-edit');
            expect(row(a)).toEqual({ title: 'Mine', notes: '20' });
        });

        it('parks a clash on one field with both values and sends nothing', async () => {
            const { a } = await conflictWith({ notes: '50', title: 'Mine' }, { payload: { id: 'ce-1', notes: '20' } });
            const { getSyncIssues } = await import('./sync-issues.js');
            expect(operations(a)).toEqual([{ status: 'needs_attention', last_error_code: 'edit_conflict' }]);
            expect(state.events.map(stored => stored.id)).not.toContain('local-edit');
            const [issue] = await getSyncIssues({ database: a.database, context: state.context });
            expect(issue!.conflicts).toEqual([{ kind: 'field', entityId: 'calendar_event:ce-1', field: 'notes', mine: '50', theirs: '20' }]);
            expect(issue!.errorMessage).toBe('Notes: yours 50, theirs 20');
        });

        it('keeps my values when asked: the same event is sent again on top', async () => {
            const { a, sync } = await conflictWith({ notes: '50' }, { payload: { id: 'ce-1', notes: '20' } });
            const { getSyncIssues, rebaseSyncIssue } = await import('./sync-issues.js');
            const [issue] = await getSyncIssues({ database: a.database, context: state.context });
            await rebaseSyncIssue(issue!.operationId, { database: a.database, context: state.context });
            await sync();
            expect(state.events.filter(stored => stored.id === 'local-edit')).toHaveLength(1);
            expect(row(a)).toEqual({ title: 'Event 1', notes: '50' });
        });

        it('takes their values when asked, and still saves what did not clash as new events', async () => {
            const { a, sync } = await conflictWith({ notes: '50', title: 'Mine' }, { payload: { id: 'ce-1', notes: '20' } });
            const { getSyncIssues, useTheirsSyncIssue } = await import('./sync-issues.js');
            const [issue] = await getSyncIssues({ database: a.database, context: state.context });
            const resolved = await useTheirsSyncIssue(issue!.operationId, { database: a.database, context: state.context });
            expect(resolved.batchId).not.toBeNull();
            await sync();
            const sent = state.events.filter(stored => stored.type === 'CALENDAR_EVENT_UPDATED' && stored.id !== 'remote-edit');
            expect(sent).toHaveLength(1);
            expect(sent[0]!.id).not.toBe('local-edit');
            expect(sent[0]!.payload).toEqual({ id: 'ce-1', title: 'Mine' });
            expect(row(a)).toEqual({ title: 'Mine', notes: '20' });
            expect(a.sqlite.prepare("SELECT sync_state, projection_state FROM raw_events WHERE id='local-edit'").get())
                .toEqual({ sync_state: 'discarded', projection_state: 'excluded' });
        });

        it('leaves a record deleted when the other device deleted it and I choose theirs', async () => {
            const { a } = await conflictWith({ notes: '50' }, { type: 'CALENDAR_EVENT_REMOVED', payload: { id: 'ce-1' } });
            const { getSyncIssues, useTheirsSyncIssue } = await import('./sync-issues.js');
            const [issue] = await getSyncIssues({ database: a.database, context: state.context });
            expect(issue!.conflicts).toEqual([{ kind: 'edited_after_removed', entityId: 'calendar_event:ce-1' }]);
            expect(state.events.map(stored => stored.id)).not.toContain('local-edit');
            const resolved = await useTheirsSyncIssue(issue!.operationId, { database: a.database, context: state.context });
            expect(resolved.batchId).toBeNull();
            expect(row(a)).toBeUndefined();
        });
    });
    it('keeps a safe prefix through delayed and duplicate notifications', async () => {
        const { handleIncomingStoredEvents } = await import('../event/handlers.js');
        const a = client(); state.database = a.database;
        await handleIncomingStoredEvents([event(2)]);
        expect(a.sqlite.prepare('SELECT downloaded_head_version FROM log_sync_state').get())
            .toEqual({ downloaded_head_version: 0 });
        await handleIncomingStoredEvents([event(1), event(2)]);
        await handleIncomingStoredEvents([event(1), event(2)]);
        expect(a.sqlite.prepare('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({ n: 2 });
        expect(a.sqlite.prepare('SELECT downloaded_head_version,projected_head_version FROM log_sync_state').get())
            .toEqual({ downloaded_head_version: 2, projected_head_version: 2 });
    });

    it('does not accept an entire local batch when a download page includes only its first event', async () => {
        const { handleIncomingStoredEvents, projectEntityById } = await import('../event/handlers.js');
        const { commitLocalEventBatch } = await import('../commands/local-commit.js');
        const a = client(); state.database = a.database;
        const batch = await commitLocalEventBatch({ database: a.database, context: state.context,
            events: [event(1), event(2)] as never[], submissionId: 'two-events', projectEntity: projectEntityById });
        await handleIncomingStoredEvents([event(1)]);
        expect(a.sqlite.prepare('SELECT status FROM local_batches WHERE id=?').get(batch.batchId)).toEqual({ status: 'pending' });
        await handleIncomingStoredEvents([event(2)]);
        expect(a.sqlite.prepare('SELECT status FROM local_batches WHERE id=?').get(batch.batchId)).toEqual({ status: 'synced' });
    });
    it('preserves pending overlays, batch metadata, retry bodies, and other scopes across a large page', async () => {
        const { handleIncomingStoredEvents, projectEntityById } = await import('../event/handlers.js');
        const { commitLocalEventBatch } = await import('../commands/local-commit.js');
        const { getNextPendingBatch, persistOperation, prepareAppendRequest } = await import('./outbox.js');
        const a = client(); state.database = a.database;
        await handleIncomingStoredEvents([event(600)]);
        const pending = { ...event(601), id: 'pending-edit', type: 'CALENDAR_EVENT_UPDATED',
            payload: { id: 'ce-501', notes: '999' } };
        const local = await commitLocalEventBatch({ database: a.database, context: state.context,
            events: [event(501), pending] as never[], submissionId: 'large-page', projectEntity: projectEntityById });
        const pendingBatch = (await getNextPendingBatch())!;
        const operation = await persistOperation(pendingBatch.id,
            prepareAppendRequest(pendingBatch.events, new Map(), 'large-page-request'));
        const retryBody = a.sqlite.prepare('SELECT request_body FROM outbox_operations WHERE id=?').get(operation.id);
        a.sqlite.prepare("UPDATE local_batches SET created_at='original-date',replacement_for='original-batch' WHERE id=?").run(local.batchId);
        a.sqlite.exec(`
            INSERT INTO calendar_events VALUES ('other','personal','ce-501','Other','2026-10-12','','77',0,'original','original');
            INSERT INTO entity_versions VALUES ('other','personal','calendar_event:ce-501',9,99,1);
            INSERT INTO local_batches (id,tenant_id,log_id) VALUES ('other-batch','other','personal');
            INSERT INTO raw_events
                (id,tenant_id,log_id,local_batch_id,local_sequence,type,timestamp,payload,entity_id,sync_state,projection_state)
            VALUES ('event-501','other','personal','other-batch',1,'CALENDAR_EVENT_ADDED',1,
                '{"id":"ce-501","title":"Other","eventDate":"2026-10-12","notes":"77"}','calendar_event:ce-501','pending','effective');
        `);
        const page = Array.from({ length: 512 }, (_, i) => event(i + 1));
        await handleIncomingStoredEvents(page);
        await handleIncomingStoredEvents([...page]);

        expect(a.sqlite.prepare("SELECT COUNT(*) AS n FROM raw_events WHERE tenant_id='person'").get()).toEqual({ n: 514 });
        expect(a.sqlite.prepare('SELECT status,created_at,replacement_for FROM local_batches WHERE id=?').get(local.batchId))
            .toEqual({ status: 'pending', created_at: 'original-date', replacement_for: 'original-batch' });
        expect(a.sqlite.prepare("SELECT notes FROM calendar_events WHERE tenant_id='person' AND id='ce-501'").get()).toEqual({ notes: '999' });
        expect(a.sqlite.prepare("SELECT notes FROM calendar_events WHERE tenant_id='person' AND id='ce-600'").get()).toEqual({ notes: '600' });
        expect(a.sqlite.prepare('SELECT request_body FROM outbox_operations WHERE id=?').get(operation.id)).toEqual(retryBody);
        expect(a.sqlite.prepare("SELECT notes FROM calendar_events WHERE tenant_id='other'").get()).toEqual({ notes: '77' });
        expect(a.sqlite.prepare("SELECT current_version,log_version FROM entity_versions WHERE tenant_id='other'").get())
            .toEqual({ current_version: 9, log_version: 99 });
        expect(a.sqlite.prepare("SELECT log_version,sync_state FROM raw_events WHERE tenant_id='other'").get())
            .toEqual({ log_version: null, sync_state: 'pending' });
        expect(a.sqlite.prepare("SELECT status FROM local_batches WHERE id='other-batch'").get()).toEqual({ status: 'pending' });
        expect(a.sqlite.prepare('SELECT downloaded_head_version FROM log_sync_state').get()).toEqual({ downloaded_head_version: 512 });
    });
    it('keeps the highest entity version after a delayed older notification', async () => {
        const { handleIncomingStoredEvents } = await import('../event/handlers.js');
        const a = client(); state.database = a.database;
        const first = event(1);
        const second = { ...first, id: 'updated', type: 'CALENDAR_EVENT_UPDATED', version: 2, entityVersion: 2,
            payload: { id: 'ce-1', notes: '20' } };
        await handleIncomingStoredEvents([first, second]);
        await handleIncomingStoredEvents([first]);
        expect(a.sqlite.prepare('SELECT current_version FROM entity_versions').get()).toEqual({ current_version: 2 });
        expect(a.sqlite.prepare('SELECT notes FROM calendar_events').get()).toEqual({ notes: '20' });
    });
    it('rolls back ordinary ingestion when projection fails, then retries safely', async () => {
        const { handleIncomingStoredEvents } = await import('../event/handlers.js');
        const a = client(); state.database = a.database;
        const page = Array.from({ length: 201 }, (_, i) => event(i + 1));
        a.sqlite.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON calendar_events WHEN NEW.id='ce-101' BEGIN SELECT RAISE(ABORT, 'interrupted'); END;");
        await expect(handleIncomingStoredEvents([...page])).rejects.toThrow('interrupted');
        expect(a.sqlite.prepare('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({ n: 0 });
        expect(a.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_events').get()).toEqual({ n: 0 });
        expect(a.sqlite.prepare('SELECT COUNT(*) AS n FROM local_batches').get()).toEqual({ n: 0 });
        expect(a.sqlite.prepare('SELECT COUNT(*) AS n FROM entity_versions').get()).toEqual({ n: 0 });
        expect(a.sqlite.prepare('SELECT COUNT(*) AS n FROM log_sync_state').get()).toEqual({ n: 0 });
        a.sqlite.exec('DROP TRIGGER fail_projection');
        await handleIncomingStoredEvents([...page]);
        expect(a.sqlite.prepare('SELECT downloaded_head_version FROM log_sync_state').get()).toEqual({ downloaded_head_version: 201 });
    });

    it('projects ordinary tombstones in order across ingestion chunks', async () => {
        const { handleIncomingStoredEvents } = await import('../event/handlers.js');
        const a = client(); state.database = a.database;
        const updates = Array.from({ length: 45 }, (_, i) => ({ ...event(i + 2), type: 'CALENDAR_EVENT_UPDATED',
            entityId: 'calendar_event:ce-1', entityVersion: i + 2, payload: { id: 'ce-1', notes: String(i + 2) } }));
        const tombstone = { ...event(47), id: 'tombstone', type: 'EVENT_TOMBSTONED',
            entityId: 'tombstone:last-update', payload: { eventId: 'event-46' } };
        await handleIncomingStoredEvents([event(1), ...updates, tombstone, event(48)]);
        expect(a.sqlite.prepare("SELECT notes FROM calendar_events WHERE id='ce-1'").get()).toEqual({ notes: '45' });
        expect(a.sqlite.prepare("SELECT is_tombstoned FROM raw_events WHERE id='event-46'").get()).toEqual({ is_tombstoned: 1 });
        expect(a.sqlite.prepare("SELECT notes FROM calendar_events WHERE id='ce-48'").get()).toEqual({ notes: '48' });
        expect(a.sqlite.prepare("SELECT current_version FROM entity_versions WHERE entity_id='calendar_event:ce-1'").get())
            .toEqual({ current_version: 46 });
        await handleIncomingStoredEvents([updates[0]!]);
        expect(a.sqlite.prepare("SELECT current_version FROM entity_versions WHERE entity_id='calendar_event:ce-1'").get())
            .toEqual({ current_version: 46 });
    });


    it('keeps retrying while Ledger is unreachable and parks only a permanent answer', async () => {
        const { projectEntityById } = await import('../event/handlers.js');
        const { commitLocalEventBatch } = await import('../commands/local-commit.js');
        const { LedgerServiceError } = await import('../ledger/errors.js');
        const { getReadyOperation, markOperationFailed } = await import('./outbox.js');
        const { sync, syncStatus, getSyncPhase } = await import('./sync.svelte.js');
        const a = client(); state.database = a.database; state.events = [];
        await commitLocalEventBatch({ database: a.database, context: state.context,
            events: [event(1) as never], submissionId: 'unreachable', projectEntity: projectEntityById });
        state.appendError = new LedgerServiceError('Unavailable', 503, undefined, 'ledger_unavailable');
        syncStatus.isOnline = true;
        await sync();
        expect(getSyncPhase()).toBe('waiting');
        const pending = a.sqlite.prepare("SELECT id FROM outbox_operations WHERE status='failed'").get() as { id: string };
        a.sqlite.prepare('UPDATE outbox_operations SET retry_count = 40, next_retry_at = NULL WHERE id = ?').run(pending.id);
        const operation = (await getReadyOperation())!;
        await markOperationFailed(operation, 'ledger_unavailable', 'Unavailable', false, 0, () => 1);
        expect(a.sqlite.prepare('SELECT status, retry_count, next_retry_at FROM outbox_operations').get())
            .toEqual({ status: 'failed', retry_count: 41, next_retry_at: new Date(60_000).toISOString() });

        a.sqlite.prepare('UPDATE outbox_operations SET next_retry_at = NULL').run();
        state.appendError = new LedgerServiceError('Too large', 413, undefined, 'request_too_large');
        await sync();
        expect(a.sqlite.prepare('SELECT status, last_error_code FROM outbox_operations').get())
            .toEqual({ status: 'needs_attention', last_error_code: 'request_too_large' });
        expect(getSyncPhase()).toBe('blocked');
    });

    it('projects ordinary events after a restore without a full rebuild', async () => {
        const { handleIncomingStoredEvents } = await import('../event/handlers.js');
        const a = client(); state.database = a.database; state.rebuilds = 0;
        const updated = { ...event(1), id: 'updated', type: 'CALENDAR_EVENT_UPDATED', version: 2, entityVersion: 2,
            payload: { id: 'ce-1', notes: '20' } };
        const restore = { ...event(3), id: 'restore', type: 'WORKSPACE_RESTORED', entityId: 'workspace:restore',
            payload: { targetVersion: 1 } };
        await handleIncomingStoredEvents([event(1), updated, restore]);
        expect(state.rebuilds).toBe(1);
        expect(a.sqlite.prepare("SELECT projection_state FROM raw_events WHERE id='updated'").get())
            .toEqual({ projection_state: 'restored_out' });

        await handleIncomingStoredEvents([event(4)]);
        await handleIncomingStoredEvents([updated]);
        expect(state.rebuilds).toBe(1);
        expect(a.sqlite.prepare("SELECT id FROM calendar_events WHERE id='ce-4'").get()).toEqual({ id: 'ce-4' });
        expect(a.sqlite.prepare("SELECT projection_state FROM raw_events WHERE id='updated'").get())
            .toEqual({ projection_state: 'restored_out' });
    });
    it('rebuilds when a removal is undone or a download gap holds a restore back', async () => {
        const { handleIncomingStoredEvents } = await import('../event/handlers.js');
        const a = client(); state.database = a.database; state.rebuilds = 0;
        const excision = { ...event(2), id: 'excise', type: 'EVENTS_EXCISED', entityId: 'workspace:excise',
            payload: { eventIds: ['event-1'] } };
        await handleIncomingStoredEvents([event(1), excision]);
        expect(a.sqlite.prepare("SELECT projection_state FROM raw_events WHERE id='event-1'").get())
            .toEqual({ projection_state: 'restored_out' });
        const undo = { ...event(3), id: 'undo', type: 'EVENT_TOMBSTONED', entityId: 'workspace:undo',
            payload: { eventId: 'excise' } };
        await handleIncomingStoredEvents([undo]);
        expect(state.rebuilds).toBe(2);
        expect(a.sqlite.prepare("SELECT projection_state FROM raw_events WHERE id='event-1'").get())
            .toEqual({ projection_state: 'effective' });

        const restore = { ...event(5), id: 'restore', type: 'WORKSPACE_RESTORED', entityId: 'workspace:restore',
            payload: { targetVersion: 3 } };
        await handleIncomingStoredEvents([restore]);
        expect(a.sqlite.prepare("SELECT projection_state FROM raw_events WHERE id='restore'").get())
            .toEqual({ projection_state: 'restored_out' });
        await handleIncomingStoredEvents([event(4)]);
        expect(state.rebuilds).toBe(4);
        expect(a.sqlite.prepare("SELECT projection_state FROM raw_events WHERE id='restore'").get())
            .toEqual({ projection_state: 'effective' });
    });

    describe('reusing a completed HTTP catch-up for realtime', () => {
        afterEach(async () => {
            const { stopRealtime } = await import('./sync.svelte.js');
            await stopRealtime();
            state.realtimeEnabled = false;
        });

        it('opens from the applied cursor without another download and retains connection-gap events', async () => {
            const { runSyncCoordinator, syncStatus } = await import('./sync.svelte.js');
            const a = client(); state.database = a.database;
            state.events = [event(1)]; state.readCursors = []; state.sockets = []; state.realtimeEnabled = true;
            syncStatus.isOnline = true;
            await runSyncCoordinator('startup');
            await expect.poll(() => state.sockets.length).toBe(1);
            const socket = state.sockets[0];
            expect(socket.cursor).toBe(1);
            expect(state.readCursors).toEqual([0]);
            state.events.push(event(2));
            socket.handlers.get('event')!(event(2));
            socket.handlers.get('ready')!(2);
            await expect.poll(() => a.sqlite.prepare('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({ n: 2 });
            expect(a.sqlite.prepare("SELECT notes FROM calendar_events WHERE id='ce-2'").get()).toEqual({ notes: '2' });
            expect(state.readCursors).toEqual([0]);
            await new Promise((resolve) => setTimeout(resolve, 200));
        });

        it('returns to paginated HTTP recovery when the socket gap is too large', async () => {
            const { runSyncCoordinator, syncStatus } = await import('./sync.svelte.js');
            const a = client(); state.database = a.database;
            state.events = []; state.readCursors = []; state.sockets = []; state.realtimeEnabled = true;
            syncStatus.isOnline = true;
            await runSyncCoordinator('startup');
            await expect.poll(() => state.sockets.length).toBe(1);
            const socket = state.sockets[0];
            state.events = Array.from({ length: 513 }, (_, i) => event(i + 1));
            socket.handlers.get('resync_required')!(513, 'gap_too_large');
            await expect.poll(() => socket.cursor).toBe(513);
            expect(socket.opens).toBe(2);
            expect(state.readCursors).toEqual([0, 0, 512]);
            expect(a.sqlite.prepare('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({ n: 513 });
            expect(a.sqlite.prepare("SELECT notes FROM calendar_events WHERE id='ce-513'").get()).toEqual({ notes: '513' });
        });
    });

});
