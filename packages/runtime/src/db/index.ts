import { repairStoredProgress } from "../store/sync-progress.js";
/**
 * Database Configuration
 *
 * Entity types and tables are auto-generated from entity-definitions.ts.
 * Core tables (raw_events, entity_versions) are defined here.
 *
 * IMPORTANT: Do not manually edit entity types here.
 * Instead, update entity-definitions.ts and run `pnpm generate:entities`.
 */

import { SQLocalKysely } from "sqlocal/kysely";
import { Kysely, type ColumnType, sql } from "kysely";

import {
    type EntityDatabaseTables,
    getEntityDDLForTables,
    getEntityIndexDDLForTables,
    ENTITY_TABLE_NAMES,
} from "#generated/schema";
import {
    getSessionContext,
    setSessionContext,
    type ActiveContext,
} from "./session-context.js";
import { tenant } from "@hearthlog/contracts/tenant/config";
import { SCHEMA_LOCK_NAME, withTabLock } from "../store/tab-coordination.js";
import { MIN_IN_PLACE_SCHEMA_VERSION, SCHEMA_VERSION } from "./schema-version.js";
import { MODULE_PROJECTIONS } from "#generated/modules";
import { allModuleTables, BASELINE_PROJECTION_VERSION } from "./module-projections.js";

export type { ActiveContext } from "./session-context.js";

// ============================================================================
// Core Tables (not entity-driven)
// ============================================================================

export type RawEventTable = {
    id: string;
    tenant_id: string;
    log_id: string;
    local_batch_id: string;
    local_sequence: number;
    action_id: ColumnType<
        string | null,
        string | null | undefined,
        string | null
    >;
    action_index: ColumnType<
        number | null,
        number | null | undefined,
        number | null
    >;
    action_size: ColumnType<
        number | null,
        number | null | undefined,
        number | null
    >;
    /** Identity Ledger recorded for the request that wrote the event. */
    actor: ColumnType<
        string | null,
        string | null | undefined,
        string | null
    >;
    type: string;
    timestamp: number;
    payload: string;
    entity_id: string | null;
    entity_version: number | null;
    log_version: number | null;
    sync_state: string;
    projection_state: string;
    rejection_code: string | null;
    rejection_detail: string | null;
    is_tombstoned: ColumnType<number, number | undefined, number>;
    created_at: ColumnType<string, string | undefined, never>;
};

export type EntityVersionTable = {
    tenant_id: string;
    log_id: string;
    entity_id: string;
    current_version: number;
    log_version: number;
    updated_at: number;
};

export type ActiveContextTable = {
    id: number;
    tenant_id: string;
    principal_id: string;
    log_id: string;
    ledger_origin: string;
    updated_at: string;
};

export type LocalBatchTable = {
    id: string;
    tenant_id: string;
    log_id: string;
    status: string;
    replacement_for: string | null;
    created_at: ColumnType<string, string | undefined, never>;
    updated_at: ColumnType<string, string | undefined, string>;
};

export type OutboxOperationTable = {
    id: string;
    request_id: string;
    tenant_id: string;
    log_id: string;
    batch_id: string;
    request_body: string;
    request_hash: string;
    status: string;
    retry_count: number;
    rebase_count: number;
    last_error_code: string | null;
    last_error_message: string | null;
    superseded_by: string | null;
    next_retry_at: string | null;
    created_at: ColumnType<string, string | undefined, never>;
    updated_at: ColumnType<string, string | undefined, string>;
};

export type OutboxOperationItemTable = {
    operation_id: string;
    event_id: string;
    ordinal: number;
};

export type LogSyncStateTable = {
    tenant_id: string;
    log_id: string;
    downloaded_head_version: number;
    projected_head_version: number;
    last_synced_at: string | null;
};

export type ResolutionActionTable = {
    id: string;
    tenant_id: string;
    log_id: string;
    batch_id: string;
    action: string;
    details: string | null;
    created_at: ColumnType<string, string | undefined, never>;
};

export type SyncLogTable = {
    id: string;
    timestamp: number;
    type: string;
    message: string;
    details: string | null;
    created_at: ColumnType<string, string | undefined, never>;
};

export type EntityTypeDefinitionTable = {
    tenant_id: string;
    log_id: string;
    id: string;
    name: string;
    display_name: string;
    table_name: string;
    fields_json: string; // JSON array of DynamicFieldDefinition
    /** JSON array of EntityCalendarSource; null when not on the calendar. */
    calendar_json: ColumnType<string | null, string | null | undefined, string | null>;
    is_archived: ColumnType<number, number | undefined, number>;
    created_at: ColumnType<string, string | undefined, never>;
    updated_at: ColumnType<string, string | undefined, string>;
};

// ============================================================================
// Database Interface
// ============================================================================

/** One row per module: the projection version of its read-model tables. */
export type ModuleMigrationTable = {
    module_id: string;
    projection_version: number;
    applied_at: string;
};

export interface Database extends EntityDatabaseTables {
    module_migrations: ModuleMigrationTable;
    raw_events: RawEventTable;
    checkpoint_events: RawEventTable;
    projection_events: RawEventTable;
    log_baselines: { tenant_id: string; log_id: string; through_version: number; manifest: string };
    checkpoint_claims: EntityVersionTable;
    entity_versions: EntityVersionTable;
    active_context: ActiveContextTable;
    local_batches: LocalBatchTable;
    outbox_operations: OutboxOperationTable;
    outbox_operation_items: OutboxOperationItemTable;
    log_sync_state: LogSyncStateTable;
    resolution_actions: ResolutionActionTable;
    sync_logs: SyncLogTable;
    entity_type_definitions: EntityTypeDefinitionTable;
}

// ============================================================================
// Database Initialization
// ============================================================================

// Singleton pattern for HMR support
// We attach the DB instance to globalThis to prevent multiple workers spawning during hot reloads
// which causes database locking issues.

