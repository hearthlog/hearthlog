import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkpointDigest, type CheckpointChunk, type CheckpointManifest } from '@hearthlog/contracts/history/checkpoint';
import { createLocalDatabase } from '../testing/local-database.js';
const state = vi.hoisted(() => ({ database: null as unknown as ReturnType<typeof createLocalDatabase>['database'],
    chunk: null as unknown as CheckpointChunk, history: [] as CheckpointChunk['events'], corrupt: false }));
const context = { tenantId: 'person', logId: 'personal', principalId: 'owner', ledgerOrigin: 'test' };
vi.mock('../db/index.js', () => ({ get db() { return state.database; }, requireActiveContext: async () => ({ tenantId: 'person', logId: 'personal', principalId: 'owner', ledgerOrigin: 'test' }) }));
vi.mock('../db/kv.js', () => ({ get() {}, set() {} }));
vi.mock('../ledger/version-tracker-singleton.js', () => ({ versionTracker: { async rebuildVersionCache() {}, async updateVersionsFromEvents() {} } }));
vi.mock('../ledger/client.js', () => ({ getLedgerClient: () => ({ getSession: async () => ({ appId: 'app' }),
    getEventPage: async (_logId: string, after: number) => state.history.filter(event => event.version > after),
    getCheckpointChunk: async () => state.corrupt ? { events: [], claims: [] } : structuredClone(state.chunk) }) }));
vi.mock('../store/tab-coordination.js', () => ({ SCHEMA_LOCK_NAME: 'schema', withTabLock: async (_key: string, task: () => Promise<void>) => task(), postTabChange() {} }));
vi.mock('@hearthlog/contracts/tenant/config', () => ({ tenant: { dynamicEntities: false, approvedEntities: { entityNames: new Set(['calendar_event']) } } }));
import { installBaseline, loadArchivedHistory } from './baseline.js';

afterEach(async () => { await state.database.destroy(); state.corrupt = false; state.history = []; });
async function fixture() {
    const c = createLocalDatabase(); state.database = c.database;
    c.sqlite.exec(`CREATE TABLE entity_type_definitions (tenant_id TEXT, log_id TEXT, id TEXT);
        INSERT INTO raw_events (id, tenant_id, log_id, local_batch_id, local_sequence, type, timestamp, payload, entity_id, entity_version, log_version, sync_state)
        VALUES ('pending','person','personal','save',99,'CALENDAR_EVENT_UPDATED',9000,'{"id":"one","title":"My pending edit"}','calendar_event:one',NULL,NULL,'pending');
        INSERT INTO outbox_operations (id,request_id,tenant_id,log_id,batch_id,request_body,request_hash)
        VALUES ('operation','original-request','person','personal','save','immutable original request','hash');`);
    state.chunk = { events: [
        { id: 'accepted-1', type: 'CALENDAR_EVENT_ADDED', entityId: 'calendar_event:one', entityVersion: 1, version: 1, timestamp: 1000,
            payload: { id: 'one', title: 'Initial', eventDate: '2026-10-22', notes: 'Old note' } },
        { id: 'accepted-5', type: 'CALENDAR_EVENT_UPDATED', entityId: 'calendar_event:one', entityVersion: 5, version: 5, timestamp: 5000,
            payload: { id: 'one', title: 'Accepted title', notes: null } },
    ], claims: [{ entityId: 'calendar_event:one', currentVersion: 5, logVersion: 5 }] };
    const encoded = JSON.stringify(state.chunk);
    const pages = [{ key: 'page', sha256: await checkpointDigest(encoded), count: 2, bytes: encoded.length }];
    const manifest: CheckpointManifest = { format: 1, appId: 'app', logId: 'personal', id: 'checkpoint', throughVersion: 5,
        createdAt: '2026-10-22T00:00:00Z', pages, eventCount: 2, sourceEventCount: 5, sha256: await checkpointDigest(JSON.stringify(pages)) };
    return { ...c, manifest };
}

