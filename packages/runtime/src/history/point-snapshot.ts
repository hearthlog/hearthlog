import { sql, type Kysely } from 'kysely';
import { baselineVersion } from './baseline.js';
import { db, type Database } from '../db/index.js';
import { generateDynamicTableDDL } from '../db/dynamic-ddl.js';
import { getAllEntityDDL, getAllEntityIndexDDL } from '#generated/schema';
import { createProjectionConfigFromDynamic } from '../event/dynamic-entities.js';
import { materializeDynamicEntities } from '../event/dynamic-materializer.js';
import {
    buildBulkProjectionSQL,
    buildEntitySetProjectionSQL,
    PROJECTION_CONFIGS,
    qualifiedIdentifier,
    quoteIdentifier,
} from '../event/projection-builder.js';
import { completeActionBoundary } from './action-boundary.js';
import { EVENTS_EXCISED, WORKSPACE_RESTORED } from '@hearthlog/contracts/history/replay-selection';
import { filterRestoredSnapshot, hasReplayDirectives } from './legacy-replay.js';
import { entityRegistry } from '../event/registry.js';
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

type ProjectionConfigs = Awaited<ReturnType<typeof buildPointSnapshot>>['projectionConfigs'];
type SnapshotTable = { entity: string; table: string; fields: string[] };

const DEFINITION_TABLE: SnapshotTable = { entity: 'entity_type', table: 'entity_type_definitions',
    fields: ['name', 'display_name', 'table_name', 'fields_json', 'calendar_json', 'is_archived'] };

function snapshotTables(configs: ProjectionConfigs): SnapshotTable[] {
    return configs.map(config => ({ entity: config.entityName, table: config.tableName, fields: config.fields.map(field => field.name) }));
}

/** Compare two materialized states record by record and field by field, in SQLite. */
async function diffSnapshots(beforeSchema: string, afterSchema: string, tables: readonly SnapshotTable[]): Promise<HistoryRecord[]> {
    function snapshotRows(schema: string) {
        return sql.join(tables.map(table => sql`SELECT ${table.entity} || ':' || id AS key,
            json_object(${sql.join(table.fields.flatMap(field => [sql`${field}`, sql.ref(field)]))}) AS value
            FROM ${sql.raw(qualifiedIdentifier(schema, table.table))}`), sql` UNION ALL `);
    }
    const { rows } = await sql<{ key: string; label: string; kind: HistoryRecord['kind']; fields: string }>`
                WITH before_records AS (${snapshotRows(beforeSchema)}),
                after_records AS (${snapshotRows(afterSchema)}),
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
}

/**
 * What one action changed. Ordinary actions compare only the records they touched, projected just before and just
 * after the action, so the cost follows those records' history rather than the size of the log. Actions that change
 * which events replay or define record types take the full comparison of two workspace states.
 */
export async function readActionChanges(previousVersion: number, version: number, scope: ReadScope): Promise<HistoryRecord[]> {
    const touched = await readTouchedChanges(previousVersion, version, scope);
    return touched ?? readWorkspaceChanges(previousVersion, version, scope);
}

/** The full comparison: two complete workspace states, every record type. */
export async function readWorkspaceChanges(previousVersion: number, version: number, scope: ReadScope): Promise<HistoryRecord[]> {
    return withPointSnapshot(previousVersion, scope, async (beforeSchema, beforeConfigs) =>
        withPointSnapshot(version, scope, async (afterSchema) =>
            diffSnapshots(beforeSchema, afterSchema, [...snapshotTables(beforeConfigs), DEFINITION_TABLE])));
}

const FULL_COMPARISON_TYPES = new Set(['EVENT_TOMBSTONED', WORKSPACE_RESTORED, EVENTS_EXCISED]);

/** The touched-records comparison, or null when the action needs the full one. */
export async function readTouchedChanges(previousVersion: number, version: number, scope: ReadScope): Promise<HistoryRecord[] | null> {
    if (!Number.isSafeInteger(version) || !Number.isSafeInteger(previousVersion) || previousVersion < 0 || version <= previousVersion) return null;
    const members = await db.selectFrom('raw_events').select(['type', 'entity_id'])
        .where('tenant_id', '=', scope.tenantId).where('log_id', '=', scope.logId)
        .where('log_version', '>', previousVersion).where('log_version', '<=', version)
        .where('projection_state', 'in', ['effective', 'restored_out']).execute();
    if (members.length === 0 || members.some(member => FULL_COMPARISON_TYPES.has(member.type) || member.type.startsWith('ENTITY_TYPE_'))) return null;
    // A restore or removal anywhere before this point changes which earlier events replay.
    if (await hasReplayDirectives(db, scope, version)) return null;
    // The state before the action must be local: a snapshot folds away history below its version.
    if (previousVersion < await baselineVersion(scope)) return null;
    const byType = new Map<string, Set<string>>();
    for (const member of members) {
        const [type, uuid] = member.entity_id?.split(':') ?? [];
        if (!type || !uuid) return null;
        byType.set(type, (byType.get(type) ?? new Set()).add(member.entity_id!));
    }
    const configs = [...byType.keys()].map(type => entityRegistry[type]?.projection);
    if (configs.some(config => !config)) return null;
    const tables = configs.map(config => config!.tableName);
    const { rows: ddl } = await sql<{ name: string; sql: string }>`SELECT name, sql FROM main.sqlite_master
        WHERE type = 'table' AND name IN (SELECT value FROM json_each(${JSON.stringify(tables)}))`.execute(db);
    if (ddl.length !== tables.length) return null;

    const counter = (aliases.storPointSnapshotAliasCounter = (aliases.storPointSnapshotAliasCounter ?? 0) + 2);
    const before = `stor_point_${counter - 1}`;
    const after = `stor_point_${counter}`;
    await sql.raw(`ATTACH DATABASE ':memory:' AS ${quoteIdentifier(before)}`).execute(db);
    try {
        await sql.raw(`ATTACH DATABASE ':memory:' AS ${quoteIdentifier(after)}`).execute(db);
        try {
            for (const [schema, boundary] of [[before, previousVersion], [after, version]] as const) {
                for (const table of ddl) await sql.raw(qualifyTableDDL(table.sql, table.name, schema)).execute(db);
                for (const config of configs) {
                    await buildEntitySetProjectionSQL(config!, [...byType.get(config!.entityName)!], scope, {
                        boundary: { kind: 'log-version', version: boundary },
                        target: { schema },
                        source: { schema: 'main', table: 'projection_events' },
                    }).execute(db);
                }
            }
            return await diffSnapshots(before, after, snapshotTables(configs as ProjectionConfigs));
        } finally {
            await sql.raw(`DETACH DATABASE ${quoteIdentifier(after)}`).execute(db);
        }
    } finally {
        await sql.raw(`DETACH DATABASE ${quoteIdentifier(before)}`).execute(db);
    }
}

/** A table's stored CREATE TABLE statement, created in another attached schema. */
function qualifyTableDDL(statement: string, name: string, schema: string): string {
    const qualified = statement.replace(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w.]+)/i,
        `CREATE TABLE ${qualifiedIdentifier(schema, name)}`);
    if (qualified === statement) throw new Error(`Unrecognized table definition for ${name}`);
    return qualified;
}

async function withPointSnapshot<T>(version: number, scope: ReadScope,
    read: (schema: string, configs: Awaited<ReturnType<typeof buildPointSnapshot>>['projectionConfigs']) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('Invalid history version');
    // A snapshot folds away the history this comparison replays; loading it is an explicit choice (Load the archive).
    if (await baselineVersion(scope) > 0) throw new Error('Load the archive to compare this action with earlier history.');
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
