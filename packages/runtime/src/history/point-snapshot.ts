import { sql, type Kysely } from 'kysely';
import { db, type Database } from '../db/index.js';
import { generateDynamicTableDDL } from '../db/dynamic-ddl.js';
import { getAllEntityDDL, getAllEntityIndexDDL } from '#generated/schema';
import { createProjectionConfigFromDynamic } from '../event/dynamic-entities.js';
import { materializeDynamicEntities } from '../event/dynamic-materializer.js';
import {
    buildBulkProjectionSQL,
    PROJECTION_CONFIGS,
    qualifiedIdentifier,
    quoteIdentifier,
} from '../event/projection-builder.js';
import { completeActionBoundary } from './action-boundary.js';
import { EVENTS_EXCISED, WORKSPACE_RESTORED } from '@hearthlog/contracts/history/replay-selection';
import { filterRestoredSnapshot } from './legacy-replay.js';
import type { DynamicFieldDefinition } from '../event/meta-entity-types.js';
import type { ReadScope } from '../db/read-session.js';
import type { HistoryRecord } from './contracts.js';

const STAGED_EVENTS_TABLE = '__stor_effective_events';
const aliases = globalThis as typeof globalThis & { storPointSnapshotAliasCounter?: number };

/** Parse staged dynamic field JSON; a malformed row fails the snapshot. */
function parseDefinitionFields(fieldsJson: string): DynamicFieldDefinition[] {
    try {
        const parsed: unknown = JSON.parse(fieldsJson);
        if (Array.isArray(parsed)) return parsed as DynamicFieldDefinition[];
    } catch {
        // Fall through to the typed error below.
    }
    throw new Error('point-snapshot-invalid-dynamic-fields');
}

export interface WorkspaceRecord {
    key: string;
    label: string;
    value: Record<string, unknown>;
}

/** Build one accepted prefix for a Log history comparison, then release it. */
export async function readWorkspaceSnapshot(version: number, scope: ReadScope): Promise<WorkspaceRecord[]> {
    return withPointSnapshot(version, scope, async (schema, projectionConfigs) => {
        const records: WorkspaceRecord[] = [];
        for (const config of projectionConfigs) {
            const result = await sql<Record<string, unknown>>`SELECT * FROM ${sql.raw(qualifiedIdentifier(schema, config.tableName))}`.execute(db);
            for (const row of result.rows) {
                const { tenant_id: _tenant, log_id: _log, ...value } = row;
                records.push({ key: `${config.entityName}:${String(row.id)}`, label: String(row.title ?? row.name ?? row.id), value });
            }
        }
        const definitions = await sql<Record<string, unknown>>`SELECT * FROM ${sql.raw(qualifiedIdentifier(schema, 'entity_type_definitions'))}`.execute(db);
        for (const row of definitions.rows) {
            const { tenant_id: _tenant, log_id: _log, ...value } = row;
            records.push({ key: `entity_type:${String(row.id)}`, label: String(row.display_name ?? row.name ?? row.id), value });
        }
        return records.sort((a, b) => a.key.localeCompare(b.key));
    });
}

