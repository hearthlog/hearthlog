import { afterEach, expect, it, vi } from 'vitest';
import { createLocalDatabase } from '../testing/local-database.js';
import type { AppendEventsRequest } from '../ledger/types.js';

const state = vi.hoisted(() => ({ database: null as unknown as ReturnType<typeof createLocalDatabase>['database'] }));
const scope = { tenantId: 'person', logId: 'personal' };
vi.mock('../db/index.js', () => ({ get db() { return state.database; }, requireActiveContext: async () => ({ tenantId: 'person', logId: 'personal' }) }));
const clients: ReturnType<typeof createLocalDatabase>[] = [];
afterEach(async () => { for (const c of clients.splice(0)) await c.database.destroy(); });
function fixture() {
    const c = createLocalDatabase(); clients.push(c); state.database = c.database;
    c.sqlite.exec("INSERT INTO log_sync_state VALUES ('person','personal',2,2,NULL)");
    return c;
}
function request(): AppendEventsRequest {
    return { requestId: crypto.randomUUID(), actionId: crypto.randomUUID(), expectedLogVersion: 2,
        events: [{ id: crypto.randomUUID(), type: 'WORKSPACE_RESTORED', entityId: 'workspace:state', timestamp: 1, payload: { targetVersion: 1 } }] };
}
it('recovers the exact durable restore request without optimistically applying it', async () => {
    const c = fixture();
    const { persistOperation, getReadyOperation, markOperationSyncing } = await import('./outbox.js');
    const body = request();
    const saved = await persistOperation('restore', body, 0, scope);
    await markOperationSyncing(saved.id);
    expect((await getReadyOperation())?.request).toEqual(body);
    expect(c.sqlite.prepare('SELECT projection_state,log_version FROM raw_events').get())
        .toEqual({ projection_state: 'pending_restore', log_version: null });
    expect(c.sqlite.prepare('SELECT COUNT(*) AS n FROM outbox_operation_items').get()).toEqual({ n: 1 });
});
it('rejects a different scope or changed head without leaving a partial request', async () => {
    const c = fixture();
    const { persistOperation } = await import('./outbox.js');
    await expect(persistOperation('restore', request(), 0, { ...scope, tenantId: 'other' })).rejects.toThrow('selected log changed');
    await expect(persistOperation('restore', { ...request(), expectedLogVersion: 1 }, 0, scope)).rejects.toThrow('log changed');
    for (const table of ['raw_events', 'local_batches', 'outbox_operations', 'outbox_operation_items']) {
        expect(c.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
});
