/**
 * Projection Builder - SQL factory utilities for event sourcing projections
 *
 * Generates consistent CTE-based SQL for materializing entity state from raw_events.
 * Eliminates duplication across entity projectors and rebuild functions.
 *
 * Projection is always scoped by explicit tenant/log — never via ambient active_context.
 */

import { sql, type RawBuilder, type Transaction } from 'kysely';
import type { ActiveContext, Database } from '../db/index.js';
import { requireActiveContext } from '../db/index.js';

/**
 * Configuration for an entity field projection
 */
export interface FieldConfig {
    /** Column name in the target table */
    name: string;
    /** Key in the event payload JSON */
    payloadKey: string;
    /** SQL type cast (e.g., 'REAL', 'INTEGER') */
    cast?: string;
    /** Default value if null */
    default?: string | number | null;
}

/**
 * Configuration for projecting an entity type from events
 */
export interface EntityProjectionConfig {
    /** Entity name (e.g., 'calendar_event') */
    entityName: string;
    /** Target table name (e.g., 'calendar_events') */
    tableName: string;
    /** Entity ID field alias in CTEs (e.g., 'asset_id', 'tx_id') */
    entityIdAlias: string;
    /** Event types to include in projection */
    eventTypes: string[];
    /** The 'removed' event type that marks entity deletion */
    removedEventType: string;
    /** Fields to project from event payload */
    fields: FieldConfig[];
}

export type ProjectionBoundary =
    | { kind: 'current' }
    | { kind: 'log-version'; version: number };

export interface ProjectionTarget {
    schema?: string;
}

export interface ProjectionSource {
    schema?: string;
    table: string;
    /** A staged snapshot source has already applied scope, boundary, and tombstones. */
    staged?: boolean;
}

export interface ProjectionBuildOptions {
    boundary?: ProjectionBoundary;
    target?: ProjectionTarget;
    source?: ProjectionSource;
}

/** Quote a SQLite identifier. Values are never accepted as identifiers. */
export function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

export function qualifiedIdentifier(schema: string | undefined, name: string): string {
    return schema
        ? `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`
        : quoteIdentifier(name);
}

/**
 * Builds the field extraction expressions for the entity_events CTE. Each
 * field also records whether the payload names it: an explicit null clears a
 * value, while an omitted key leaves it unchanged.
 */
function buildFieldExtractions(fields: FieldConfig[]): string {
    return fields
        .map(f => `json_extract(payload, '$.${f.payloadKey}') AS ${f.name},
                    json_type(payload, '$.${f.payloadKey}') IS NOT NULL AS ${presenceColumn(f)}`)
        .join(',\n                    ');
}

function presenceColumn(field: FieldConfig): string {
    return `__present_${field.name}`;
}

/**
 * Builds the FIRST_VALUE window function expressions for the 'w' CTE
 */
function buildWindowFunctions(fields: FieldConfig[], entityIdAlias: string): string {
    return fields
        .map(f => `
                    FIRST_VALUE(${f.name}) OVER (
                        PARTITION BY ${entityIdAlias}
                        ORDER BY ${presenceColumn(f)} DESC, (entity_version IS NULL) DESC, entity_version DESC, local_sequence DESC, timestamp DESC, id DESC
                        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
                    ) AS final_${f.name}`)
        .join(',');
}

/**
 * Builds the final SELECT field expressions with type casting and defaults
 */
function buildFinalFields(fields: FieldConfig[]): string {
    return fields
        .map(f => {
            let expr = `final_${f.name}`;
            if (f.cast) {
                expr = `CAST(${expr} AS ${f.cast})`;
            }
            if (f.default !== undefined && f.default !== null) {
                // SQL expressions (containing parentheses) should not be quoted
                // Plain string literals should be quoted
                const isSqlExpression = typeof f.default === 'string' && f.default.includes('(');
                const deterministicTimeDefault = f.default === "date('now')"
                    ? "date(created_ts/1000, 'unixepoch')"
                    : f.default === "datetime('now')"
                        ? "datetime(created_ts/1000, 'unixepoch')"
                        : null;
                const defaultVal = deterministicTimeDefault ?? (
                    typeof f.default === 'string' && !isSqlExpression
                        ? `'${f.default.replace(/'/g, "''")}'`
                        : f.default
                );
                expr = `COALESCE(${expr}, ${defaultVal})`;
            }
            return `${expr} AS ${f.name}`;
        })
        .join(',\n                    ');
}

