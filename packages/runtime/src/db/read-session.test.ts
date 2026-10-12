import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { CALENDAR_EVENT_DDL, CALENDAR_EVENT_INDEX_DDL } from '#generated/schema';
import { createReadModelSession, type ReadModelDatabase } from './read-session.js';

/**
 * Scoped read sessions must never return another tenant's or log's rows, in
 * builder queries and in raw SQL alike, and the scope predicate must not cost
 * the composite `(tenant_id, log_id, …)` index.
 */

interface SqliteStatement {
    readonly reader: boolean;
    all(parameters: ReadonlyArray<unknown>): unknown[];
    run(parameters: ReadonlyArray<unknown>): { changes: number | bigint; lastInsertRowid: number | bigint };
    iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>;
}

function wrap(statement: StatementSync, query: string): SqliteStatement {
    return {
        reader: /^\s*(?:PRAGMA|SELECT|WITH|EXPLAIN)\b/i.test(query),
        all: (parameters) => statement.all(...parameters as SQLInputValue[]),
        run: (parameters) => statement.run(...parameters as SQLInputValue[]),
        iterate: (parameters) => statement.iterate(...parameters as SQLInputValue[]),
    };
}

const databases: Array<Kysely<ReadModelDatabase>> = [];

afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

const SEED_ROWS = [
    { tenant: 'tenant-a', log: 'log-a', id: 'a-a', date: '2026-03-01' },
    { tenant: 'tenant-a', log: 'log-a', id: 'a-a-2', date: '2026-03-02' },
    { tenant: 'tenant-a', log: 'log-b', id: 'a-b', date: '2026-03-03' },
    { tenant: 'tenant-b', log: 'log-a', id: 'b-a', date: '2026-03-04' },
    { tenant: 'tenant-b', log: 'log-b', id: 'b-b', date: '2026-03-05' },
];

function fixture(scope = { tenantId: 'tenant-a', logId: 'log-a' }) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(CALENDAR_EVENT_DDL);
    for (const ddl of CALENDAR_EVENT_INDEX_DDL) sqlite.exec(ddl);
    const insert = sqlite.prepare(
        'INSERT INTO calendar_events (tenant_id, log_id, id, title, event_date, start_time) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const row of SEED_ROWS) {
        insert.run(row.tenant, row.log, row.id, `Event ${row.id}`, row.date, '09:00');
    }
    const db = new Kysely<ReadModelDatabase>({
        dialect: new SqliteDialect({ database: {
            close: () => sqlite.close(),
            prepare: (query) => wrap(sqlite.prepare(query), query),
        } }),
    });
    databases.push(db);
    const session = createReadModelSession(db, {
        schema: 'main',
        scope,
        view: { effectiveNow: '2026-09-14T12:00:00.000Z' },
    });
    return { sqlite, db, session };
}

describe('createReadModelSession', () => {
    it('scopes builder reads to the session tenant and log', async () => {
        const { session } = fixture();
        const rows = await session.selectFrom('calendar_events')
            .selectAll()
            .orderBy('id', 'asc')
            .execute();
        expect(rows.map((row) => row.id)).toEqual(['a-a', 'a-a-2']);
    });

    it('keeps session scopes independent for the same database', async () => {
        const { db } = fixture();
        const other = createReadModelSession(db, {
            schema: 'main',
            scope: { tenantId: 'tenant-b', logId: 'log-b' },
            view: { effectiveNow: '2026-09-14T12:00:00.000Z' },
        });
        const rows = await other.selectFrom('calendar_events').selectAll().execute();
        expect(rows.map((row) => row.id)).toEqual(['b-b']);
    });

    it('scopes raw SQL through table()', async () => {
        const { session } = fixture();
        const result = await session.execute(sql<{ id: string }>`
            SELECT c.id
            FROM ${session.table('calendar_events')} AS c
            WHERE c.event_date >= '2026-03-01'
            ORDER BY c.id
        `);
        expect(result.rows.map((row) => row.id)).toEqual(['a-a', 'a-a-2']);
    });

    it('scopes every table of a raw join through table()', async () => {
        const { session } = fixture();
        const result = await session.execute(sql<{ left_id: string }>`
            SELECT left_side.id AS left_id
            FROM ${session.table('calendar_events')} AS left_side
            JOIN ${session.table('calendar_events')} AS right_side
                ON right_side.id = left_side.id
            ORDER BY left_side.id
        `);
        expect(result.rows.map((row) => row.left_id)).toEqual(['a-a', 'a-a-2']);
    });

    it('compiles the builder scope predicate into the SQL', () => {
        const { session } = fixture();
        const compiled = session.selectFrom('calendar_events').selectAll().compile();
        expect(compiled.sql).toContain('"calendar_events"."tenant_id"');
        expect(compiled.sql).toContain('"calendar_events"."log_id"');
        expect(compiled.parameters).toEqual(['tenant-a', 'log-a']);
    });

    it('keeps the composite scope index for builder reads', () => {
        const { sqlite, session } = fixture();
        const compiled = session.selectFrom('calendar_events')
            .selectAll()
            .where('event_date', '>=', '2026-03-01')
            .where('event_date', '<', '2027-01-01')
            .orderBy('event_date', 'asc')
            .orderBy('start_time', 'asc')
            .compile();
        const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
            .all(...compiled.parameters as SQLInputValue[]) as Array<{ detail: string }>;
        expect(plan.map((row) => row.detail).join('\n')).toContain('idx_calendar_events_scope_date');
    });

    it('keeps the composite scope index for raw table() reads', async () => {
        const { session } = fixture();
        const plan = await session.execute(sql<{ detail: string }>`
            EXPLAIN QUERY PLAN
            SELECT *
            FROM ${session.table('calendar_events')} AS c
            WHERE c.event_date >= '2026-03-01' AND c.event_date < '2027-01-01'
            ORDER BY c.event_date, c.start_time
        `);
        expect(plan.rows.map((row) => row.detail).join('\n')).toContain('idx_calendar_events_scope_date');
    });

});