/** Keep both materialized prefixes leased while SQLite compares records and fields. */
export async function readActionChanges(previousVersion: number, version: number, scope: ReadScope): Promise<HistoryRecord[]> {
    return withPointSnapshot(previousVersion, scope, async (beforeSchema, beforeConfigs) =>
        withPointSnapshot(version, scope, async (afterSchema, afterConfigs) => {
            function snapshotRows(schema: string, configs: typeof beforeConfigs) {
                const tables = [...configs.map(config => ({ entity: config.entityName, table: config.tableName,
                    fields: config.fields.map(field => field.name) })),
                    { entity: 'entity_type', table: 'entity_type_definitions',
                        fields: ['name', 'display_name', 'table_name', 'fields_json', 'calendar_json', 'is_archived'] }];
                return sql.join(tables.map(table => sql`SELECT ${table.entity} || ':' || id AS key,
                    json_object(${sql.join(table.fields.flatMap(field => [sql`${field}`, sql.ref(field)]))}) AS value
                    FROM ${sql.raw(qualifiedIdentifier(schema, table.table))}`), sql` UNION ALL `);
            }
            const { rows } = await sql<{ key: string; label: string; kind: HistoryRecord['kind']; fields: string }>`
                WITH before_records AS (${snapshotRows(beforeSchema, beforeConfigs)}),
                after_records AS (${snapshotRows(afterSchema, afterConfigs)}),
                keys AS (SELECT key FROM before_records UNION SELECT key FROM after_records),
                changes AS (
                    SELECT keys.key, b.value AS before_value, a.value AS after_value,
                        CASE WHEN b.key IS NULL THEN 'added' WHEN a.key IS NULL THEN 'removed' ELSE 'changed' END AS kind,
                        (SELECT json_group_array(json_object('key', field, 'label', replace(field, '_', ' '),
                            'before', json_extract(b.value, '$.' || field), 'after', json_extract(a.value, '$.' || field)))
                         FROM (SELECT key AS field FROM json_each(b.value) UNION SELECT key FROM json_each(a.value))
                         WHERE json_extract(b.value, '$.' || field) IS NOT json_extract(a.value, '$.' || field)
                         ORDER BY field) AS fields
                    FROM keys LEFT JOIN before_records b ON b.key = keys.key LEFT JOIN after_records a ON a.key = keys.key
                ) SELECT key, kind, fields,
                    COALESCE(json_extract(after_value, '$.title'), json_extract(after_value, '$.name'), json_extract(after_value, '$.number'),
                        json_extract(before_value, '$.title'), json_extract(before_value, '$.name'), json_extract(before_value, '$.number'), key) AS label
                FROM changes WHERE kind != 'changed' OR json_array_length(fields) > 0 ORDER BY key
            `.execute(db);
            return rows.map(row => ({ ...row, fields: JSON.parse(row.fields) }));
        }));
}

async function withPointSnapshot<T>(version: number, scope: ReadScope,
    read: (schema: string, configs: Awaited<ReturnType<typeof buildPointSnapshot>>['projectionConfigs']) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('Invalid history version');
    const head = await downloadedHead(scope);
    if (version > (head ?? 0)) throw new Error('Download this log before inspecting its history');
    if (version > 0) {
        const boundary = await db.selectFrom('raw_events').select('id')
            .where('tenant_id', '=', scope.tenantId).where('log_id', '=', scope.logId)
            .where('log_version', '=', version).where('projection_state', 'in', ['effective', 'restored_out'])
            .where(completeActionBoundary).executeTakeFirst();
        if (!boundary) throw new Error('Choose a complete accepted action');
    }

    const schema = `stor_point_${aliases.storPointSnapshotAliasCounter = (aliases.storPointSnapshotAliasCounter ?? 0) + 1}`;
    await sql.raw(`ATTACH DATABASE ':memory:' AS ${quoteIdentifier(schema)}`).execute(db);
    try {
        const { projectionConfigs, knownEventTypes } = await buildPointSnapshot(schema, scope, version);
        const types = await sql<{ type: string }>`
            SELECT DISTINCT type FROM ${sql.raw(qualifiedIdentifier(schema, STAGED_EVENTS_TABLE))}
        `.execute(db);
        const unknown = types.rows.filter(row => !knownEventTypes.has(row.type));
        if (unknown.length) throw new Error(`Cannot inspect unrecognized event types: ${unknown.map(row => row.type).join(', ')}`);

        return await read(schema, projectionConfigs);
    } finally {
        await sql.raw(`DETACH DATABASE ${quoteIdentifier(schema)}`).execute(db);
    }
}