describe('atomic checkpoint installation', () => {
    it('clears the baseline when explicitly replacing the selected local log', async () => {
        const c = await fixture();
        await installBaseline(c.manifest, context);
        const { replaceAllStoredEvents } = await import('../event/handlers.js');
        await replaceAllStoredEvents([{ ...state.chunk.events[0]!, payload: { id: 'one', title: 'Replacement', eventDate: '2026-10-22' } }]);
        expect(c.sqlite.prepare('SELECT title FROM calendar_events').get()).toEqual({ title: 'Replacement' });
        expect(c.sqlite.prepare('SELECT COUNT(*) AS n FROM log_baselines').get()).toEqual({ n: 0 });
        expect(c.sqlite.prepare('SELECT COUNT(*) AS n FROM checkpoint_claims').get()).toEqual({ n: 0 });
    });
    it('recovers an archived restore and reconciles a lost acknowledgement without rewriting the original local payload', async () => {
        const c = await fixture();
        state.chunk.events = [state.chunk.events[0]!];
        c.manifest.pages[0]!.count = 1;
        c.manifest.pages[0]!.sha256 = await checkpointDigest(JSON.stringify(state.chunk));
        c.manifest.eventCount = 1;
        c.manifest.sha256 = await checkpointDigest(JSON.stringify(c.manifest.pages));
        await installBaseline(c.manifest, context);
        await expect(loadArchivedHistory()).rejects.toThrow('incomplete');
        expect(c.sqlite.prepare('SELECT through_version FROM log_baselines').get()).toEqual({ through_version: 5 });
        state.history = [state.chunk.events[0]!, ...[2, 3, 4].map(version => ({
            id: version === 2 ? 'pending' : `accepted-${version}`, type: 'CALENDAR_EVENT_UPDATED',
            entityId: 'calendar_event:one', entityVersion: version, version, timestamp: version * 1000,
            payload: { id: 'one', title: version === 2 ? 'My pending edit' : `Later ${version}` },
        })), { id: 'restore', type: 'WORKSPACE_RESTORED', entityId: 'workspace:personal', entityVersion: 1,
            version: 5, timestamp: 5000, payload: { targetVersion: 1 } }];
        await loadArchivedHistory();
        expect(c.sqlite.prepare('SELECT title FROM calendar_events').get()).toEqual({ title: 'Initial' });
        expect(c.sqlite.prepare("SELECT sync_state, projection_state, log_version, payload FROM raw_events WHERE id = 'pending'").get())
            .toEqual({ sync_state: 'synced', projection_state: 'restored_out', log_version: 2, payload: '{"id":"one","title":"My pending edit"}' });
        expect(c.sqlite.prepare('SELECT COUNT(*) AS n FROM log_baselines').get()).toEqual({ n: 0 });
        expect(c.sqlite.prepare('SELECT request_body FROM outbox_operations').get()).toEqual({ request_body: 'immutable original request' });
    });
    it('acknowledges an old accepted request without reviving a change excluded by a later restore', async () => {
        const c = await fixture();
        state.chunk.events = [state.chunk.events[0]!];
        c.manifest.pages[0]!.count = 1;
        c.manifest.pages[0]!.sha256 = await checkpointDigest(JSON.stringify(state.chunk));
        c.manifest.eventCount = 1;
        c.manifest.sha256 = await checkpointDigest(JSON.stringify(c.manifest.pages));
        await installBaseline(c.manifest, context);
        const { handleIncomingStoredEvents } = await import('../event/handlers.js');
        await handleIncomingStoredEvents([{ id: 'pending', type: 'CALENDAR_EVENT_UPDATED', entityId: 'calendar_event:one',
            entityVersion: 2, version: 2, timestamp: 2000, payload: { id: 'one', title: 'My pending edit' } }]);
        expect(c.sqlite.prepare('SELECT title FROM calendar_events').get()).toEqual({ title: 'Initial' });
        expect(c.sqlite.prepare("SELECT sync_state, projection_state FROM raw_events WHERE id = 'pending'").get())
            .toEqual({ sync_state: 'synced', projection_state: 'baseline_covered' });
        expect(c.sqlite.prepare('SELECT request_body FROM outbox_operations').get()).toEqual({ request_body: 'immutable original request' });
    });
    it('publishes prefix coverage and projections while preserving pending events and immutable retries', async () => {
        const c = await fixture();
        await installBaseline(c.manifest, context);
        expect(c.sqlite.prepare('SELECT title, notes FROM calendar_events').get()).toEqual({ title: 'My pending edit', notes: '' });
        expect(c.sqlite.prepare('SELECT current_version FROM entity_versions').get()).toEqual({ current_version: 5 });
        expect(c.sqlite.prepare('SELECT downloaded_head_version FROM log_sync_state').get()).toEqual({ downloaded_head_version: 5 });
        expect(c.sqlite.prepare("SELECT sync_state FROM raw_events WHERE id='pending'").get()).toEqual({ sync_state: 'pending' });
        expect(c.sqlite.prepare('SELECT request_id, request_body FROM outbox_operations').get()).toEqual({ request_id: 'original-request', request_body: 'immutable original request' });
        const { getAcceptedEntityEdits } = await import('../store/outbox.js');
        expect(await getAcceptedEntityEdits('calendar_event:one', 1)).toEqual([
            { type: 'CALENDAR_EVENT_UPDATED', payload: { id: 'one', title: 'Accepted title', notes: null } },
        ]);
    });
    it('retains the old publication on corrupt downloads and failed projection, then permits retry', async () => {
        const c = await fixture(); state.corrupt = true;
        await expect(installBaseline(c.manifest, context)).rejects.toThrow('verification');
        expect(c.sqlite.prepare('SELECT COUNT(*) AS n FROM log_baselines').get()).toEqual({ n: 0 });
        state.corrupt = false;
        c.sqlite.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON calendar_events BEGIN SELECT RAISE(ABORT,'interrupted'); END");
        await expect(installBaseline(c.manifest, context)).rejects.toThrow('interrupted');
        expect(c.sqlite.prepare('SELECT COUNT(*) AS n FROM log_sync_state').get()).toEqual({ n: 0 });
        expect(c.sqlite.prepare('SELECT COUNT(*) AS n FROM checkpoint_events').get()).toEqual({ n: 0 });
        c.sqlite.exec('DROP TRIGGER fail_projection');
        await installBaseline(c.manifest, context);
        expect(c.sqlite.prepare('SELECT through_version FROM log_baselines').get()).toEqual({ through_version: 5 });
    });
});
