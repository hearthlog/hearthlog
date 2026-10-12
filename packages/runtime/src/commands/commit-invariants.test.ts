import { afterEach, expect, it } from 'vitest';
import { createLocalDatabase } from '../testing/local-database.js';
import { commitLocalEventBatch, type ProjectEntity } from './local-commit.js';
import { createEntityProjector, PROJECTION_CONFIGS } from '../event/projection-builder.js';
import type { ExtendedAppEvent } from '../event/types.js';
const clients: ReturnType<typeof createLocalDatabase>[] = [];
afterEach(async () => { for (const c of clients.splice(0)) await c.database.destroy(); });
const context = { tenantId: 'person', logId: 'log', principalId: 'owner', ledgerOrigin: 'test' };
const projectEntity: ProjectEntity = async (id, tx, scope) => createEntityProjector(PROJECTION_CONFIGS.calendar_event)({ payload: { id: id.split(':')[1] } }, tx, id, scope);
function appointment(id: string, title = 'Dentist'): ExtendedAppEvent {
    return { id, type: 'CALENDAR_EVENT_ADDED', timestamp: 1, payload: { id: 'visit', title, eventDate: '2026-10-12', startTime: '', notes: '', pinned: false } };
}
function setup() { const c = createLocalDatabase(); clients.push(c); return c; }
it('uses durable sequence when local event IDs and timestamps disagree with edit order', async () => {
    const c = setup();
    for (const e of [appointment('z-first', 'First'), { ...appointment('a-second', 'Second'), type: 'CALENDAR_EVENT_UPDATED' } as ExtendedAppEvent]) {
        await commitLocalEventBatch({ database: c.database, context, events: [e], submissionId: e.id, projectEntity });
    }
    expect(c.sqlite.prepare('SELECT title FROM calendar_events').get()).toEqual({ title: 'Second' });
});
it('returns persisted event IDs on a repeated submission', async () => {
    const c = setup();
    const input = { database: c.database, context, submissionId: 'same-action', projectEntity };
    await commitLocalEventBatch({ ...input, events: [appointment('original')] });
    const retry = await commitLocalEventBatch({ ...input, events: [appointment('newly-generated')] });
    expect(retry.duplicate).toBe(true);
    expect(retry.eventIds).toEqual(['original']);
});