// SAFETY: `globalThis` is an untyped host object; the only property this
// module reads from it is the SQLocal singleton it wrote itself under HMR.
const globalForDb = globalThis as unknown as {
    sqlocalDb: SQLocalKysely | undefined;
};

export const sqlocalDb =
    globalForDb.sqlocalDb ??
    new SQLocalKysely({
        databasePath: import.meta.env.VITE_E2E === "1" ? "session" : "stor",
        onInit: (sql) => {
            // Get entity DDLs from the generated schema, restricted to the
            // entities this tenant is approved for (feature-scoped SQLite):
            // tenants only get projection tables for their enabled features.
            const entityDDLs = getEntityDDLForTables(
                tenant.approvedEntities.tables,
            ).map((ddl) => ({ sql: ddl, params: [] }));

            // Core table DDLs
            const rawEventsDDL = sql`
            CREATE TABLE IF NOT EXISTS "raw_events" (
                "id" TEXT NOT NULL,
                "tenant_id" TEXT NOT NULL DEFAULT 'legacy-unassigned',
                "log_id" TEXT NOT NULL DEFAULT 'legacy-unassigned',
                "local_batch_id" TEXT NOT NULL,
                "local_sequence" INTEGER NOT NULL DEFAULT 0,
                action_id TEXT, action_index INTEGER, action_size INTEGER,
                actor TEXT,
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
        `;

            const entityVersionsDDL = sql`
            CREATE TABLE IF NOT EXISTS "entity_versions" (
                "tenant_id" TEXT NOT NULL,
                "log_id" TEXT NOT NULL,
                "entity_id" TEXT NOT NULL,
                "current_version" INTEGER NOT NULL,
                "log_version" INTEGER NOT NULL,
                "updated_at" INTEGER NOT NULL,
                PRIMARY KEY ("tenant_id", "log_id", "entity_id")
            );
        `;

            const activeContextDDL = sql`
            CREATE TABLE IF NOT EXISTS "active_context" (
                "id" INTEGER PRIMARY KEY CHECK ("id" = 1),
                "tenant_id" TEXT NOT NULL,
                "principal_id" TEXT NOT NULL,
                "log_id" TEXT NOT NULL,
                "ledger_origin" TEXT NOT NULL,
                "updated_at" TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `;

            const localBatchesDDL = sql`
            CREATE TABLE IF NOT EXISTS "local_batches" (
                "id" TEXT PRIMARY KEY,
                "tenant_id" TEXT NOT NULL,
                "log_id" TEXT NOT NULL,
                "status" TEXT NOT NULL DEFAULT 'pending',
                "replacement_for" TEXT,
                "created_at" TEXT DEFAULT (datetime('now')),
                "updated_at" TEXT DEFAULT (datetime('now'))
            );
        `;

            const outboxOperationsDDL = sql`
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
        `;

            const outboxOperationItemsDDL = sql`
            CREATE TABLE IF NOT EXISTS "outbox_operation_items" (
                "operation_id" TEXT NOT NULL,
                "event_id" TEXT NOT NULL,
                "ordinal" INTEGER NOT NULL,
                PRIMARY KEY ("operation_id", "ordinal")
            );
        `;

            const logSyncStateDDL = sql`
            CREATE TABLE IF NOT EXISTS "log_sync_state" (
                "tenant_id" TEXT NOT NULL,
                "log_id" TEXT NOT NULL,
                "downloaded_head_version" INTEGER NOT NULL DEFAULT 0,
                "projected_head_version" INTEGER NOT NULL DEFAULT 0,
                "last_synced_at" TEXT,
                PRIMARY KEY ("tenant_id", "log_id")
            );
        `;

            const resolutionActionsDDL = sql`
            CREATE TABLE IF NOT EXISTS "resolution_actions" (
                "id" TEXT PRIMARY KEY,
                "tenant_id" TEXT NOT NULL,
                "log_id" TEXT NOT NULL,
                "batch_id" TEXT NOT NULL,
                "action" TEXT NOT NULL,
                "details" TEXT,
                "created_at" TEXT DEFAULT (datetime('now'))
            );
        `;

            // Indexes
            const rawEventsTimestampIdx = sql`
            CREATE INDEX IF NOT EXISTS "idx_raw_events_timestamp"
            ON "raw_events" ("timestamp");
        `;

            const rawEventsTypeIdx = sql`
            CREATE INDEX IF NOT EXISTS "idx_raw_events_type"
            ON "raw_events" ("type");
        `;

            const rawEventsEntityIdx = sql`
            CREATE INDEX IF NOT EXISTS "idx_raw_events_entity_id"
            ON "raw_events" ("entity_id");
        `;

            // One record's events within a log. Projections, history labels and undo all start from an entity id;
            // without the scope in front SQLite reads the whole log to find them.
            const rawEventsScopeEntityIdx = sql`
            CREATE INDEX IF NOT EXISTS "idx_raw_events_scope_entity"
            ON "raw_events" ("tenant_id", "log_id", "entity_id", "log_version");
        `;

            const rawEventsTypeTsIdx = sql`
            CREATE INDEX IF NOT EXISTS "idx_raw_events_type_ts"
            ON "raw_events" ("type", "timestamp");
        `;

            const rawEventsEntityVersionIdx = sql`
            CREATE INDEX IF NOT EXISTS "idx_raw_events_entity_version"
            ON "raw_events" ("entity_id", "entity_version");
        `;

            const rawEventsLogVersionIdx = sql`
            CREATE INDEX IF NOT EXISTS "idx_raw_events_log_version"
            ON "raw_events" ("log_version");
        `;

            const localBatchesScopeIdx = sql`
            CREATE INDEX IF NOT EXISTS "idx_local_batches_scope_status"
            ON "local_batches" ("tenant_id", "log_id", "status", "created_at");
        `;

            const outboxOperationsScopeIdx = sql`
            CREATE INDEX IF NOT EXISTS "idx_outbox_operations_scope_status"
            ON "outbox_operations" ("tenant_id", "log_id", "status", "created_at");
        `;

            const syncLogsDDL = sql`
            CREATE TABLE IF NOT EXISTS "sync_logs" (
                "id" TEXT PRIMARY KEY,
                "timestamp" INTEGER NOT NULL,
                "type" TEXT NOT NULL,
                "message" TEXT NOT NULL,
                "details" TEXT,
                "created_at" TEXT DEFAULT (datetime('now'))
            );
        `;

            const syncLogsTimestampIdx = sql`
            CREATE INDEX IF NOT EXISTS "idx_sync_logs_timestamp"
            ON "sync_logs" ("timestamp" DESC);
        `;

            const entityTypeDefinitionsDDL = sql`
            CREATE TABLE IF NOT EXISTS "entity_type_definitions" (
                "tenant_id" TEXT NOT NULL,
                "log_id" TEXT NOT NULL,
                "id" TEXT NOT NULL,
                "name" TEXT NOT NULL,
                "display_name" TEXT NOT NULL,
                "table_name" TEXT NOT NULL,
                "fields_json" TEXT NOT NULL,
                "calendar_json" TEXT,
                "is_archived" INTEGER DEFAULT 0,
                "created_at" TEXT DEFAULT (datetime('now')),
                "updated_at" TEXT DEFAULT (datetime('now')),
                PRIMARY KEY ("tenant_id", "log_id", "id"),
                UNIQUE ("tenant_id", "log_id", "name"),
                UNIQUE ("tenant_id", "log_id", "table_name")
            );
        `;

            return [
                ...entityDDLs,
                rawEventsDDL,
                rawEventsTimestampIdx,
                rawEventsTypeIdx,
                rawEventsEntityIdx,
                rawEventsScopeEntityIdx,
                rawEventsTypeTsIdx,
                rawEventsEntityVersionIdx,
                rawEventsLogVersionIdx,
                entityVersionsDDL,
                activeContextDDL,
                localBatchesDDL,
                localBatchesScopeIdx,
                outboxOperationsDDL,
                outboxOperationsScopeIdx,
                outboxOperationItemsDDL,
                logSyncStateDDL,
                resolutionActionsDDL,
                // Sync logs:
                syncLogsDDL,
                syncLogsTimestampIdx,
                // Entity type definitions:
                entityTypeDefinitionsDDL,
            ];
        },
    });