/**
 * Builds the INSERT column list and final SELECT column list (scoped projection rows)
 */
function buildColumnLists(fields: FieldConfig[]): { insertCols: string; selectCols: string } {
    const fieldNames = fields.map(f => f.name);
    return {
        insertCols: ['tenant_id', 'log_id', 'id', ...fieldNames, 'created_at', 'updated_at'].join(', '),
        selectCols: [
            'tenant_id',
            'log_id',
            'id',
            ...fieldNames,
            "datetime(created_ts/1000, 'unixepoch') AS created_at",
            "datetime(updated_ts/1000, 'unixepoch') AS updated_at",
        ].join(', '),
    };
}

/**
 * Generates the common CTE prefix filtered by explicit tenant/log.
 */
function buildCommonCTEs(
    tenantId: string,
    logId: string,
    options: ProjectionBuildOptions,
): RawBuilder<unknown> {
    const source = options.source ?? { schema: 'main', table: 'projection_events' };
    const sourceTable = sql.raw(qualifiedIdentifier(source.schema, source.table));

    if (source.staged) {
        return sql`WITH effective AS (SELECT events.* FROM ${sourceTable} events)`;
    }

    const boundary = options.boundary ?? { kind: 'current' as const };
    if (boundary.kind === 'current') {
        return sql`
            WITH effective AS (
                SELECT events.*
                FROM ${sourceTable} events
                WHERE events.is_tombstoned = 0
                  AND events.projection_state = 'effective'
                  AND events.tenant_id = ${tenantId}
                  AND events.log_id = ${logId}
            )`;
    }

    return sql`
        WITH bounded AS (
            SELECT events.*
            FROM ${sourceTable} events
            WHERE events.projection_state = 'effective'
              AND events.tenant_id = ${tenantId}
              AND events.log_id = ${logId}
              AND events.log_version IS NOT NULL
              AND events.log_version <= ${boundary.version}
        ),
        temporal_tombstones AS (
            SELECT json_extract(payload, '$.eventId') AS target_event_id
            FROM bounded
            WHERE type = 'EVENT_TOMBSTONED'
        ),
        effective AS (
            SELECT events.*
            FROM bounded events
            WHERE NOT EXISTS (
                SELECT 1
                FROM temporal_tombstones tombstones
                WHERE tombstones.target_event_id = events.id
            )
        )`;
}

function buildProjectionSQL(
    config: EntityProjectionConfig,
    context: Pick<ActiveContext, 'tenantId' | 'logId'>,
    options: ProjectionBuildOptions,
    entityId?: string | readonly string[],
): RawBuilder<unknown> {
    const { tableName, entityIdAlias, eventTypes, removedEventType, fields } = config;
    const { insertCols, selectCols } = buildColumnLists(fields);
    const fieldExtractions = buildFieldExtractions(fields);
    const windowFunctions = buildWindowFunctions(fields, entityIdAlias);
    const finalFields = buildFinalFields(fields);
    const eventTypeValues = eventTypes.map((eventType) => sql`${eventType}`);
    const entityFilter = entityId === undefined
        ? sql``
        : typeof entityId === 'string'
            ? sql`AND entity_id = ${entityId}`
            : sql`AND entity_id IN (${sql.join(entityId)})`;
    const targetTable = sql.raw(qualifiedIdentifier(options.target?.schema, tableName));

    return sql`
        INSERT INTO ${targetTable} (${sql.raw(insertCols)})
        ${buildCommonCTEs(context.tenantId, context.logId, options)},
        entity_events AS (
            SELECT
                id,
                type,
                timestamp,
                entity_version,
                local_sequence,
                json_extract(payload, '$.id') AS ${sql.raw(entityIdAlias)},
                ${sql.raw(fieldExtractions)}
            FROM effective
            WHERE type IN (${sql.join(eventTypeValues, sql`, `)})
              ${entityFilter}
        ),
        w AS (
            SELECT
                *,
                MIN(timestamp) OVER (PARTITION BY ${sql.raw(entityIdAlias)}) AS created_ts,${sql.raw(windowFunctions)},
                ROW_NUMBER() OVER (
                    PARTITION BY ${sql.raw(entityIdAlias)}
                    ORDER BY (entity_version IS NULL) DESC, entity_version DESC, local_sequence DESC, timestamp DESC, id DESC
                ) AS rn
            FROM entity_events
        ),
        final AS (
            SELECT
                ${context.tenantId} AS tenant_id,
                ${context.logId} AS log_id,
                ${sql.raw(entityIdAlias)} AS id,
                ${sql.raw(finalFields)},
                type,
                created_ts,
                timestamp AS updated_ts
            FROM w
            WHERE rn = 1
        )
        SELECT ${sql.raw(selectCols)}
        FROM final
        WHERE type <> ${removedEventType}
    `;
}

