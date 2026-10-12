import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';

import {
    ensureCoreSchema,
    getLocalSchemaVersion,
    type Database,
} from './index.js';
import { SCHEMA_VERSION } from './schema-version.js';
import { SCHEMA_LOCK_NAME } from '../store/tab-coordination.js';

// Harness mirrors schema-migration.test.ts (raw node:sqlite wrapped in Kysely).

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

const openDatabases: Kysely<Database>[] = [];

afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(openDatabases.splice(0).map((database) => database.destroy()));
});

/**
 * A database that already holds every entity table (the pre-scoping shape):
 * raw events plus projections for both an approved and a non-approved
 * entity, with legacy (unscoped) primary keys so the rebuild path runs.
 */
function createFullLegacyFixture(): { database: Kysely<Database>; sqlite: DatabaseSync } {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
        CREATE TABLE raw_events (
            id TEXT NOT NULL,
            tenant_id TEXT NOT NULL DEFAULT 'legacy-unassigned',
            log_id TEXT NOT NULL DEFAULT 'legacy-unassigned',
            local_batch_id TEXT NOT NULL DEFAULT '',
            local_sequence INTEGER NOT NULL DEFAULT 0,
            type TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            payload TEXT NOT NULL,
            entity_id TEXT,
            entity_version INTEGER,
            log_version INTEGER,
            sync_state TEXT NOT NULL DEFAULT 'synced',
            projection_state TEXT NOT NULL DEFAULT 'effective',
            is_tombstoned INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (tenant_id, log_id, id)
        );
        INSERT INTO raw_events (id, type, timestamp, payload, entity_id, entity_version)
        VALUES
            ('e-1', 'CALORIE_ENTRY_ADDED', 1, '{"id":"entry-1","name":"Lunch","calories":500,"loggedAt":"2026-07-12T12:00"}', 'calorie_entry:entry-1', 1),
            ('e-2', 'TRANSACTION_ADDED', 2, '{"id":"tx-1","name":"Groceries","amount":-42.5,"dueDate":"2026-07-15"}', 'transaction:tx-1', 1);

        CREATE TABLE entity_versions (
            tenant_id TEXT NOT NULL,
            log_id TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            current_version INTEGER NOT NULL,
            log_version INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (tenant_id, log_id, entity_id)
        );

        CREATE TABLE entity_type_definitions (
            tenant_id TEXT NOT NULL,
            log_id TEXT NOT NULL,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            display_name TEXT NOT NULL,
            table_name TEXT NOT NULL,
            fields_json TEXT NOT NULL,
            calendar_json TEXT,
            is_archived INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (tenant_id, log_id, id)
        );

        CREATE TABLE calorie_entries (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            calories REAL NOT NULL,
            logged_at TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE transactions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            amount REAL NOT NULL,
            due_date TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO transactions (id, name, amount, due_date)
        VALUES ('tx-1', 'Groceries', -42.5, '2026-07-15');
    `);

    const database = createKyselyDatabase(sqlite);
    openDatabases.push(database);
    return { database, sqlite };
}

function tableExists(sqlite: DatabaseSync, tableName: string): boolean {
    const rows = sqlite
        .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        )
        .all(tableName) as Array<{ name: string }>;
    return rows.length > 0;
}

describe('entity scope reconciliation', () => {
    it('drops tables of non-approved entities and keeps approved ones', async () => {
        const { database, sqlite } = createFullLegacyFixture();

        // Scope: calories only — transactions is not approved for this tenant.
        await ensureCoreSchema(
            { tenantId: 't-1', logId: 'log-1' },
            database,
            new Set(['calorie_entries']),
        );

        expect(tableExists(sqlite, 'calorie_entries')).toBe(true);
        expect(tableExists(sqlite, 'transactions')).toBe(false);
        expect(await getLocalSchemaVersion(database)).toBe(SCHEMA_VERSION);
    });

    it('recreates approved tables that are missing (feature re-enabled)', async () => {
        const { database, sqlite } = createFullLegacyFixture();

        await ensureCoreSchema(
            { tenantId: 't-1', logId: 'log-1' },
            database,
            new Set(['calorie_entries']),
        );
        expect(tableExists(sqlite, 'transactions')).toBe(false);

        // The tenant re-enables finance: the table must be recreated.
        await ensureCoreSchema(
            { tenantId: 't-1', logId: 'log-1' },
            database,
            new Set(['calorie_entries', 'transactions']),
        );
        expect(tableExists(sqlite, 'transactions')).toBe(true);
        // The scoped primary key shape is enforced on the recreated table.
        const columns = sqlite.prepare(`PRAGMA table_info("transactions")`).all() as Array<{
            name: string;
            pk: number;
        }>;
        const primaryKey = columns
            .filter((column) => Number(column.pk) > 0)
            .sort((left, right) => Number(left.pk) - Number(right.pk))
            .map((column) => column.name);
        expect(primaryKey).toEqual(['tenant_id', 'log_id', 'id']);
    });

    it('is idempotent when the scope is already reconciled', async () => {
        const { database, sqlite } = createFullLegacyFixture();
        const scope = new Set(['calorie_entries']);

        await ensureCoreSchema({ tenantId: 't-1', logId: 'log-1' }, database, scope);
        await ensureCoreSchema({ tenantId: 't-1', logId: 'log-1' }, database, scope);

        expect(tableExists(sqlite, 'calorie_entries')).toBe(true);
        expect(tableExists(sqlite, 'transactions')).toBe(false);
    });

    it('reconciles disabled features on a current database without deleting history', async () => {
        const { database, sqlite } = createFullLegacyFixture();
        const context = { tenantId: 't-1', logId: 'log-1' };
        await ensureCoreSchema(context, database, new Set(['calorie_entries']));
        await ensureCoreSchema(context, database, new Set(['calorie_entries', 'transactions']));
        const history = sqlite.prepare('SELECT * FROM raw_events ORDER BY id').all();

        await ensureCoreSchema(context, database, new Set());

        expect(tableExists(sqlite, 'calorie_entries')).toBe(false);
        expect(tableExists(sqlite, 'transactions')).toBe(false);
        expect(sqlite.prepare('SELECT * FROM raw_events ORDER BY id').all()).toEqual(history);
        await ensureCoreSchema(context, database, new Set());
    });

    it('records every installed module at the baseline projection version on upgrade, without touching history', async () => {
        const { database, sqlite } = createFullLegacyFixture();
        const context = { tenantId: 't-1', logId: 'log-1' };
        await ensureCoreSchema(context, database, new Set(['calorie_entries']));
        sqlite.exec('PRAGMA user_version = 40');
        const events = () => sqlite.prepare('SELECT id, type, payload FROM raw_events ORDER BY id').all();
        const history = events();

        await ensureCoreSchema(context, database, new Set(['calorie_entries']));

        expect(events()).toEqual(history);
        // Tables that predate the projection ledger are recorded at the baseline version.
        expect(sqlite.prepare('SELECT module_id, projection_version FROM module_migrations ORDER BY module_id').all())
            .toEqual([
                { module_id: 'org.stor.finance', projection_version: 1 },
                { module_id: 'org.stor.gallery', projection_version: 1 },
                { module_id: 'org.stor.health', projection_version: 1 },
                { module_id: 'org.stor.invoices', projection_version: 1 },
            ]);
        expect(await getLocalSchemaVersion(database)).toBe(SCHEMA_VERSION);
    });

    it.each(['table', 'index'] as const)('repairs a missing projection %s without changing history or dynamic tables', async (damage) => {
        const { database, sqlite } = createFullLegacyFixture();
        const context = { tenantId: 't-1', logId: 'log-1' };
        const scope = new Set(['calorie_entries', 'transactions']);
        await ensureCoreSchema(context, database, new Set(['calorie_entries']));
        await ensureCoreSchema(context, database, scope);
        const history = sqlite.prepare('SELECT * FROM raw_events ORDER BY id').all();
        const index = sqlite.prepare(`SELECT name FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'calorie_entries' AND sql IS NOT NULL LIMIT 1`)
            .get() as { name: string };
        sqlite.exec(damage === 'index' ? `DROP INDEX "${index.name}"` : 'DROP TABLE transactions');
        sqlite.exec(`CREATE TABLE custom_records (id TEXT PRIMARY KEY);
            INSERT INTO custom_records VALUES ('keep');`);

        await ensureCoreSchema(context, database, scope);

        expect(tableExists(sqlite, 'transactions')).toBe(true);
        expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
            .get(index.name)).toBeDefined();
        expect(sqlite.prepare('SELECT * FROM raw_events ORDER BY id').all()).toEqual(history);
        expect(sqlite.prepare('SELECT id FROM custom_records').get()).toEqual({ id: 'keep' });
    });

    it.each(['missing', 'malformed'] as const)('rejects a %s core table despite a current version', async (damage) => {
        const { database, sqlite } = createFullLegacyFixture();
        const context = { tenantId: 't-1', logId: 'log-1' };
        const scope = new Set(['calorie_entries']);
        await ensureCoreSchema(context, database, scope);
        const history = sqlite.prepare('SELECT * FROM raw_events ORDER BY id').all();
        if (damage === 'missing') {
            sqlite.exec('DROP TABLE entity_versions');
        } else {
            sqlite.exec(`DROP TABLE entity_versions;
                CREATE TABLE entity_versions (
                    tenant_id TEXT NOT NULL, log_id TEXT NOT NULL, entity_id TEXT NOT NULL,
                    current_version INTEGER NOT NULL, log_version INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY (log_id, tenant_id, entity_id)
                );`);
        }

        await expect(ensureCoreSchema(context, database, scope)).rejects.toThrow(
            damage === 'missing' ? 'did not create required table "entity_versions"'
                : 'table "entity_versions" with primary key (log_id, tenant_id, entity_id)',
        );
        expect(sqlite.prepare('SELECT * FROM raw_events ORDER BY id').all()).toEqual(history);
    });

    it('waits for the schema lock before repairing a current database', async () => {
        const { database, sqlite } = createFullLegacyFixture();
        const context = { tenantId: 't-1', logId: 'log-1' };
        await ensureCoreSchema(context, database, new Set(['calorie_entries']));
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const request = vi.fn(async (name, _options, task) => {
            await held;
            return task({ name });
        });
        vi.stubGlobal('navigator', { locks: { request } });

        const repair = ensureCoreSchema(context, database, new Set(['calorie_entries', 'transactions']));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(request).toHaveBeenCalledWith(SCHEMA_LOCK_NAME, { mode: 'exclusive' }, expect.any(Function));
        expect(tableExists(sqlite, 'transactions')).toBe(false);
        release();
        await repair;
        expect(tableExists(sqlite, 'transactions')).toBe(true);
    });
});