if (process.env.NODE_ENV !== "production") {
    globalForDb.sqlocalDb = sqlocalDb;
}

const { dialect } = sqlocalDb;
export const db = new Kysely<Database>({ dialect });

/**
 * Ensures core tables have required columns that might have been added in later versions.
 * This is a simple migration helper for core tables.
 */
export interface SchemaMigrationContext {
    tenantId: string;
    logId: string;
}

export async function ensureCoreSchema(
    context?: SchemaMigrationContext,
    database: Kysely<Database> = db,
    approvedTables: ReadonlySet<string> = tenant.approvedEntities.tables,
): Promise<void> {
    // Current-version feature reconciliation can change tables too. Inspect
    // and repair inside the same lock used by migrations and read-model rebuilds.
    await withTabLock(SCHEMA_LOCK_NAME, () =>
        migrateCoreSchema(context, database, approvedTables),
    );
}

/** Check the actual schema in one worker exchange, without a persisted cache. */
async function inspectCoreSchema(
    database: Kysely<Database>,
    approvedTables: ReadonlySet<string>,
): Promise<{ user_version: number; healthy: number }> {
    const projectionTables = ENTITY_TABLE_NAMES.filter((name) => approvedTables.has(name));
    const expectedTables = [
        { name: 'raw_events', pk: ['tenant_id', 'log_id', 'id'] },
        { name: 'entity_versions', pk: ['tenant_id', 'log_id', 'entity_id'] },
        { name: 'entity_type_definitions', pk: ['tenant_id', 'log_id', 'id'] },
        { name: 'module_migrations', pk: ['module_id'] },
        ...projectionTables.map((name) => ({ name, pk: ['tenant_id', 'log_id', 'id'] })),
    ];
    // Names come from generated DDL, so the check follows entity definitions
    // without maintaining another index registry.
    const expectedIndexes = getEntityIndexDDLForTables(approvedTables).map((ddl) => {
        const match = ddl.match(/^\s*CREATE INDEX IF NOT EXISTS "([^"]+)"\s+ON "([^"]+)"/i);
        if (!match) throw new Error('Unrecognized generated entity index DDL');
        return { name: match[1], table: match[2] };
    });
    const result = await sql<{ user_version: number; healthy: number }>`
        WITH expected_tables AS (
            SELECT json_extract(value, '$.name') AS name,
                json_extract(value, '$.pk') AS primary_key
            FROM json_each(${JSON.stringify(expectedTables)})
        ), expected_indexes AS (
            SELECT json_extract(value, '$.name') AS name,
                json_extract(value, '$.table') AS table_name
            FROM json_each(${JSON.stringify(expectedIndexes)})
        )
        SELECT (SELECT user_version FROM pragma_user_version) AS user_version,
            NOT EXISTS (
                SELECT 1 FROM expected_tables AS expected
                WHERE (
                    SELECT json_group_array(name) FROM (
                        SELECT name FROM pragma_table_info(expected.name, 'main')
                        WHERE pk > 0 ORDER BY pk
                    )
                ) != expected.primary_key
            ) AND NOT EXISTS (
                SELECT 1 FROM sqlite_master
                WHERE type = 'table'
                    AND name IN (SELECT value FROM json_each(${JSON.stringify(ENTITY_TABLE_NAMES)}))
                    AND name NOT IN (SELECT value FROM json_each(${JSON.stringify(projectionTables)}))
            ) AND NOT EXISTS (
                SELECT 1 FROM expected_indexes AS expected
                WHERE NOT EXISTS (
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'index' AND name = expected.name AND tbl_name = expected.table_name
                )
            ) AS healthy
    `.execute(database);
    return result.rows[0];
}

