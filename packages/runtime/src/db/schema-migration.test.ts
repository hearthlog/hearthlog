import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';

import {
    ensureCoreSchema,
    getLocalSchemaVersion,
    recreateModuleProjectionTables,
    type Database,
} from './index.js';
import { getEntityDDLForTables } from '#generated/schema';
import { moduleTables } from './module-projections.js';
import { MODULE_PROJECTIONS } from '#generated/modules';
import { SCHEMA_VERSION } from './schema-version.js';

interface KyselySqliteStatement {
    readonly reader: boolean;
    all(parameters: ReadonlyArray<unknown>): unknown[];
    run(parameters: ReadonlyArray<unknown>): {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
    };
    iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>;
}

interface KyselySqliteDatabase {
    close(): void;
    prepare(query: string): KyselySqliteStatement;
}

function wrapStatement(statement: StatementSync, query: string): KyselySqliteStatement {
    const reader = /^\s*(?:PRAGMA|SELECT|WITH|EXPLAIN)\b/i.test(query);
    return {
        reader,
        all: (parameters) => statement.all(...parameters as SQLInputValue[]),
        run: (parameters) => statement.run(...parameters as SQLInputValue[]),
        iterate: (parameters) => statement.iterate(...parameters as SQLInputValue[]),
    };
}

function createKyselyDatabase(sqlite: DatabaseSync): Kysely<Database> {
    const adapter: KyselySqliteDatabase = {
        close: () => sqlite.close(),
        prepare: (query) => wrapStatement(sqlite.prepare(query), query),
    };
    return new Kysely<Database>({
        dialect: new SqliteDialect({ database: adapter }),
    });
}