/**
 * Generates a projection SQL query for a single entity
 * Used when projecting after a single event
 */
export function buildSingleEntityProjectionSQL(
    config: EntityProjectionConfig,
    entityId: string,
    context: Pick<ActiveContext, 'tenantId' | 'logId'>,
    options: ProjectionBuildOptions = {},
): RawBuilder<unknown> {
    return buildProjectionSQL(config, context, options, entityId);
}

/**
 * Generates a projection SQL query for all entities of a type
 * Used during full rebuild
 */
export function buildBulkProjectionSQL(
    config: EntityProjectionConfig,
    context: Pick<ActiveContext, 'tenantId' | 'logId'>,
    options: ProjectionBuildOptions = {},
): RawBuilder<unknown> {
    return buildProjectionSQL(config, context, options);
}

/** Reproject a bounded affected set without touching other records of the type. */
export async function projectEntitySet(
    config: EntityProjectionConfig,
    entityIds: readonly string[],
    tx: Transaction<Database>,
    context: Pick<ActiveContext, 'tenantId' | 'logId'>,
): Promise<void> {
    if (entityIds.length === 0) return;
    await tx.deleteFrom(config.tableName as keyof Database)
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('id', 'in', entityIds.map(entityId => entityId.split(':')[1]))
        .execute();
    await buildProjectionSQL(config, context, {}, entityIds).execute(tx);
}

/**
 * Creates an entity projector function from configuration
 * Returns a function that can be used to project a single event to the read model
 */
export function createEntityProjector(config: EntityProjectionConfig) {
    return async function projectEvent(
        event: { payload: { id: string } },
        tx: Transaction<Database>,
        entityIdOverride?: string,
        context?: Pick<ActiveContext, 'tenantId' | 'logId'>,
    ): Promise<void> {
        const id = event.payload.id;
        // If an explicit entity ID is provided (e.g. from the event envelope), use it.
        // Otherwise, construct it from the config and payload ID.
        // This ensures consistency between what's in raw_events and what we query for.
        const fullEntityId = entityIdOverride || `${config.entityName}:${id}`;
        const scope = context ?? await requireActiveContext();

        // Delete existing entry for this scope + entity id
        await tx.deleteFrom(config.tableName as keyof Database)
            .where('tenant_id', '=', scope.tenantId)
            .where('log_id', '=', scope.logId)
            .where('id', '=', id)
            .execute();

        // Rebuild from events using the full entity ID to find matching events
        const query = buildSingleEntityProjectionSQL(config, fullEntityId, scope);
        await query.execute(tx);
    };
}

// ============================================================================
// Entity Definition to Projection Config Conversion
// ============================================================================

import {
    ENTITY_DEFINITIONS,
    getEventTypes,
    getPayloadKey,
    type EntityDefinition,
    type EntityFieldDefinition,
} from '@hearthlog/contracts/event/entity-definitions';

/**
 * Converts an EntityDefinition to an EntityProjectionConfig
 */
export function createProjectionConfigFromDefinition(def: EntityDefinition): EntityProjectionConfig {
    const eventTypes = getEventTypes(def);

    return {
        entityName: def.name,
        tableName: def.table,
        entityIdAlias: `${def.name}_id`,
        eventTypes: eventTypes,
        removedEventType: eventTypes[2], // REMOVED event
        fields: def.fields.map((field: EntityFieldDefinition) => ({
            name: field.name,
            payloadKey: getPayloadKey(field),
            cast: field.type === 'number' ? 'REAL' : undefined,
            default: field.default,
        })),
    };
}

/**
 * Auto-generated projection configs from ENTITY_DEFINITIONS
 */
export const PROJECTION_CONFIGS: Record<string, EntityProjectionConfig> = Object.fromEntries(
    ENTITY_DEFINITIONS.map(def => [def.name, createProjectionConfigFromDefinition(def)])
);