/**
 * Drops the given module projection tables and recreates the approved ones empty, with their
 * indexes. Read models are derived from `raw_events`, so the next rebuild refills them; events,
 * the outbox, and the core's own tables are never touched. The caller holds the schema lock.
 */
export async function recreateModuleProjectionTables(
    database: Kysely<Database>,
    tables: readonly string[],
    approvedTables: ReadonlySet<string> = tenant.approvedEntities.tables,
): Promise<void> {
    for (const table of tables) {
        await sql.raw(`DROP TABLE IF EXISTS "${table}"`).execute(database);
    }
    const recreated = new Set(tables.filter((table) => approvedTables.has(table)));
    for (const ddl of getEntityDDLForTables(recreated)) await sql.raw(ddl).execute(database);
    for (const ddl of getEntityIndexDDLForTables(recreated)) await sql.raw(ddl).execute(database);
}

async function migrateCoreSchema(
    context: SchemaMigrationContext | undefined,
    database: Kysely<Database>,
    approvedTables: ReadonlySet<string>,
): Promise<void> {
    const schema = await inspectCoreSchema(database, approvedTables);
    if (schema.user_version === SCHEMA_VERSION) {
        // A current version alone does not prove snapshot support was initialized.
        await createCheckpointTables(database);
        if (schema.healthy) return;
        // Feature sets can change between builds without a schema version
        // bump: reconcile when the actual schema differs. Dropping is safe —
        // the ledger remains authoritative and raw_events keeps the history.
        await reconcileEntityScope(database, approvedTables);
        await validateCoreSchema(database, approvedTables);
        return;
    }

    // A database older than the floor is not repaired column by column: its module read models
    // are recreated empty and the rebuild that follows a version change refills them.
    if (schema.user_version < MIN_IN_PLACE_SCHEMA_VERSION) {
        await recreateModuleProjectionTables(database, allModuleTables(), approvedTables);
    }

    async function addColumn(statement: ReturnType<typeof sql>): Promise<void> {
        try {
            await statement.execute(database);
        } catch (error: any) {
            if (error?.message?.includes("duplicate column name")) {
                return;
            }
            if (error?.message?.includes("no such table")) {
                return;
            }
            throw error;
        }
    }

    // SQLite doesn't have ADD COLUMN IF NOT EXISTS, so duplicate-column errors are ignored.
    await addColumn(
        sql`ALTER TABLE "raw_events" ADD COLUMN "is_tombstoned" INTEGER DEFAULT 0`,
    );
    await addColumn(
        sql`ALTER TABLE "raw_events" ADD COLUMN "log_version" INTEGER`,
    );
    await addColumn(sql`ALTER TABLE "raw_events" ADD COLUMN "tenant_id" TEXT`);
    await addColumn(sql`ALTER TABLE "raw_events" ADD COLUMN "log_id" TEXT`);
    await addColumn(
        sql`ALTER TABLE "raw_events" ADD COLUMN "local_batch_id" TEXT`,
    );
    await addColumn(
        sql`ALTER TABLE "raw_events" ADD COLUMN "local_sequence" INTEGER DEFAULT 0`,
    );
    await addColumn(
        sql`ALTER TABLE "raw_events" ADD COLUMN "sync_state" TEXT DEFAULT 'pending'`,
    );
    await addColumn(
        sql`ALTER TABLE "raw_events" ADD COLUMN "projection_state" TEXT DEFAULT 'effective'`,
    );
    await addColumn(
        sql`ALTER TABLE "raw_events" ADD COLUMN "rejection_code" TEXT`,
    );
    await addColumn(
        sql`ALTER TABLE "raw_events" ADD COLUMN "rejection_detail" TEXT`,
    );

    await addColumn(sql`ALTER TABLE raw_events ADD COLUMN action_id TEXT`);
    await addColumn(
        sql`ALTER TABLE raw_events ADD COLUMN action_index INTEGER`,
    );
    await addColumn(sql`ALTER TABLE raw_events ADD COLUMN action_size INTEGER`);
    await addColumn(sql`ALTER TABLE raw_events ADD COLUMN actor TEXT`);

    // Generated CREATE TABLE statements are idempotent and ensure newly added
    // approved entities exist even when Vite HMR keeps the SQLite worker
    // alive across code updates. Non-approved entities are never created.
    for (const ddl of getEntityDDLForTables(approvedTables)) {
        await sql.raw(ddl).execute(database);
    }

    await createScopedSupportTables(database);
    // The pre-Ledger outbox was replaced by outbox_operations; nothing reads it.
    await sql`DROP TABLE IF EXISTS outbox_events`.execute(database);
    await addColumn(
        sql`ALTER TABLE "outbox_operations" ADD COLUMN "next_retry_at" TEXT`,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_outbox_operations_retry ON outbox_operations (tenant_id, log_id, status, next_retry_at)`.execute(
        database,
    );

    const tenantId = context?.tenantId ?? "legacy-unassigned";
    const logId = context?.logId ?? "legacy-unassigned";
    await sql`
        UPDATE raw_events
        SET tenant_id = COALESCE(tenant_id, ${tenantId}),
            log_id = COALESCE(log_id, ${logId}),
            local_batch_id = COALESCE(local_batch_id, id),
            local_sequence = CASE WHEN local_sequence = 0 THEN rowid ELSE local_sequence END,
            sync_state = CASE
                WHEN sync_state IS NULL THEN CASE WHEN log_version IS NULL THEN 'pending' ELSE 'synced' END
                WHEN sync_state = 'pending' AND log_version IS NOT NULL THEN 'synced'
                ELSE sync_state
            END,
            projection_state = COALESCE(projection_state, 'effective')
    `.execute(database);

    await migrateRawEventsTable(database);
    await migrateEntityVersionsTable(context, database);
    await migrateEntityProjectionTables(context, database, approvedTables);
    await migrateEntityTypeDefinitionsTable(context, database);
    await addColumn(
        sql`ALTER TABLE entity_type_definitions ADD COLUMN calendar_json TEXT`,
    );
    await createScopedSupportTables(database);
    // v42: tables that predate the projection ledger are at the baseline version.
    for (const { module } of MODULE_PROJECTIONS) {
        await sql`INSERT OR IGNORE INTO module_migrations (module_id, projection_version)
            VALUES (${module}, ${BASELINE_PROJECTION_VERSION})`.execute(database);
    }
    await reconcileEntityScope(database, approvedTables);
    await createEntityIndexes(database, approvedTables);

    await sql`
        INSERT OR IGNORE INTO local_batches (id, tenant_id, log_id, status, created_at, updated_at)
        SELECT local_batch_id, tenant_id, log_id,
               CASE WHEN MAX(log_version) IS NULL THEN 'pending' ELSE 'synced' END,
               MIN(created_at), datetime('now')
        FROM raw_events
        GROUP BY tenant_id, log_id, local_batch_id
    `.execute(database);

    await createCheckpointTables(database);
    await validateCoreSchema(database, approvedTables);
    await repairStoredProgress(database);
    await sql.raw(`PRAGMA user_version = ${SCHEMA_VERSION}`).execute(database);
}

async function createCheckpointTables(database: Kysely<Database>): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS log_baselines (
        tenant_id TEXT NOT NULL, log_id TEXT NOT NULL, through_version INTEGER NOT NULL,
        manifest TEXT NOT NULL, PRIMARY KEY(tenant_id, log_id)
    )`.execute(database);
    await sql`CREATE TABLE IF NOT EXISTS checkpoint_events AS SELECT * FROM raw_events WHERE 0`.execute(database);
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS checkpoint_event_identity ON checkpoint_events(tenant_id, log_id, id)`.execute(database);
    await sql`CREATE INDEX IF NOT EXISTS checkpoint_event_entity ON checkpoint_events(tenant_id, log_id, entity_id, entity_version)`.execute(database);
    await sql`CREATE INDEX IF NOT EXISTS checkpoint_event_type ON checkpoint_events(tenant_id, log_id, type)`.execute(database);
    await sql`CREATE TABLE IF NOT EXISTS checkpoint_claims (
        tenant_id TEXT NOT NULL, log_id TEXT NOT NULL, entity_id TEXT NOT NULL, current_version INTEGER NOT NULL,
        log_version INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(tenant_id, log_id, entity_id)
    )`.execute(database);
    await sql`DROP VIEW IF EXISTS projection_events`.execute(database);
    await sql`CREATE VIEW projection_events AS
        SELECT * FROM raw_events UNION ALL SELECT seed.* FROM checkpoint_events seed
        WHERE NOT EXISTS (SELECT 1 FROM raw_events raw WHERE raw.tenant_id = seed.tenant_id AND raw.log_id = seed.log_id AND raw.id = seed.id AND raw.projection_state = 'effective')
    `.execute(database);
}

async function createScopedSupportTables(
    database: Kysely<Database>,
): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS active_context (
        id INTEGER PRIMARY KEY CHECK (id = 1), tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL, log_id TEXT NOT NULL, ledger_origin TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`.execute(database);
    await sql`CREATE TABLE IF NOT EXISTS local_batches (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, log_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', replacement_for TEXT,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`.execute(database);
    await sql`CREATE TABLE IF NOT EXISTS outbox_operations (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        log_id TEXT NOT NULL, batch_id TEXT NOT NULL, request_body TEXT NOT NULL,
        request_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0, rebase_count INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT, last_error_message TEXT, superseded_by TEXT,
        next_retry_at TEXT,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE (tenant_id, log_id, request_id)
    )`.execute(database);
    await sql`CREATE TABLE IF NOT EXISTS outbox_operation_items (
        operation_id TEXT NOT NULL, event_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        PRIMARY KEY (operation_id, ordinal)
    )`.execute(database);
    await sql`CREATE TABLE IF NOT EXISTS log_sync_state (
        tenant_id TEXT NOT NULL, log_id TEXT NOT NULL,
        downloaded_head_version INTEGER NOT NULL DEFAULT 0,
        projected_head_version INTEGER NOT NULL DEFAULT 0, last_synced_at TEXT,
        PRIMARY KEY (tenant_id, log_id)
    )`.execute(database);
    await sql`CREATE TABLE IF NOT EXISTS module_migrations (
        module_id TEXT PRIMARY KEY, projection_version INTEGER NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`.execute(database);
    await sql`CREATE TABLE IF NOT EXISTS resolution_actions (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, log_id TEXT NOT NULL,
        batch_id TEXT NOT NULL, action TEXT NOT NULL, details TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    )`.execute(database);
    await sql`CREATE INDEX IF NOT EXISTS idx_raw_events_scope_order ON raw_events (tenant_id, log_id, log_version, local_sequence)`.execute(
        database,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_raw_events_batch ON raw_events (tenant_id, log_id, local_batch_id, local_sequence)`.execute(
        database,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_raw_events_timestamp ON raw_events (timestamp)`.execute(
        database,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_raw_events_type ON raw_events (type)`.execute(
        database,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_raw_events_entity_id ON raw_events (entity_id)`.execute(
        database,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_raw_events_type_ts ON raw_events (type, timestamp)`.execute(
        database,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_raw_events_entity_version ON raw_events (entity_id, entity_version)`.execute(
        database,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_raw_events_log_version ON raw_events (log_version)`.execute(
        database,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_local_batches_scope_status ON local_batches (tenant_id, log_id, status, created_at)`.execute(
        database,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_outbox_operations_scope_status ON outbox_operations (tenant_id, log_id, status, created_at)`.execute(
        database,
    );
}

async function createEntityIndexes(
    database: Kysely<Database>,
    approvedTables: ReadonlySet<string>,
): Promise<void> {
    // Generated entity indexes are deliberately created after legacy projection
    // tables have been migrated to their current shape. Creating scoped indexes in
    // SQLocal's onInit hook would fail before an unscoped database can be migrated.
    for (const ddl of getEntityIndexDDLForTables(approvedTables)) {
        await sql.raw(ddl).execute(database);
    }
    await sql`CREATE INDEX IF NOT EXISTS idx_entity_type_definitions_scope_name ON entity_type_definitions (tenant_id, log_id, name)`.execute(
        database,
    );
}

/**
 * Reconciles the entity projection tables with the tenant's approved entity
 * set: tables of non-approved entities are dropped (the ledger remains
 * authoritative and raw_events keeps the full history, so re-enabling a
 * feature later re-projects cleanly), and approved tables that are missing
 * are recreated idempotently (feature re-enabled).
 */
async function reconcileEntityScope(
    database: Kysely<Database>,
    approvedTables: ReadonlySet<string>,
): Promise<void> {
    for (const tableName of ENTITY_TABLE_NAMES) {
        const exists = await sql<{ name: string }>`
            SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${tableName}
        `.execute(database);
        if (exists.rows.length === 0) continue;
        if (approvedTables.has(tableName)) continue;
        await sql.raw(`DROP TABLE "${tableName}"`).execute(database);
    }
    for (const ddl of getEntityDDLForTables(approvedTables)) {
        await sql.raw(ddl).execute(database);
    }
    for (const ddl of getEntityIndexDDLForTables(approvedTables)) {
        await sql.raw(ddl).execute(database);
    }
}

interface SchemaColumnInfo {
    name: string;
    pk: number;
}

async function validateScopedPrimaryKey(
    database: Kysely<Database>,
    tableName: string,
    expectedPrimaryKey: string[],
): Promise<void> {
    const columns = await sql<SchemaColumnInfo>`
        PRAGMA table_info(${sql.raw(`"${tableName.replace(/"/g, '""')}"`)})
    `.execute(database);
    if (columns.rows.length === 0) {
        throw new Error(
            `Schema migration did not create required table "${tableName}"`,
        );
    }

    const columnNames = new Set(columns.rows.map((column) => column.name));
    for (const requiredColumn of expectedPrimaryKey) {
        if (!columnNames.has(requiredColumn)) {
            throw new Error(
                `Schema migration left table "${tableName}" without required column "${requiredColumn}"`,
            );
        }
    }

    const actualPrimaryKey = columns.rows
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);
    if (actualPrimaryKey.join(",") !== expectedPrimaryKey.join(",")) {
        throw new Error(
            `Schema migration left table "${tableName}" with primary key (${actualPrimaryKey.join(", ")}) instead of (${expectedPrimaryKey.join(", ")})`,
        );
    }
}

async function validateCoreSchema(
    database: Kysely<Database>,
    approvedTables: ReadonlySet<string> = tenant.approvedEntities.tables,
): Promise<void> {
    await validateScopedPrimaryKey(database, "raw_events", [
        "tenant_id",
        "log_id",
        "id",
    ]);
    await validateScopedPrimaryKey(database, "entity_versions", [
        "tenant_id",
        "log_id",
        "entity_id",
    ]);
    await validateScopedPrimaryKey(database, "entity_type_definitions", [
        "tenant_id",
        "log_id",
        "id",
    ]);
    for (const tableName of ENTITY_TABLE_NAMES) {
        if (!approvedTables.has(tableName)) continue;
        await validateScopedPrimaryKey(database, tableName, [
            "tenant_id",
            "log_id",
            "id",
        ]);
    }
}

export async function getLocalSchemaVersion(
    database: Kysely<Database> = db,
): Promise<number> {
    const result = await sql<{
        user_version: number;
    }>`PRAGMA user_version`.execute(database);
    return Number(result.rows[0]?.user_version ?? 0);
}

async function migrateRawEventsTable(
    database: Kysely<Database>,
): Promise<void> {
    const columns = await sql<{
        name: string;
        pk: number;
    }>`PRAGMA table_info(raw_events)`.execute(database);
    const primaryKey = columns.rows
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);
    if (primaryKey.join(",") === "tenant_id,log_id,id") return;

    await database.transaction().execute(async (tx) => {
        await sql`DROP TABLE IF EXISTS raw_events_scoped`.execute(tx);
        await sql`CREATE TABLE raw_events_scoped (
            id TEXT NOT NULL, tenant_id TEXT NOT NULL, log_id TEXT NOT NULL,
            local_batch_id TEXT NOT NULL, local_sequence INTEGER NOT NULL DEFAULT 0,
            action_id TEXT, action_index INTEGER, action_size INTEGER,
            actor TEXT,
            type TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL,
            entity_id TEXT, entity_version INTEGER, log_version INTEGER,
            sync_state TEXT NOT NULL DEFAULT 'pending',
            projection_state TEXT NOT NULL DEFAULT 'effective',
            rejection_code TEXT, rejection_detail TEXT,
            is_tombstoned INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (tenant_id, log_id, id)
        )`.execute(tx);
        await sql`
            INSERT INTO raw_events_scoped (
                id, tenant_id, log_id, local_batch_id, local_sequence, type,
                timestamp, payload, entity_id, entity_version, log_version,
                sync_state, projection_state, rejection_code, rejection_detail,
                action_id, action_index, action_size, actor,
                is_tombstoned, created_at
            )
            SELECT id, tenant_id, log_id, local_batch_id, local_sequence, type,
                   timestamp, payload, entity_id, entity_version, log_version,
                   sync_state, projection_state, rejection_code, rejection_detail,
                action_id, action_index, action_size, actor,
                   is_tombstoned, created_at
            FROM raw_events
        `.execute(tx);
        await sql`DROP VIEW IF EXISTS projection_events`.execute(tx);
        await sql`DROP TABLE raw_events`.execute(tx);
        await sql`ALTER TABLE raw_events_scoped RENAME TO raw_events`.execute(
            tx,
        );
    });
}

async function migrateEntityVersionsTable(
    context: SchemaMigrationContext | undefined,
    database: Kysely<Database>,
): Promise<void> {
    const columns = await sql<{
        name: string;
    }>`PRAGMA table_info(entity_versions)`.execute(database);
    if (columns.rows.some((column) => column.name === "tenant_id")) return;

    const tenantId = context?.tenantId ?? "legacy-unassigned";
    const logId = context?.logId ?? "legacy-unassigned";
    await database.transaction().execute(async (tx) => {
        await sql`DROP TABLE IF EXISTS entity_versions_scoped`.execute(tx);
        await sql`CREATE TABLE entity_versions_scoped (
            tenant_id TEXT NOT NULL, log_id TEXT NOT NULL, entity_id TEXT NOT NULL,
            current_version INTEGER NOT NULL, log_version INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY (tenant_id, log_id, entity_id)
        )`.execute(tx);
        await sql`
            INSERT INTO entity_versions_scoped
                (tenant_id, log_id, entity_id, current_version, log_version, updated_at)
            SELECT ${tenantId}, ${logId}, entity_id, current_version, log_version, updated_at
            FROM entity_versions
        `.execute(tx);
        await sql`DROP TABLE entity_versions`.execute(tx);
        await sql`ALTER TABLE entity_versions_scoped RENAME TO entity_versions`.execute(
            tx,
        );
    });
}

/**
 * Activates context for this tab and persists last-used defaults for cold start.
 * Concurrent tabs keep their own session context; only the shared last-used row is overwritten.
 */
export async function setActiveContext(context: ActiveContext): Promise<void> {
    setSessionContext(context);
    await ensureCoreSchema({
        tenantId: context.tenantId,
        logId: context.logId,
    });
    const persisted = await db
        .selectFrom("active_context")
        .select(["tenant_id", "principal_id", "log_id", "ledger_origin"])
        .where("id", "=", 1)
        .executeTakeFirst();
    const contextChanged =
        !persisted ||
        persisted.tenant_id !== context.tenantId ||
        persisted.principal_id !== context.principalId ||
        persisted.log_id !== context.logId ||
        persisted.ledger_origin !== context.ledgerOrigin;
    if (contextChanged) {
        await db
            .insertInto("active_context")
            .values({
                id: 1,
                tenant_id: context.tenantId,
                principal_id: context.principalId,
                log_id: context.logId,
                ledger_origin: context.ledgerOrigin,
                updated_at: new Date().toISOString(),
            })
            .onConflict((oc) =>
                oc.column("id").doUpdateSet({
                    tenant_id: context.tenantId,
                    principal_id: context.principalId,
                    log_id: context.logId,
                    ledger_origin: context.ledgerOrigin,
                    updated_at: new Date().toISOString(),
                }),
            )
            .execute();
    }

    const syncState = await db
        .selectFrom("log_sync_state")
        .select("log_id")
        .where("tenant_id", "=", context.tenantId)
        .where("log_id", "=", context.logId)
        .executeTakeFirst();
    if (!syncState) {
        await db
            .insertInto("log_sync_state")
            .values({
                tenant_id: context.tenantId,
                log_id: context.logId,
                downloaded_head_version: 0,
                projected_head_version: 0,
                last_synced_at: null,
            })
            .execute();
    }
}

/** Last-used context persisted in OPFS (shared across tabs). Prefer getActiveContext(). */
export async function getPersistedActiveContext(): Promise<ActiveContext | null> {
    const row = await db
        .selectFrom("active_context")
        .selectAll()
        .where("id", "=", 1)
        .executeTakeFirst();
    return row
        ? {
              tenantId: row.tenant_id,
              principalId: row.principal_id,
              logId: row.log_id,
              ledgerOrigin: row.ledger_origin,
          }
        : null;
}

/**
 * This tab's active context. Session (tab-local) wins; OPFS last-used is cold-start fallback only.
 */
export async function getActiveContext(): Promise<ActiveContext | null> {
    return getSessionContext() ?? (await getPersistedActiveContext());
}

export async function requireActiveContext(): Promise<ActiveContext> {
    const session = getSessionContext();
    if (session) return session;

    const persisted = await getPersistedActiveContext();
    if (!persisted)
        throw new Error("Local Ledger context has not been initialized");

    // Hydrate this tab so subsequent work does not re-read a row another tab may overwrite.
    setSessionContext(persisted);
    return persisted;
}

export async function clearActiveContext(): Promise<void> {
    setSessionContext(null);
    await db.deleteFrom("active_context").where("id", "=", 1).execute();
}

/**
 * Migrates entity projection tables to composite (tenant_id, log_id, id) primary keys.
 * Existing rows are attributed to the provided context (or legacy-unassigned).
 * Schema version rebuild will re-project cleanly; this preserves offline data when possible.
 */
async function migrateEntityProjectionTables(
    context: SchemaMigrationContext | undefined,
    database: Kysely<Database>,
    approvedTables: ReadonlySet<string>,
): Promise<void> {
    const tenantId = context?.tenantId ?? "legacy-unassigned";
    const logId = context?.logId ?? "legacy-unassigned";

    for (const tableName of ENTITY_TABLE_NAMES) {
        if (!approvedTables.has(tableName)) continue;
        const exists = await sql<{ name: string }>`
            SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${tableName}
        `.execute(database);
        if (exists.rows.length === 0) continue;

        const typedCols = await sql<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
            pk: number;
        }>`
            PRAGMA table_info(${sql.raw(`"${tableName}"`)})
        `.execute(database);

        const hasTenant = typedCols.rows.some(
            (column) => column.name === "tenant_id",
        );
        const primaryKey = typedCols.rows
            .filter((column) => column.pk > 0)
            .sort((left, right) => left.pk - right.pk)
            .map((column) => column.name);
        if (hasTenant && primaryKey.join(",") === "tenant_id,log_id,id")
            continue;

        const dataColumns = typedCols.rows
            .map((column) => column.name)
            .filter((name) => name !== "tenant_id" && name !== "log_id");
        const scopedName = `${tableName}__scoped`;

        const bodyCols = typedCols.rows
            .filter((c) => c.name !== "tenant_id" && c.name !== "log_id")
            .map((c) => {
                if (c.name === "id") return '"id" TEXT NOT NULL';
                const notNull = c.notnull ? " NOT NULL" : "";
                const defaultValue = c.dflt_value?.trim();
                const normalizedDefault =
                    defaultValue &&
                    /^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(defaultValue)
                        ? `(${defaultValue})`
                        : defaultValue;
                const dflt =
                    normalizedDefault != null
                        ? ` DEFAULT ${normalizedDefault}`
                        : "";
                return `"${c.name}" ${c.type || "TEXT"}${notNull}${dflt}`;
            });

        await database.transaction().execute(async (tx) => {
            await sql`DROP TABLE IF EXISTS ${sql.raw(`"${scopedName}"`)}`.execute(
                tx,
            );
            await sql`
                CREATE TABLE ${sql.raw(`"${scopedName}"`)} (
                    "tenant_id" TEXT NOT NULL,
                    "log_id" TEXT NOT NULL,
                    ${sql.raw(bodyCols.join(", "))},
                    PRIMARY KEY ("tenant_id", "log_id", "id")
                )
            `.execute(tx);

            const insertList = ["tenant_id", "log_id", ...dataColumns]
                .map((name) => `"${name}"`)
                .join(", ");
            const selectList = [
                sql`${tenantId}`,
                sql`${logId}`,
                ...dataColumns.map((name) => sql.raw(`"${name}"`)),
            ];

            // Bind scope values; copy remaining columns by name.
            await sql`
                INSERT INTO ${sql.raw(`"${scopedName}"`)} (${sql.raw(insertList)})
                SELECT ${sql.join(selectList, sql`, `)}
                FROM ${sql.raw(`"${tableName}"`)}
            `.execute(tx);

            await sql`DROP TABLE ${sql.raw(`"${tableName}"`)}`.execute(tx);
            await sql`ALTER TABLE ${sql.raw(`"${scopedName}"`)} RENAME TO ${sql.raw(`"${tableName}"`)}`.execute(
                tx,
            );
        });
    }
}

/**
 * Migrates entity_type_definitions to composite (tenant_id, log_id, id) primary keys.
 * Name/table uniqueness becomes per-log rather than global.
 */
async function migrateEntityTypeDefinitionsTable(
    context: SchemaMigrationContext | undefined,
    database: Kysely<Database>,
): Promise<void> {
    const exists = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entity_type_definitions'
    `.execute(database);
    if (exists.rows.length === 0) return;

    const typedCols = await sql<{ name: string; pk: number }>`
        PRAGMA table_info(entity_type_definitions)
    `.execute(database);
    const hasTenant = typedCols.rows.some(
        (column) => column.name === "tenant_id",
    );
    const primaryKey = typedCols.rows
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);
    if (hasTenant && primaryKey.join(",") === "tenant_id,log_id,id") return;

    const tenantId = context?.tenantId ?? "legacy-unassigned";
    const logId = context?.logId ?? "legacy-unassigned";

    await database.transaction().execute(async (tx) => {
        await sql`DROP TABLE IF EXISTS entity_type_definitions_scoped`.execute(
            tx,
        );
        await sql`
            CREATE TABLE entity_type_definitions_scoped (
                tenant_id TEXT NOT NULL,
                log_id TEXT NOT NULL,
                id TEXT NOT NULL,
                name TEXT NOT NULL,
                display_name TEXT NOT NULL,
                table_name TEXT NOT NULL,
                fields_json TEXT NOT NULL,
                is_archived INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (tenant_id, log_id, id),
                UNIQUE (tenant_id, log_id, name),
                UNIQUE (tenant_id, log_id, table_name)
            )
        `.execute(tx);

        if (hasTenant) {
            await sql`
                INSERT INTO entity_type_definitions_scoped (
                    tenant_id, log_id, id, name, display_name, table_name,
                    fields_json, is_archived, created_at, updated_at
                )
                SELECT tenant_id, log_id, id, name, display_name, table_name,
                       fields_json, is_archived, created_at, updated_at
                FROM entity_type_definitions
            `.execute(tx);
        } else {
            await sql`
                INSERT INTO entity_type_definitions_scoped (
                    tenant_id, log_id, id, name, display_name, table_name,
                    fields_json, is_archived, created_at, updated_at
                )
                SELECT ${tenantId}, ${logId}, id, name, display_name, table_name,
                       fields_json, is_archived, created_at, updated_at
                FROM entity_type_definitions
            `.execute(tx);
        }

        await sql`DROP TABLE entity_type_definitions`.execute(tx);
        await sql`ALTER TABLE entity_type_definitions_scoped RENAME TO entity_type_definitions`.execute(
            tx,
        );
        await sql`
            CREATE INDEX IF NOT EXISTS idx_entity_type_definitions_scope_name
            ON entity_type_definitions (tenant_id, log_id, name)
        `.execute(tx);
    });
}