/** A pre-scoping database: unscoped core tables, an unscoped calendar, one module table, an outbox. */
function createLegacyFixture(moduleTable: string): { database: Kysely<Database>; sqlite: DatabaseSync } {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
        CREATE TABLE raw_events (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            payload TEXT NOT NULL,
            entity_id TEXT,
            entity_version INTEGER,
            created_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO raw_events (id, type, timestamp, payload, entity_id, entity_version)
        VALUES ('event-1', 'CALENDAR_EVENT_ADDED', 1, '{"id":"event-1","title":"Dentist","eventDate":"2026-10-12"}', 'calendar_event:event-1', 1);

        CREATE TABLE entity_versions (
            entity_id TEXT PRIMARY KEY,
            current_version INTEGER NOT NULL,
            log_version INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        INSERT INTO entity_versions VALUES ('calendar_event:event-1', 1, 1, 1);

        CREATE TABLE calendar_events (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            event_date TEXT NOT NULL,
            start_time TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            pinned INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO calendar_events (id, title, event_date) VALUES ('event-1', 'Dentist', '2026-10-12');

        CREATE TABLE "${moduleTable}" (id TEXT PRIMARY KEY, legacy_only TEXT);
        INSERT INTO "${moduleTable}" (id, legacy_only) VALUES ('row-1', 'old shape');

        CREATE TABLE entity_type_definitions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            table_name TEXT NOT NULL UNIQUE,
            fields_json TEXT NOT NULL,
            is_archived INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO entity_type_definitions (id, name, display_name, table_name, fields_json)
        VALUES ('custom-1', 'custom', 'Custom', 'custom_entities', '[]');

        CREATE TABLE outbox_operations (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            log_id TEXT NOT NULL,
            batch_id TEXT NOT NULL,
            request_body TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            retry_count INTEGER NOT NULL DEFAULT 0,
            rebase_count INTEGER NOT NULL DEFAULT 0,
            last_error_code TEXT,
            last_error_message TEXT,
            superseded_by TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE (tenant_id, log_id, request_id)
        );
        INSERT INTO outbox_operations (id, request_id, tenant_id, log_id, batch_id, request_body, request_hash)
        VALUES ('op-1', 'req-1', 'tenant-1', 'log-1', 'batch-1', '{"unsent":true}', 'hash');
    `);

    return { database: createKyselyDatabase(sqlite), sqlite };
}

function primaryKey(sqlite: DatabaseSync, tableName: string): string[] {
    return sqlite.prepare(`PRAGMA table_info("${tableName}")`).all()
        .filter((column) => Number(column.pk) > 0)
        .sort((left, right) => Number(left.pk) - Number(right.pk))
        .map((column) => String(column.name));
}

function columns(sqlite: DatabaseSync, tableName: string): string[] {
    return sqlite.prepare(`PRAGMA table_info("${tableName}")`).all().map((column) => String(column.name)).sort();
}

/** The columns the generated DDL gives a table, read from a database made only of that DDL. */
function generatedColumns(table: string): string[] {
    const fresh = new DatabaseSync(':memory:');
    for (const ddl of getEntityDDLForTables(new Set([table]))) fresh.exec(ddl);
    const result = columns(fresh, table);
    fresh.close();
    return result;
}

const openDatabases: Kysely<Database>[] = [];

afterEach(async () => {
    await Promise.all(openDatabases.splice(0).map((database) => database.destroy()));
});

// The first installed module and its tables; a core-only install has none and skips these tests.
const firstModule = MODULE_PROJECTIONS[0]?.module;
const moduleTable = firstModule ? moduleTables([firstModule])[0] : undefined;
const context = { tenantId: 'tenant-1', logId: 'log-1' };

describe.skipIf(!moduleTable)('ensureCoreSchema', () => {
    const approved = () => new Set(['calendar_events', moduleTable!]);

    it('migrates the core tables in place and keeps events, the outbox, and custom definitions', async () => {
        const { database, sqlite } = createLegacyFixture(moduleTable!);
        openDatabases.push(database);

        await ensureCoreSchema(context, database, approved());

        expect(primaryKey(sqlite, 'raw_events')).toEqual(['tenant_id', 'log_id', 'id']);
        expect(primaryKey(sqlite, 'entity_versions')).toEqual(['tenant_id', 'log_id', 'entity_id']);
        expect(primaryKey(sqlite, 'calendar_events')).toEqual(['tenant_id', 'log_id', 'id']);
        expect(sqlite.prepare('SELECT tenant_id, log_id, id, title FROM calendar_events').get())
            .toMatchObject({ tenant_id: 'tenant-1', log_id: 'log-1', id: 'event-1', title: 'Dentist' });
        expect(sqlite.prepare('SELECT tenant_id, log_id, id, payload FROM raw_events').get())
            .toMatchObject({ tenant_id: 'tenant-1', log_id: 'log-1', id: 'event-1',
                payload: '{"id":"event-1","title":"Dentist","eventDate":"2026-10-12"}' });
        expect(sqlite.prepare('SELECT request_body, status FROM outbox_operations').get())
            .toEqual({ request_body: '{"unsent":true}', status: 'pending' });
        expect(sqlite.prepare('SELECT id, name FROM entity_type_definitions').get())
            .toEqual({ id: 'custom-1', name: 'custom' });

        const indexNames = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map((row) => String(row.name));
        expect(indexNames).toEqual(expect.arrayContaining([
            'idx_calendar_events_scope_date',
            'idx_calendar_events_scope_pinned_date',
            'idx_entity_type_definitions_scope_name',
            'idx_outbox_operations_retry',
        ]));
        expect(await getLocalSchemaVersion(database)).toBe(SCHEMA_VERSION);
    });

    it('recreates a module read model empty, in the current shape, instead of altering it', async () => {
        const { database, sqlite } = createLegacyFixture(moduleTable!);
        openDatabases.push(database);

        await ensureCoreSchema(context, database, approved());

        expect(columns(sqlite, moduleTable!)).toEqual(generatedColumns(moduleTable!));
        expect(primaryKey(sqlite, moduleTable!)).toEqual(['tenant_id', 'log_id', 'id']);
        expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM "${moduleTable}"`).get()).toEqual({ n: 0 });
    });

    it('is idempotent once the database is current', async () => {
        const { database, sqlite } = createLegacyFixture(moduleTable!);
        openDatabases.push(database);

        await ensureCoreSchema(context, database, approved());
        sqlite.exec(`INSERT INTO "${moduleTable}" (tenant_id, log_id, id${requiredColumns(moduleTable!)}) VALUES ('tenant-1', 'log-1', 'kept'${requiredValues(moduleTable!)})`);
        await ensureCoreSchema(context, database, approved());

        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({ n: 1 });
        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_events').get()).toEqual({ n: 1 });
        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM entity_type_definitions').get()).toEqual({ n: 1 });
        expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM "${moduleTable}"`).get()).toEqual({ n: 1 });
    });

    it('recreates the tables of a module whose projection version changed, and nothing else', async () => {
        const { database, sqlite } = createLegacyFixture(moduleTable!);
        openDatabases.push(database);
        await ensureCoreSchema(context, database, approved());
        sqlite.exec(`INSERT INTO "${moduleTable}" (tenant_id, log_id, id${requiredColumns(moduleTable!)}) VALUES ('tenant-1', 'log-1', 'stale'${requiredValues(moduleTable!)})`);

        await recreateModuleProjectionTables(database, moduleTables([firstModule!]), approved());

        expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM "${moduleTable}"`).get()).toEqual({ n: 0 });
        expect(columns(sqlite, moduleTable!)).toEqual(generatedColumns(moduleTable!));
        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_events').get()).toEqual({ n: 1 });
        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({ n: 1 });
        expect(sqlite.prepare('SELECT request_body FROM outbox_operations').get()).toEqual({ request_body: '{"unsent":true}' });
    });
});

/** Required (NOT NULL, no default) columns of a generated table, with a placeholder value each. */
function requiredColumnInfo(table: string): Array<{ name: string; type: string }> {
    const fresh = new DatabaseSync(':memory:');
    for (const ddl of getEntityDDLForTables(new Set([table]))) fresh.exec(ddl);
    const info = fresh.prepare(`PRAGMA table_info("${table}")`).all()
        .filter((column) => Number(column.notnull) === 1 && column.dflt_value === null && !['tenant_id', 'log_id', 'id'].includes(String(column.name)))
        .map((column) => ({ name: String(column.name), type: String(column.type) }));
    fresh.close();
    return info;
}
function requiredColumns(table: string): string {
    return requiredColumnInfo(table).map((column) => `, "${column.name}"`).join('');
}
function requiredValues(table: string): string {
    return requiredColumnInfo(table).map((column) => (/REAL|INT/i.test(column.type) ? ', 0' : ", 'x'")).join('');
}
