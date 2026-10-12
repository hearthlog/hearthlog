/**
 * Dynamic Entities
 *
 * Runtime management of dynamic entity types.
 * Handles loading, registering, and creating dynamic entities.
 *
 * Definitions are projected per (tenant_id, log_id) — the same scope as the
 * events that create them — so multi-log / multi-tab work cannot clobber catalogs.
 */

import { db, requireActiveContext, type ActiveContext } from '../db/index.js';
import {
    registerDynamicEntity,
    clearDynamicRegistry,
    isStaticEntity,
    type EntityRegistryEntry
} from './registry.js';
import {
    type EntityProjectionConfig,
    type FieldConfig,
} from './projection-builder.js';
import { generateDynamicTableDDL, generateAddColumnDDL, type EntityTypeRecord } from '../db/dynamic-ddl.js';
import type { DynamicFieldDefinition } from './meta-entity-types.js';
import {
    parseCalendarConfig,
    sanitizeCalendarSource,
    serializeCalendarConfig,
    validateCalendarConfig,
    type EntityCalendarSource,
} from '@hearthlog/contracts/calendar/config';
import { sql } from 'kysely';
import { tenant } from '@hearthlog/contracts/tenant/config';

// ============================================================================
// Types
// ============================================================================

export type { EntityTypeRecord } from '../db/dynamic-ddl.js';

// ============================================================================
// Loading & Registration
// ============================================================================

/**
 * Load dynamic entity types for the active tab log and register them.
 * Called on app initialization and after log context is ready.
 */
export async function loadDynamicEntityTypes(): Promise<void> {
    console.log('[DynamicEntities] Loading dynamic entity types...');

    // Clear existing dynamic registrations (tab-local registry)
    clearDynamicRegistry();

    if (!tenant.dynamicEntities) {
        console.log('[DynamicEntities] Dynamic entities are disabled for this tenant');
        return;
    }

    let context: ActiveContext;
    try {
        context = await requireActiveContext();
    } catch {
        console.log('[DynamicEntities] No active log context yet — skipping definition load');
        return;
    }

    // Load only this log's definitions
    const records = await db
        .selectFrom('entity_type_definitions')
        .selectAll()
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('is_archived', '=', 0)
        .execute();

    console.log(`[DynamicEntities] Found ${records.length} dynamic entity types for log ${context.logId}`);

    for (const record of records) {
        // Skip if a static entity with the same name exists
        if (isStaticEntity(record.name)) {
            console.log(`[DynamicEntities] Skipping "${record.name}" - shadowed by static entity`);
            continue;
        }

        try {
            await registerDynamicEntityFromRecord(record);
        } catch (error) {
            console.error(`[DynamicEntities] Failed to register "${record.name}":`, error);
        }
    }

    console.log('[DynamicEntities] Dynamic entity types loaded');
}

/**
 * Register a dynamic entity from a database record.
 */
async function registerDynamicEntityFromRecord(record: EntityTypeRecord): Promise<void> {
    const fields = parseEntityFields(record);

    // Ensure the table exists
    await ensureDynamicTable(record);

    // Create projection config
    const projection = createProjectionConfigFromDynamic(record.name, record.table_name, fields);

    // Create registry entry
    const entry: EntityRegistryEntry = {
        projection,
        eventPrefix: record.name.toUpperCase() + '_',
        table: record.table_name,
        isDynamic: true,
        calendar: parseCalendarConfig(record.calendar_json),
    };

    registerDynamicEntity(record.name, entry);
}

/**
 * Create a projection config from dynamic field definitions
 */
export function createProjectionConfigFromDynamic(
    entityName: string,
    tableName: string,
    fields: DynamicFieldDefinition[]
): EntityProjectionConfig {
    const eventPrefix = entityName.toUpperCase() + '_';

    return {
        entityName,
        tableName,
        entityIdAlias: `${entityName}_id`,
        eventTypes: [
            `${eventPrefix}ADDED`,
            `${eventPrefix}UPDATED`,
            `${eventPrefix}REMOVED`,
        ],
        removedEventType: `${eventPrefix}REMOVED`,
        fields: fields.map((f): FieldConfig => ({
            name: f.name,
            payloadKey: f.payloadKey,
            cast: f.type === 'number' ? 'REAL' :
                f.type === 'boolean' ? 'INTEGER' :
                    undefined,
            default: f.default as string | number | null | undefined,
        })),
    };
}

// ============================================================================
// Table Management
// ============================================================================

/**
 * Ensure a dynamic entity table exists, creating it if necessary.
 * Migrates legacy unscoped tables to (tenant_id, log_id, id) primary keys.
 */
async function ensureDynamicTable(record: EntityTypeRecord): Promise<void> {
    const ddl = generateDynamicTableDDL(record);
    console.log(`[DynamicEntities] Ensuring table "${record.table_name}" exists`);

    await sql.raw(ddl).execute(db);
    await migrateDynamicTableToScoped(record.table_name, {
        tenantId: record.tenant_id,
        logId: record.log_id,
    });
}