async function buildPointSnapshot(schema: string, scope: ReadScope, version: number) {
    return db.transaction().execute(async (tx) => {
        for (const ddl of getAllEntityDDL().map(statement => qualifyGeneratedDDL(statement, schema))) {
            await sql.raw(ddl).execute(tx);
        }
        for (const ddl of getAllEntityIndexDDL().map(statement => qualifyGeneratedDDL(statement, schema))) {
            await sql.raw(ddl).execute(tx);
        }
        await sql.raw(entityTypeDefinitionsDDL(schema)).execute(tx);
        await stageAcceptedPrefix(tx, schema, scope, version);

        const dynamic = await materializeDynamicEntities({
            database: tx,
            schema,
            scope,
            registerLive: false,
            sourceTable: STAGED_EVENTS_TABLE,
        });
        for (const record of dynamic.records.filter(record => record.is_archived)) {
            await sql.raw(generateDynamicTableDDL(record, schema)).execute(tx);
            dynamic.activeProjectionConfigs.push(createProjectionConfigFromDynamic(
                record.name, record.table_name, parseDefinitionFields(record.fields_json),
            ));
        }
        const projectionConfigs = [...Object.values(PROJECTION_CONFIGS), ...dynamic.activeProjectionConfigs];
        const projectionOptions = {
            target: { schema },
            source: { schema, table: STAGED_EVENTS_TABLE, staged: true },
        } as const;
        for (const config of projectionConfigs) {
            await buildBulkProjectionSQL(config, scope, projectionOptions).execute(tx);
        }
        const knownEventTypes = new Set([
            'EVENT_TOMBSTONED', WORKSPACE_RESTORED, EVENTS_EXCISED,
            'ENTITY_TYPE_DEFINED', 'ENTITY_TYPE_UPDATED', 'ENTITY_TYPE_ARCHIVED',
            ...projectionConfigs.flatMap(config => config.eventTypes),
            ...dynamic.records.flatMap(record => createProjectionConfigFromDynamic(
                record.name, record.table_name, parseDefinitionFields(record.fields_json),
            ).eventTypes),
        ]);
        return { projectionConfigs, knownEventTypes };
    });
}

async function stageAcceptedPrefix(database: Kysely<Database>, schema: string, scope: ReadScope, version: number): Promise<void> {
    const staged = qualifiedIdentifier(schema, STAGED_EVENTS_TABLE);
    await sql`
        CREATE TABLE ${sql.raw(staged)} AS
        SELECT * FROM main.raw_events
        WHERE tenant_id = ${scope.tenantId}
          AND log_id = ${scope.logId}
          AND projection_state IN ('effective', 'restored_out')
          AND log_version IS NOT NULL
          AND log_version <= ${version}
    `.execute(database);
    // Old restore/removal facts in the prefix still affect its projected state.
    await filterRestoredSnapshot(database, staged, version);
    const indexSchema = quoteIdentifier(schema);
    await sql.raw(`CREATE INDEX ${indexSchema}."idx_stor_history_type" ON "${STAGED_EVENTS_TABLE}" ("type")`).execute(database);
    await sql.raw(`CREATE INDEX ${indexSchema}."idx_stor_history_entity" ON "${STAGED_EVENTS_TABLE}" ("entity_id", "entity_version")`).execute(database);
    await sql.raw(`CREATE INDEX ${indexSchema}."idx_stor_history_version" ON "${STAGED_EVENTS_TABLE}" ("log_version")`).execute(database);
}

function qualifyGeneratedDDL(statement: string, schema: string): string {
    const qualifiedSchema = quoteIdentifier(schema);
    return statement.replace(
        /^(\s*CREATE TABLE IF NOT EXISTS )"([^"]+)"/,
        `$1${qualifiedSchema}."$2"`,
    ).replace(
        /^(\s*CREATE (?:UNIQUE )?INDEX IF NOT EXISTS )"([^"]+)"/,
        `$1${qualifiedSchema}."$2"`,
    );
}

async function downloadedHead(scope: ReadScope): Promise<number | null> {
    const syncState = await db.selectFrom('log_sync_state').select('downloaded_head_version')
        .where('tenant_id', '=', scope.tenantId).where('log_id', '=', scope.logId).executeTakeFirst();
    if (syncState) return syncState.downloaded_head_version;
    const available = await db.selectFrom('raw_events')
        .select(({ fn }) => fn.max('log_version').as('head'))
        .where('tenant_id', '=', scope.tenantId).where('log_id', '=', scope.logId)
        .where('projection_state', 'in', ['effective', 'restored_out'])
        .where('log_version', 'is not', null).executeTakeFirst();
    return available?.head == null ? null : Number(available.head);
}

function entityTypeDefinitionsDDL(schema: string): string {
    return `
        CREATE TABLE ${qualifiedIdentifier(schema, 'entity_type_definitions')} (
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
        )
    `;
}
