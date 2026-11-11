import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import { createLocalDatabase } from '../testing/local-database.js';

/**
 * A new fork can copy its shared history from its source on this device. The copy must hold exactly what downloading
 * the fork would, and must refuse whenever that is not certain. Pruning settled bookkeeping must never touch work
 * that has not synced.
 */

const state = vi.hoisted(() => ({
    database: null as unknown as Kysely<Database>,
    context: { tenantId: 'tenant', logId: 'fork', principalId: 'p', ledgerOrigin: 'o' },
    logs: [] as Array<{ id: string; sourceLogId?: string | null; sourceVersion?: number | null }>,
}));
vi.mock('../db/index.js', () => ({
    get db() { return state.database; },
    requireActiveContext: async () => state.context,
}));
vi.mock('./logs.svelte.js', () => ({ logs: { get value() { return state.logs; } } }));
vi.mock('../event/handlers.js', () => ({ SERVER_BATCH_ID: 'server' }));

const { seedForkFromSource } = await import('./fork-seed.js');
const { pruneSettledLocalState, SETTLED_OPERATION_RETENTION_MS } = await import('./outbox.js');

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

function setup() {
    const { database, sqlite } = createLocalDatabase(['calendar_events']);
    closers.push(() => database.destroy());
    state.database = database;
    const insert = sqlite.prepare(`INSERT INTO raw_events (id, tenant_id, log_id, local_batch_id, local_sequence, action_id,
        action_index, action_size, actor, type, timestamp, payload, entity_id, entity_version, log_version, sync_state)
        VALUES (?, 'tenant', ?, 'server', ?, ?, 0, 1, 'a@example.com', ?, ?, ?, ?, ?, ?, ?)`);
    const add = (log: string, version: number | null, type = 'CALENDAR_EVENT_ADDED', id = `e${version}`) =>
        insert.run(id, log, version ?? 999, version ? id : null, type, 1_000 + (version ?? 999),
            JSON.stringify({ id: `r${version}`, title: `T${version}`, eventDate: '2026-10-12' }), `calendar_event:r${version}`,
            version ? 1 : null, version, version ? 'synced' : 'pending');
    const progress = (log: string, head: number) => sqlite.prepare(`INSERT OR REPLACE INTO log_sync_state
        (tenant_id, log_id, downloaded_head_version, projected_head_version) VALUES ('tenant', ?, ?, ?)`).run(log, head, head);
    const rows = (log: string) => sqlite.prepare(`SELECT id, local_batch_id, local_sequence, action_id, action_index, action_size,
        actor, type, timestamp, payload, entity_id, entity_version, log_version, sync_state, projection_state, is_tombstoned
        FROM raw_events WHERE log_id = ? ORDER BY log_version`).all(log);
    return { sqlite, add, progress, rows };
}

describe('fork seeding', () => {
    it('copies the source through the fork point exactly as a download stores it', async () => {
        const { add, progress, rows, sqlite } = setup();
        for (let version = 1; version <= 6; version++) add('source', version);
        add('source', null, 'CALENDAR_EVENT_UPDATED', 'waiting'); // the source's own unsynced edit stays there
        progress('source', 6);
        state.logs = [{ id: 'fork', sourceLogId: 'source', sourceVersion: 4 }];

        expect(await seedForkFromSource(state.context)).toBe(true);
        // What downloading versions 1-4 into the fork would store (see storeIncomingBatch).
        expect(rows('fork')).toEqual((rows('source') as Array<Record<string, unknown>>)
            .filter((row) => row.log_version !== null && Number(row.log_version) <= 4));
        expect(sqlite.prepare("SELECT downloaded_head_version AS head FROM log_sync_state WHERE log_id = 'fork'").get()).toEqual({ head: 4 });
        // A fork that already holds events is left alone.
        expect(await seedForkFromSource(state.context)).toBe(false);
    });

    it('downloads instead when the copy is not certain', async () => {
        const gap = setup();
        for (const version of [1, 2, 4]) gap.add('source', version); // version 3 missing locally
        gap.progress('source', 4);
        state.logs = [{ id: 'fork', sourceLogId: 'source', sourceVersion: 4 }];
        expect(await seedForkFromSource(state.context)).toBe(false);
        expect(gap.rows('fork')).toEqual([]);

        const behind = setup();
        for (let version = 1; version <= 3; version++) behind.add('source', version);
        behind.progress('source', 3);
        expect(await seedForkFromSource(state.context)).toBe(false);

        const undo = setup();
        for (let version = 1; version <= 4; version++) undo.add('source', version, version === 2 ? 'EVENT_TOMBSTONED' : 'CALENDAR_EVENT_ADDED');
        undo.progress('source', 4);
        expect(await seedForkFromSource(state.context)).toBe(false);
        expect(undo.rows('fork')).toEqual([]);
    });
});

describe('pruning settled bookkeeping', () => {
    it('removes old synced operations and legacy batch rows, never unsynced or blocked work', async () => {
        const { sqlite } = setup();
        state.context = { ...state.context, logId: 'log' };
        const now = Date.now();
        const old = new Date(now - SETTLED_OPERATION_RETENTION_MS - 60_000).toISOString();
        const recent = new Date(now - 60_000).toISOString();
        const operation = sqlite.prepare(`INSERT INTO outbox_operations (id, request_id, tenant_id, log_id, batch_id, request_body,
            request_hash, status, updated_at) VALUES (?, ?, 'tenant', 'log', ?, '{}', 'h', ?, ?)`);
        const batch = sqlite.prepare(`INSERT INTO local_batches (id, tenant_id, log_id, status) VALUES (?, 'tenant', 'log', ?)`);
        const item = sqlite.prepare(`INSERT INTO outbox_operation_items (operation_id, event_id, ordinal) VALUES (?, ?, 0)`);
        for (const [id, status, updated, batchStatus] of [
            ['old-synced', 'synced', old, 'synced'],
            ['recent-synced', 'synced', recent, 'synced'],
            ['old-pending', 'pending', old, 'pending'],
            ['old-blocked', 'needs_attention', old, 'pending'],
            ['old-superseded', 'superseded', old, 'conflicted'],
        ] as const) {
            batch.run(`batch-${id}`, batchStatus);
            operation.run(id, `request-${id}`, `batch-${id}`, status, updated);
            item.run(id, `event-${id}`);
        }
        batch.run('server:tenant:log:e1', 'synced');
        batch.run('server:tenant:log:e2', 'synced');

        await pruneSettledLocalState(now);

        expect(sqlite.prepare('SELECT id FROM outbox_operations ORDER BY id').all().map((row) => row.id))
            .toEqual(['old-blocked', 'old-pending', 'recent-synced']);
        expect(sqlite.prepare('SELECT operation_id FROM outbox_operation_items ORDER BY operation_id').all().map((row) => row.operation_id))
            .toEqual(['old-blocked', 'old-pending', 'recent-synced']);
        // The superseded operation's batch is still being rebased, so its row stays.
        expect(sqlite.prepare('SELECT id FROM local_batches ORDER BY id').all().map((row) => row.id))
            .toEqual(['batch-old-blocked', 'batch-old-pending', 'batch-old-superseded', 'batch-recent-synced']);
    });
});
