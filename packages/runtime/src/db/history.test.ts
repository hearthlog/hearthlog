import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';
import { createReadModelSession, type ReadModelDatabase } from './read-session.js';
import { createHistoryRepository } from './history.js';
import { HISTORY_INDEX_DDL } from './history-index-schema.js';
import { indexActions } from '../history/action-index.js';

/**
 * The history list names every action after the latest title of its record. That lookup must stay proportional to
 * the log, not to the log squared: the Undo bar asks for it after every save, and the browser database runs one
 * query at a time, so a slow label blocks the save, the page refresh and the upload behind it.
 */

const SCOPE = { tenantId: 'tenant', logId: 'log' };
const databases: Array<Kysely<ReadModelDatabase>> = [];

afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

function wrap(statement: StatementSync, query: string) {
    return {
        reader: /^\s*(?:PRAGMA|SELECT|WITH|EXPLAIN)\b/i.test(query),
        all: (parameters: ReadonlyArray<unknown>) => statement.all(...parameters as SQLInputValue[]),
        run: (parameters: ReadonlyArray<unknown>) => statement.run(...parameters as SQLInputValue[]),
        iterate: (parameters: ReadonlyArray<unknown>) => statement.iterate(...parameters as SQLInputValue[]),
    };
}

interface Seed {
    records: number;
    updatesPerRecord: number;
    /** Every n-th record is saved as one multi-event action (an import) instead of single events. */
    importEvery: number;
}

