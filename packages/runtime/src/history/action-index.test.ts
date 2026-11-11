import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createLocalDatabase } from '../testing/local-database.js';
import { ensureHistoryIndex, indexActions, indexBatchActions, markHistoryIndexStale, type SqlRunner } from './action-index.js';

/**
 * The action index is maintained incrementally as events change, and rebuilt whole when it is stale. Both must give
 * the same rows, or history would read differently depending on how a device got its data.
 */

const SCOPE = { tenantId: 'tenant', logId: 'log' };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

function setup() {
    const { database, sqlite } = createLocalDatabase(['calendar_events']);
    closers.push(() => database.destroy());
    const run: SqlRunner = (query) => query.execute(database);
    let sequence = 0;
    const insert = sqlite.prepare(`INSERT INTO raw_events (id, tenant_id, log_id, local_batch_id, local_sequence, action_id,
        action_index, action_size, type, timestamp, payload, entity_id, entity_version, log_version, sync_state)
        VALUES (?, 'tenant', 'log', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    function event(input: { id: string; batch: string; type: string; record: string; payload: Record<string, unknown>;
        action?: [string, number, number]; version?: number; entityVersion?: number }) {
        sequence += 1;
        const [actionId, index, size] = input.action ?? [null, null, null];
        insert.run(input.id, input.batch, sequence, actionId, index, size, input.type, 1_700_000_000_000 + sequence * 60_000,
            JSON.stringify({ id: input.record, ...input.payload }), `calendar_event:${input.record}`,
            input.entityVersion ?? null, input.version ?? null, input.version ? 'synced' : 'pending');
        return input.id;
    }
    const snapshot = async () => (await sql<Record<string, unknown>>`SELECT * FROM history_actions
        WHERE tenant_id = 'tenant' AND log_id = 'log' ORDER BY group_id`.execute(database)).rows;
    return { database, sqlite, run, event, snapshot };
}

describe('history action index', () => {
    it('maintained step by step equals a full rebuild', async () => {
        const { sqlite, run, event, snapshot } = setup();
        await ensureHistoryIndex(run, SCOPE); // An empty log is built; maintenance indexes from here on.

        // A downloaded three-event action arrives split across two pages.
        const first = [
            event({ id: 'e1', batch: 'server', type: 'CALENDAR_EVENT_ADDED', record: 'r1', payload: { title: 'Dentist' }, action: ['e1', 0, 3], version: 1, entityVersion: 1 }),
            event({ id: 'e2', batch: 'server', type: 'CALENDAR_EVENT_UPDATED', record: 'r1', payload: { notes: 'a' }, action: ['e1', 1, 3], version: 2, entityVersion: 2 }),
        ];
        await indexActions(run, SCOPE, first);
        expect((await snapshot()).map((row) => row.complete)).toEqual([0]);
        await indexActions(run, SCOPE, [event({ id: 'e3', batch: 'server', type: 'CALENDAR_EVENT_UPDATED', record: 'r1', payload: { notes: 'b' }, action: ['e1', 2, 3], version: 3, entityVersion: 3 })]);
        expect((await snapshot()).map((row) => row.complete)).toEqual([1]);

        // Two local saves wait; the first is accepted as one action, the other is rejected.
        const saved = [
            event({ id: 'p1', batch: 'b1', type: 'CALENDAR_EVENT_UPDATED', record: 'r1', payload: { title: 'Dentist at 9' } }),
            event({ id: 'p2', batch: 'b1', type: 'CALENDAR_EVENT_ADDED', record: 'r2', payload: { title: 'Gym' } }),
        ];
        await indexActions(run, SCOPE, saved);
        const rejected = event({ id: 'p3', batch: 'b2', type: 'CALENDAR_EVENT_ADDED', record: 'r3', payload: { title: 'Bad' } });
        await indexActions(run, SCOPE, [rejected]);
        expect((await snapshot()).filter((row) => row.pending === 1)).toHaveLength(3);

        sqlite.exec(`UPDATE raw_events SET action_id = 'p1', action_index = CASE id WHEN 'p1' THEN 0 ELSE 1 END, action_size = 2,
            log_version = CASE id WHEN 'p1' THEN 4 ELSE 5 END, entity_version = CASE id WHEN 'p1' THEN 4 ELSE 1 END,
            sync_state = 'synced' WHERE id IN ('p1', 'p2')`);
        await indexActions(run, SCOPE, saved);
        sqlite.exec(`UPDATE raw_events SET sync_state = 'rejected', projection_state = 'excluded', rejection_code = 'invalid'
            WHERE local_batch_id = 'b2'`);
        await indexBatchActions(run, SCOPE, 'b2');

        // A later rename does not rename what earlier actions were called.
        await indexActions(run, SCOPE, [event({ id: 'e6', batch: 'server', type: 'CALENDAR_EVENT_UPDATED', record: 'r2', payload: { title: 'Gym class' }, action: ['e6', 0, 1], version: 6, entityVersion: 2 })]);

        const maintained = await snapshot();
        expect(maintained.map((row) => [row.group_id, row.label, row.event_count, row.pending, row.complete, row.settled_attention]))
            .toEqual([
                ['e1', 'Edited Dentist', 3, 0, 1, 0],
                ['e6', 'Edited Gym class', 1, 0, 1, 0],
                ['p1', 'Calendar action', 2, 0, 1, 0],
                ['p3', 'Added Bad', 1, 1, 0, 1],
            ].map(([group, ...rest]) => [group, ...rest]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

        // Indexing again changes nothing, and a rebuild from scratch reads the same.
        await indexActions(run, SCOPE, ['e1', 'e2', 'e3', 'p1', 'p2', 'p3', 'e6']);
        expect(await snapshot()).toEqual(maintained);
        await markHistoryIndexStale(run, SCOPE);
        expect(await snapshot()).toEqual([]);
        await ensureHistoryIndex(run, SCOPE);
        expect(await snapshot()).toEqual(maintained);
    });

    it('defers to the next build while a log is not built yet', async () => {
        const { run, event, snapshot } = setup();
        await indexActions(run, SCOPE, [event({ id: 'e1', batch: 'server', type: 'CALENDAR_EVENT_ADDED', record: 'r1', payload: { title: 'Dentist' }, action: ['e1', 0, 1], version: 1, entityVersion: 1 })]);
        expect(await snapshot()).toEqual([]);
        await ensureHistoryIndex(run, SCOPE);
        expect((await snapshot()).map((row) => row.label)).toEqual(['Added Dentist']);
    });
});
