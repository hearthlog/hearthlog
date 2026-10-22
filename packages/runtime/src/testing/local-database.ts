import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';
import type { Database } from '../db/index.js';
import { getEntityDDLForTables } from '#generated/schema';

/** Independent SQLite stores for persistence/convergence tests; no browser globals. */
export function createLocalDatabase(tables: readonly string[] = ["calendar_events"]) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
            CREATE TABLE IF NOT EXISTS "raw_events" (
                "id" TEXT NOT NULL,
                "tenant_id" TEXT NOT NULL DEFAULT 'legacy-unassigned',
                "log_id" TEXT NOT NULL DEFAULT 'legacy-unassigned',
                "local_batch_id" TEXT NOT NULL,
                "local_sequence" INTEGER NOT NULL DEFAULT 0,
                action_id TEXT, action_index INTEGER, action_size INTEGER, actor TEXT,
                "type" TEXT NOT NULL,
                "timestamp" INTEGER NOT NULL,
                "payload" TEXT NOT NULL,
                "entity_id" TEXT,
                "entity_version" INTEGER,
                "log_version" INTEGER,
                "sync_state" TEXT NOT NULL DEFAULT 'pending',
                "projection_state" TEXT NOT NULL DEFAULT 'effective',
                "rejection_code" TEXT,
                "rejection_detail" TEXT,
                "is_tombstoned" INTEGER DEFAULT 0,
                "created_at" TEXT DEFAULT (datetime('now')),
                PRIMARY KEY ("tenant_id", "log_id", "id")
            );


            CREATE TABLE IF NOT EXISTS "entity_versions" (
                "tenant_id" TEXT NOT NULL,
                "log_id" TEXT NOT NULL,
                "entity_id" TEXT NOT NULL,
                "current_version" INTEGER NOT NULL,
                "log_version" INTEGER NOT NULL,
                "updated_at" INTEGER NOT NULL,
                PRIMARY KEY ("tenant_id", "log_id", "entity_id")
            );


            CREATE TABLE IF NOT EXISTS "local_batches" (
                "id" TEXT PRIMARY KEY,
                "tenant_id" TEXT NOT NULL,
                "log_id" TEXT NOT NULL,
                "status" TEXT NOT NULL DEFAULT 'pending',
                "replacement_for" TEXT,
                "created_at" TEXT DEFAULT (datetime('now')),
                "updated_at" TEXT DEFAULT (datetime('now'))
            );


            CREATE TABLE IF NOT EXISTS "outbox_operations" (
                "id" TEXT PRIMARY KEY,
                "request_id" TEXT NOT NULL,
                "tenant_id" TEXT NOT NULL,
                "log_id" TEXT NOT NULL,
                "batch_id" TEXT NOT NULL,
                "request_body" TEXT NOT NULL,
                "request_hash" TEXT NOT NULL,
                "status" TEXT NOT NULL DEFAULT 'pending',
                "retry_count" INTEGER NOT NULL DEFAULT 0,
                "rebase_count" INTEGER NOT NULL DEFAULT 0,
                "last_error_code" TEXT,
                "last_error_message" TEXT,
                "superseded_by" TEXT,
                "next_retry_at" TEXT,
                "created_at" TEXT DEFAULT (datetime('now')),
                "updated_at" TEXT DEFAULT (datetime('now')),
                UNIQUE ("tenant_id", "log_id", "request_id")
            );


            CREATE TABLE IF NOT EXISTS "outbox_operation_items" (
                "operation_id" TEXT NOT NULL,
                "event_id" TEXT NOT NULL,
                "ordinal" INTEGER NOT NULL,
                PRIMARY KEY ("operation_id", "ordinal")
            );


            CREATE TABLE IF NOT EXISTS "log_sync_state" (
                "tenant_id" TEXT NOT NULL,
                "log_id" TEXT NOT NULL,
                "downloaded_head_version" INTEGER NOT NULL DEFAULT 0,
                "projected_head_version" INTEGER NOT NULL DEFAULT 0,
                "last_synced_at" TEXT,
                PRIMARY KEY ("tenant_id", "log_id")
            );


            CREATE TABLE IF NOT EXISTS "resolution_actions" (
                "id" TEXT PRIMARY KEY,
                "tenant_id" TEXT NOT NULL,
                "log_id" TEXT NOT NULL,
                "batch_id" TEXT NOT NULL,
                "action" TEXT NOT NULL,
                "details" TEXT,
                "created_at" TEXT DEFAULT (datetime('now'))
            );

    CREATE TABLE sync_logs (id TEXT PRIMARY KEY, timestamp INTEGER, type TEXT, message TEXT, details TEXT);
    `);
    sqlite.exec(`
        CREATE TABLE checkpoint_events AS SELECT * FROM raw_events WHERE 0;
        CREATE VIEW projection_events AS SELECT * FROM raw_events UNION ALL SELECT seed.* FROM checkpoint_events seed
            WHERE NOT EXISTS (SELECT 1 FROM raw_events raw WHERE raw.tenant_id = seed.tenant_id AND raw.log_id = seed.log_id AND raw.id = seed.id AND raw.projection_state = 'effective');
        CREATE TABLE log_baselines (tenant_id TEXT, log_id TEXT, through_version INTEGER, manifest TEXT, PRIMARY KEY(tenant_id, log_id));
        CREATE TABLE checkpoint_claims AS SELECT * FROM entity_versions WHERE 0;
    `);
    for (const ddl of getEntityDDLForTables(new Set(tables))) sqlite.exec(ddl);
    const database = new Kysely<Database>({ dialect: new SqliteDialect({ database: {
        close: () => sqlite.close(),
        prepare(query: string) {
            const statement = sqlite.prepare(query);
            return {
                reader: /^\s*(?:PRAGMA|SELECT|WITH|EXPLAIN)/i.test(query),
                all: (params: readonly unknown[]) => statement.all(...params as SQLInputValue[]),
                run: (params: readonly unknown[]) => statement.run(...params as SQLInputValue[]),
                iterate: (params: readonly unknown[]) => statement.iterate(...params as SQLInputValue[]),
            };
        },
    } }) });
    return { database, sqlite };
}