function fixture(seed: Seed) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
        CREATE TABLE raw_events (
            id TEXT NOT NULL, tenant_id TEXT NOT NULL, log_id TEXT NOT NULL, local_batch_id TEXT NOT NULL,
            local_sequence INTEGER NOT NULL DEFAULT 0, action_id TEXT, action_index INTEGER, action_size INTEGER,
            actor TEXT, type TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL, entity_id TEXT,
            entity_version INTEGER, log_version INTEGER, sync_state TEXT NOT NULL DEFAULT 'pending',
            projection_state TEXT NOT NULL DEFAULT 'effective', rejection_code TEXT, rejection_detail TEXT,
            is_tombstoned INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (tenant_id, log_id, id)
        );
        CREATE INDEX idx_raw_events_scope_order ON raw_events (tenant_id, log_id, log_version, local_sequence);
        CREATE INDEX idx_raw_events_entity_id ON raw_events (entity_id);
        -- Mirrors the app's startup DDL (db/index.ts): without it a record's events cost a scan of the whole log.
        CREATE INDEX idx_raw_events_scope_entity ON raw_events (tenant_id, log_id, entity_id, log_version);
        CREATE TABLE outbox_operations (
            id TEXT PRIMARY KEY, request_id TEXT NOT NULL, tenant_id TEXT NOT NULL, log_id TEXT NOT NULL,
            batch_id TEXT NOT NULL, request_body TEXT NOT NULL, request_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', last_error_message TEXT, updated_at TEXT
        );
        CREATE TABLE outbox_operation_items (
            operation_id TEXT NOT NULL, event_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
            PRIMARY KEY (operation_id, ordinal)
        );
    `);
    for (const ddl of HISTORY_INDEX_DDL) sqlite.exec(ddl);
    const insert = sqlite.prepare(`INSERT INTO raw_events
        (id, tenant_id, log_id, local_batch_id, local_sequence, action_id, action_index, action_size, type, timestamp,
         payload, entity_id, entity_version, log_version, sync_state)
        VALUES (?, ?, ?, 'batch', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`);
    let version = 0;
    sqlite.exec('BEGIN');
    for (let record = 0; record < seed.records; record++) {
        const id = `00000000-0000-4000-8000-${String(record).padStart(12, '0')}`;
        const entityId = `calendar_event:${id}`;
        const events = [
            { type: 'CALENDAR_EVENT_ADDED', payload: { id, title: `Dentist ${record}`, eventDate: '2026-10-12' } },
            ...Array.from({ length: seed.updatesPerRecord }, (_, n) => ({
                type: 'CALENDAR_EVENT_UPDATED', payload: { id, notes: `note ${n}` },
            })),
        ];
        const grouped = record % seed.importEvery === 0;
        events.forEach((event, index) => {
            version++;
            const action = grouped ? [`action-${record}`, index, events.length] : [null, null, null];
            insert.run(`event-${version}`, SCOPE.tenantId, SCOPE.logId, version, ...action, event.type,
                1_700_000_000_000 + version * 1000, JSON.stringify(event.payload), entityId, index + 1, version);
        });
    }
    sqlite.exec('COMMIT');
    const db = new Kysely<ReadModelDatabase>({
        dialect: new SqliteDialect({ database: {
            close: () => sqlite.close(),
            prepare: (query) => wrap(sqlite.prepare(query), query),
        } }),
    });
    databases.push(db);
    const session = createReadModelSession(db, { schema: 'main', scope: SCOPE, view: { effectiveNow: '2026-10-25T12:00:00.000Z' } });
    return { history: createHistoryRepository(session), events: version, sqlite, db };
}

describe('history list', () => {
    it('names the latest action after its record and lists newest first', async () => {
        const { history } = fixture({ records: 40, updatesPerRecord: 2, importEvery: 5 });
        const rows = await history.list({ limit: 60 });
        const actions = rows.filter((row) => row.kind === 'action');
        // The newest record's last edit is a single event; the import before it covers three events of one record.
        expect(actions[0]).toMatchObject({ label: 'Edited Dentist 39' });
        const imported = actions.find((row) => row.eventCount === 3 && row.label.includes('Dentist 35'));
        expect(imported?.label).toBe('Edited Dentist 35');
    });

    it('labels a log of thousands of events in well under a second', async () => {
        const { history, events } = fixture({ records: 1300, updatesPerRecord: 4, importEvery: 5 });
        expect(events).toBe(6500);
        // Building the action index happens once per log (in the background after sync); it stays linear in the
        // log. The bound is loose so a busy machine does not fail it; quadratic work would take minutes.
        const building = performance.now();
        await history.newest();
        expect(performance.now() - building).toBeLessThan(10_000);
        const started = performance.now();
        const [latest] = await history.list({ limit: 1 });
        const elapsed = performance.now() - started;
        expect(latest).toMatchObject({ kind: 'action', label: 'Edited Dentist 1299' });
        expect(elapsed).toBeLessThan(1000);
    }, 120_000);

    it('names a save from its own events, whatever the size of the log', async () => {
        const { history, sqlite } = fixture({ records: 1300, updatesPerRecord: 4, importEvery: 5 });
        const ids = sqlite.prepare("SELECT id FROM raw_events WHERE entity_id = ? ORDER BY log_version")
            .all('calendar_event:00000000-0000-4000-8000-000000000700').map((row) => String(row.id));
        // In the app the action index is already built when a save names itself (in the background after sync).
        await history.newest();
        const started = performance.now();
        const rows = await history.list({ limit: 1, eventIds: ids });
        const elapsed = performance.now() - started;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'action', label: 'Edited Dentist 700' });
        expect(elapsed).toBeLessThan(250);
        // The same action reads the same in the full list.
        const all = await history.list({ limit: 10_000 });
        const same = all.find((row) => row.kind === 'action' && row.id === (rows[0] as { id: string }).id);
        expect(same).toMatchObject({ label: 'Edited Dentist 700' });
    }, 120_000);

    it('reads the newest time and the map points without scanning the log per event', async () => {
        const { history } = fixture({ records: 1300, updatesPerRecord: 4, importEvery: 5 });
        await history.latest(); // builds the action index, timed in the test above
        const started = performance.now();
        const newest = await history.newest();
        const points = await history.points(0, Date.now());
        expect(newest).not.toBeNull();
        expect(points.length).toBeGreaterThan(0);
        expect(performance.now() - started).toBeLessThan(2000);
    }, 120_000);
});

describe('history timeline', () => {
    // Record 0 is one imported action; every later record is added, then edited three times in a row (a burst).
    const seed = { records: 30, updatesPerRecord: 3, importEvery: 1000 };

    it('pages bursts as one row each, in order, and lists a burst\'s actions on demand', async () => {
        const { history } = fixture(seed);
        const rows = [];
        let next = null;
        do {
            const page = await history.timeline({ limit: 20, before: next });
            rows.push(...page.rows);
            next = page.next;
        } while (next);
        expect(rows).toHaveLength(1 + 29 * 2);
        expect(rows.reduce((sum, row) => sum + row.runCount, 0)).toBe(1 + 29 * 4);
        expect(rows[0]).toMatchObject({ label: 'Edited Dentist 29', runCount: 3 });
        expect(rows[1]).toMatchObject({ label: 'Added Dentist 29', runCount: 1 });
        expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);

        const first = await history.members({ pending: rows[0].pending, run: rows[0].runStart }, { limit: 2 });
        expect(first.rows.map((row) => row.id)[0]).toBe(rows[0].id);
        expect(first.next).not.toBeNull();
        const rest = await history.members({ pending: rows[0].pending, run: rows[0].runStart }, { limit: 2, beforePosition: first.next });
        expect([...first.rows, ...rest.rows].map((row) => row.version)).toEqual([120, 119, 118]);
        expect(rest.next).toBeNull();

        const through = await history.timeline({ through: { pending: rows[30].pending, run: rows[30].runStart } });
        expect(through.rows.map((row) => row.id)).toEqual(rows.slice(0, 31).map((row) => row.id));
        expect(await history.locate(first.rows[1].id)).toMatchObject({ runStart: rows[0].runStart, runTop: rows[0].id });
    });

    it('reads only what changed at the top after a save, and keeps the count below it', async () => {
        const { history, sqlite, db } = fixture(seed);
        const [top] = (await history.timeline({ limit: 5 })).rows;
        const cursor = { pending: top.pending, run: top.runStart };
        const below = await history.countBelow(cursor);
        expect(below).toBe(1 + 29 * 4 - 3);
        sqlite.prepare(`INSERT INTO raw_events (id, tenant_id, log_id, local_batch_id, local_sequence, type, timestamp, payload,
            entity_id, entity_version, log_version, sync_state) VALUES ('event-121', 'tenant', 'log', 'batch', 121,
            'CALENDAR_EVENT_UPDATED', ?, ?, ?, 5, 121, 'synced')`).run(1_700_000_000_000 + 121_000,
            JSON.stringify({ id: '00000000-0000-4000-8000-000000000029', notes: 'later' }), 'calendar_event:00000000-0000-4000-8000-000000000029');
        await indexActions((query) => query.execute(db), SCOPE, ['event-121']);
        const delta = await history.timeline({ through: cursor });
        expect(delta.rows).toHaveLength(1);
        expect(delta.rows[0]).toMatchObject({ version: 121, runStart: top.runStart, runCount: 4 });
        expect(await history.countBelow(cursor)).toBe(below);
    });

    it('folds older history by month and day, and draws a busy span as slices', async () => {
        const { history } = fixture(seed);
        expect(await history.foldStart()).toBeNull(); // small enough to list whole
        const months = await history.folds('month', { until: Date.now() });
        expect(months).toHaveLength(1);
        expect(months[0]).toMatchObject({ count: 117, firstVersion: 1, lastVersion: 120 });
        expect(months[0].features.length).toBeGreaterThan(0);
        const days = await history.folds('day', { since: months[0].from, until: months[0].to + 1 });
        expect(days.reduce((sum, day) => sum + day.count, 0)).toBe(117);

        const { history: busy } = fixture({ records: 200, updatesPerRecord: 2, importEvery: 1000 });
        const points = await busy.points(0, Date.now());
        expect(points.length).toBeLessThanOrEqual(240);
        expect(points.reduce((sum, point) => sum + (point.count ?? 1), 0)).toBe(1 + 199 * 3);
    });
});