async function migrateDynamicTableToScoped(
    tableName: string,
    scope?: { tenantId: string; logId: string },
): Promise<void> {
    const typedCols = await sql<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>`
        PRAGMA table_info(${sql.raw(`"${tableName.replace(/"/g, '""')}"`)})
    `.execute(db);

    if (typedCols.rows.length === 0) return;

    const hasTenant = typedCols.rows.some((column) => column.name === 'tenant_id');
    const primaryKey = typedCols.rows
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);
    if (hasTenant && primaryKey.join(',') === 'tenant_id,log_id,id') return;

    let tenantId = scope?.tenantId ?? 'legacy-unassigned';
    let logId = scope?.logId ?? 'legacy-unassigned';
    if (!scope) {
        try {
            const context = await requireActiveContext();
            tenantId = context.tenantId;
            logId = context.logId;
        } catch {
            // Cold start before context — attribute legacy rows as unassigned
        }
    }

    const dataColumns = typedCols.rows
        .map((column) => column.name)
        .filter((name) => name !== 'tenant_id' && name !== 'log_id');
    const scopedName = `${tableName}__scoped`;
    const bodyCols = typedCols.rows
        .filter((c) => c.name !== 'tenant_id' && c.name !== 'log_id')
        .map((c) => {
            if (c.name === 'id') return '"id" TEXT NOT NULL';
            const notNull = c.notnull ? ' NOT NULL' : '';
            const dflt = c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : '';
            return `"${c.name}" ${c.type || 'TEXT'}${notNull}${dflt}`;
        });

    await db.transaction().execute(async (tx) => {
        await sql`DROP TABLE IF EXISTS ${sql.raw(`"${scopedName}"`)}`.execute(tx);
        await sql`
            CREATE TABLE ${sql.raw(`"${scopedName}"`)} (
                "tenant_id" TEXT NOT NULL,
                "log_id" TEXT NOT NULL,
                ${sql.raw(bodyCols.join(', '))},
                PRIMARY KEY ("tenant_id", "log_id", "id")
            )
        `.execute(tx);

        const insertList = ['tenant_id', 'log_id', ...dataColumns]
            .map((name) => `"${name}"`)
            .join(', ');
        const selectList = [
            sql`${tenantId}`,
            sql`${logId}`,
            ...dataColumns.map((name) => sql.raw(`"${name}"`)),
        ];

        await sql`
            INSERT INTO ${sql.raw(`"${scopedName}"`)} (${sql.raw(insertList)})
            SELECT ${sql.join(selectList, sql`, `)}
            FROM ${sql.raw(`"${tableName}"`)}
        `.execute(tx);

        await sql`DROP TABLE ${sql.raw(`"${tableName}"`)}`.execute(tx);
        await sql`ALTER TABLE ${sql.raw(`"${scopedName}"`)} RENAME TO ${sql.raw(`"${tableName}"`)}`.execute(tx);
    });
}

/**
 * Add a new column to a dynamic entity table.
 */
export async function addColumnToDynamicTable(
    tableName: string,
    field: DynamicFieldDefinition
): Promise<void> {
    const ddl = generateAddColumnDDL(tableName, field);
    console.log(`[DynamicEntities] Adding column "${field.name}" to "${tableName}"`);

    await sql.raw(ddl).execute(db);
}

// ============================================================================
// CRUD Helpers
// ============================================================================

/**
 * Get a dynamic entity type record by name for the active log.
 */
export async function getDynamicEntityDefinition(name: string): Promise<EntityTypeRecord | null> {
    const context = await requireActiveContext();
    const record = await db
        .selectFrom('entity_type_definitions')
        .selectAll()
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('name', '=', name)
        .where('is_archived', '=', 0)
        .executeTakeFirst();

    return record || null;
}

/**
 * Get all dynamic entity type records for the active log (non-archived).
 */
export async function getAllDynamicEntityDefinitions(): Promise<EntityTypeRecord[]> {
    const context = await requireActiveContext();
    return db
        .selectFrom('entity_type_definitions')
        .selectAll()
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('is_archived', '=', 0)
        .execute();
}

/**
 * Get parsed fields for a dynamic entity type
 */
export function parseEntityFields(
    record: Pick<EntityTypeRecord, 'name' | 'fields_json'>,
): DynamicFieldDefinition[] {
    try {
        const parsed: unknown = JSON.parse(record.fields_json);
        if (Array.isArray(parsed)) return parsed as DynamicFieldDefinition[];
    } catch {
        // Fall through to the diagnostic below.
    }
    console.error(`[DynamicEntities] Malformed field definitions for "${record.name}"`);
    return [];
}

/**
 * Validate a calendar config from a meta event against the entity's fields.
 * Invalid configs are dropped with a warning (the meta-event validator rejects
 * structurally invalid payloads before they reach here). Dynamic entities may
 * not declare parent joins in the first release.
 */
function validatedCalendarJson(
    entityName: string,
    calendar: EntityCalendarSource[] | null | undefined,
    fields: readonly DynamicFieldDefinition[],
): string | null {
    if (calendar === undefined || calendar === null || calendar.length === 0) {
        return null;
    }
    const sources: EntityCalendarSource[] = [];
    for (const entry of calendar) {
        const source = sanitizeCalendarSource(entry);
        if (!source) {
            console.warn(
                `[DynamicEntities] Ignoring malformed calendar source for "${entityName}"`,
            );
            return null;
        }
        sources.push(source);
    }
    const errors = validateCalendarConfig(entityName, sources, fields, {
        parentTables: new Set<string>(),
    });
    if (errors.length > 0) {
        console.warn(
            `[DynamicEntities] Ignoring invalid calendar config for "${entityName}":`,
            errors.join('; '),
        );
        return null;
    }
    return serializeCalendarConfig(sources);
}

// ============================================================================
// Event Handling
// ============================================================================

/**
 * Handle ENTITY_TYPE_DEFINED event.
 * Creates the database record and table for the active log scope.
 */
export async function handleEntityTypeDefined(
    payload: {
        id: string;
        name: string;
        displayName: string;
        tableName: string;
        fields: DynamicFieldDefinition[];
        calendar?: EntityCalendarSource[];
    }
): Promise<void> {
    console.log(`[DynamicEntities] Defining entity type: ${payload.name}`);
    const context = await requireActiveContext();

    // Check if static entity exists with same name
    if (isStaticEntity(payload.name)) {
        console.warn(`[DynamicEntities] Cannot create "${payload.name}" - conflicts with static entity`);
        return;
    }

    const calendarJson = validatedCalendarJson(payload.name, payload.calendar, payload.fields);

    // Insert into database scoped to this log
    await db
        .insertInto('entity_type_definitions')
        .values({
            tenant_id: context.tenantId,
            log_id: context.logId,
            id: payload.id,
            name: payload.name,
            display_name: payload.displayName,
            table_name: payload.tableName,
            fields_json: JSON.stringify(payload.fields),
            calendar_json: calendarJson,
            is_archived: 0,
        })
        .onConflict((c) => c.columns(['tenant_id', 'log_id', 'id']).doNothing())
        .execute();

    // Load the record and register
    const record = await getDynamicEntityDefinition(payload.name);
    if (record) {
        await registerDynamicEntityFromRecord(record);
    }
}

/**
 * Handle ENTITY_TYPE_UPDATED event.
 * Updates the definition and potentially adds columns.
 */
export async function handleEntityTypeUpdated(
    payload: {
        id: string;
        displayName?: string;
        addFields?: DynamicFieldDefinition[];
        updateFields?: Array<{
            name: string;
            displayName?: string;
            default?: string | number | boolean | null;
        }>;
        /** Replace the calendar dates; null clears them, undefined leaves them. */
        calendar?: EntityCalendarSource[] | null;
    }
): Promise<void> {
    console.log(`[DynamicEntities] Updating entity type: ${payload.id}`);
    const context = await requireActiveContext();

    // Get existing record in this log
    const existing = await db
        .selectFrom('entity_type_definitions')
        .selectAll()
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('id', '=', payload.id)
        .executeTakeFirst();

    if (!existing) {
        console.warn(`[DynamicEntities] Entity type not found: ${payload.id}`);
        return;
    }

    let fields = parseEntityFields(existing);

    // Add new fields
    if (payload.addFields && payload.addFields.length > 0) {
        for (const newField of payload.addFields) {
            // Add column to table
            await addColumnToDynamicTable(existing.table_name, newField);
            // Add to fields array
            fields.push(newField);
        }
    }

    // Update existing fields (only non-breaking changes)
    if (payload.updateFields) {
        for (const update of payload.updateFields) {
            const fieldIndex = fields.findIndex(f => f.name === update.name);
            if (fieldIndex >= 0) {
                fields[fieldIndex] = { ...fields[fieldIndex], ...update };
            }
        }
    }

    // Update database record
    await db
        .updateTable('entity_type_definitions')
        .set({
            display_name: payload.displayName ?? existing.display_name,
            fields_json: JSON.stringify(fields),
            ...(payload.calendar !== undefined
                ? {
                      calendar_json: validatedCalendarJson(
                          existing.name,
                          payload.calendar,
                          fields,
                      ),
                  }
                : {}),
            updated_at: new Date().toISOString(),
        })
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('id', '=', payload.id)
        .execute();

    // Re-register the entity
    const record = await getDynamicEntityDefinition(existing.name);
    if (record) {
        await registerDynamicEntityFromRecord(record);
    }
}

/**
 * Handle ENTITY_TYPE_ARCHIVED event.
 * Marks the entity type as archived (soft delete) within the active log.
 */
export async function handleEntityTypeArchived(payload: { id: string }): Promise<void> {    console.log(`[DynamicEntities] Archiving entity type: ${payload.id}`);
    const context = await requireActiveContext();

    await db
        .updateTable('entity_type_definitions')
        .set({
            is_archived: 1,
            updated_at: new Date().toISOString(),
        })
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('id', '=', payload.id)
        .execute();

    // Note: We don't unregister here because the entity data still exists
    // and may need to be accessed. The entity just won't appear in the UI.
}
