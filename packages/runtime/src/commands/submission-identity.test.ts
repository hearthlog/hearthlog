import { afterEach, expect, it, vi } from 'vitest';
import { createLocalDatabase } from '../testing/local-database.js';
import type { AddCalendarEventEvent } from '../event/types.js';

const state = vi.hoisted(() => ({ database: null as unknown as ReturnType<typeof createLocalDatabase>['database'] }));
vi.mock('../db/index.js', () => ({ get db() { return state.database; }, requireActiveContext: async () => ({ tenantId: 'person', logId: 'personal' }) }));
vi.mock('../event/handlers.js', async () => {
    const { createEntityProjector, PROJECTION_CONFIGS } = await import('../event/projection-builder.js');
    const project = createEntityProjector(PROJECTION_CONFIGS.calendar_event);
    return { cacheEventId() {}, applyMetaEvents() {}, projectEntityById: async (entityId: string, database: Parameters<typeof project>[1], context: Parameters<typeof project>[3]) => {
        await project({ payload: { id: entityId.slice('calendar_event:'.length) } }, database, entityId, context);
    } };
});
const clients: ReturnType<typeof createLocalDatabase>[] = [];
afterEach(async () => { for (const c of clients.splice(0)) await c.database.destroy(); });
function event(id: string): AddCalendarEventEvent {
    return { id: `event-${id}`, type: 'CALENDAR_EVENT_ADDED', timestamp: 1, payload: { id, title: 'Dentist', eventDate: '2026-10-12', startTime: '', notes: '', pinned: false } };
}
it('preserves two concurrent intentional creates with identical values', async () => {
    const c = createLocalDatabase(); clients.push(c); state.database = c.database;
    const { executeLocalCommand } = await import('./index.js');
    const results = await Promise.all([executeLocalCommand(event('a')), executeLocalCommand(event('b'))]);
    expect(results[0].batchId).not.toBe(results[1].batchId);
    expect(c.sqlite.prepare('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({ n: 2 });
});
it('coalesces retries only when they carry the same submission identity', async () => {
    const c = createLocalDatabase(); clients.push(c); state.database = c.database;
    const { executeLocalCommand } = await import('./index.js');
    // A retry repeats the content; standard commands mint a new event id each call.
    const retry = { ...event('a'), id: 'event-retry' };
    const results = await Promise.all([executeLocalCommand(event('a'), { submissionId: 'save' }), executeLocalCommand(retry, { submissionId: 'save' })]);
    expect(results[0].eventIds).toEqual(results[1].eventIds);
    const later = await executeLocalCommand({ ...event('a'), id: 'event-later' }, { submissionId: 'save' });
    expect(later).toMatchObject({ duplicate: true, eventIds: results[0].eventIds });
    expect(c.sqlite.prepare('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({ n: 1 });
});
it('refuses a reused submission identity with different values', async () => {
    const c = createLocalDatabase(); clients.push(c); state.database = c.database;
    const { executeLocalCommand, SubmissionMismatchError } = await import('./index.js');
    const edited = { ...event('a'), payload: { ...event('a').payload, title: 'Dentist, moved' } };
    const [first, concurrent] = await Promise.allSettled([
        executeLocalCommand(event('a'), { submissionId: 'save' }),
        executeLocalCommand(edited, { submissionId: 'save' }),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(concurrent).toMatchObject({ status: 'rejected', reason: expect.any(SubmissionMismatchError) });
    await expect(executeLocalCommand(edited, { submissionId: 'save' })).rejects.toBeInstanceOf(SubmissionMismatchError);
    expect(c.sqlite.prepare('SELECT title FROM calendar_events').get()).toEqual({ title: 'Dentist' });
    expect(c.sqlite.prepare('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({ n: 1 });
});
