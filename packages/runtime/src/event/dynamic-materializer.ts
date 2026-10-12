import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import {
    generateAddColumnDDL,
    generateDynamicTableDDL,
    type EntityTypeRecord,
} from '../db/dynamic-ddl.js';
import {
    sanitizeCalendarSource,
    serializeCalendarConfig,
    validateCalendarConfig,
    type EntityCalendarSource,
} from '@hearthlog/contracts/calendar/config';
import { ENTITY_DEFINITIONS } from '@hearthlog/contracts/event/entity-definitions';
import { createProjectionConfigFromDynamic, loadDynamicEntityTypes } from './dynamic-entities.js';
import type { DynamicFieldDefinition } from './meta-entity-types.js';
import type { EntityProjectionConfig } from './projection-builder.js';
import { qualifiedIdentifier } from './projection-builder.js';

type MaterializerDatabase = Kysely<Database> | Transaction<Database>;

export interface DynamicMaterializerOptions {
    database: MaterializerDatabase;
    schema: string;
    scope: { tenantId: string; logId: string };
    registerLive: boolean;
    sourceSchema?: string;
    sourceTable?: string;
}

export interface DynamicMaterializationResult {
    records: EntityTypeRecord[];
    activeProjectionConfigs: EntityProjectionConfig[];
}

type MetaRow = {
    id: string;
    type: string;
    timestamp: number;
    payload: string;
};

/**
 * Rebuild dynamic definitions into a target schema from an already bounded,
 * tombstone-aware event source. Snapshot callers use their staged event table;
 * live rebuild callers can use a similarly prepared source in main.
 */
export async function materializeDynamicEntities(
    options: DynamicMaterializerOptions,
): Promise<DynamicMaterializationResult> {
    const sourceTable = options.sourceTable ?? '__effective_events';
    const source = qualifiedIdentifier(options.sourceSchema ?? options.schema, sourceTable);
    const rows = await sql<MetaRow>`
        SELECT id, type, timestamp, payload
        FROM ${sql.raw(source)}
        WHERE type IN ('ENTITY_TYPE_DEFINED', 'ENTITY_TYPE_UPDATED', 'ENTITY_TYPE_ARCHIVED')
        ORDER BY CASE WHEN log_version IS NULL THEN 1 ELSE 0 END,
                 log_version ASC, timestamp ASC, local_sequence ASC, id ASC
    `.execute(options.database);

    const records = replayDynamicDefinitions(rows.rows, options.scope);
    const catalog = qualifiedIdentifier(options.schema, 'entity_type_definitions');

    for (const record of records) {
        await sql`
            INSERT INTO ${sql.raw(catalog)} (
                tenant_id, log_id, id, name, display_name, table_name,
                fields_json, calendar_json, is_archived, created_at, updated_at
            ) VALUES (
                ${record.tenant_id}, ${record.log_id}, ${record.id}, ${record.name},
                ${record.display_name}, ${record.table_name}, ${record.fields_json},
                ${record.calendar_json},
                ${record.is_archived}, ${record.created_at}, ${record.updated_at}
            )
        `.execute(options.database);
    }

    const activeProjectionConfigs: EntityProjectionConfig[] = [];
    for (const record of records) {
        if (record.is_archived) continue;
        await sql.raw(generateDynamicTableDDL(record, options.schema)).execute(options.database);
        const fields = parseStoredFields(record.fields_json, record.id);
        const tableInfo = await sql<{ name: string }>`
            PRAGMA ${sql.raw(qualifiedIdentifier(options.schema, 'table_info'))}(${sql.raw(`'${record.table_name.replace(/'/g, "''")}'`)})
        `.execute(options.database);
        const existingColumns = new Set(tableInfo.rows.map((column) => column.name));
        for (const field of fields) {
            if (!existingColumns.has(field.name)) {
                await sql.raw(generateAddColumnDDL(record.table_name, field, options.schema))
                    .execute(options.database);
            }
        }
        activeProjectionConfigs.push(
            createProjectionConfigFromDynamic(record.name, record.table_name, fields),
        );
    }

    if (options.registerLive) {
        await loadDynamicEntityTypes();
    }

    return { records, activeProjectionConfigs };
}

export function replayDynamicDefinitions(
    rows: readonly MetaRow[],
    scope: { tenantId: string; logId: string },
): EntityTypeRecord[] {
    const definitions = new Map<string, EntityTypeRecord>();
    const names = new Set(ENTITY_DEFINITIONS.map((definition) => definition.name));
    const tables = new Set(ENTITY_DEFINITIONS.map((definition) => definition.table));

    for (const row of rows) {
        const payload = parsePayload(row);
        const id = typeof payload.id === 'string' ? payload.id : null;
        if (!id) throw new Error(`dynamic-definition-invalid-id:${row.id}`);
        const occurredAt = toSqliteDateTime(row.timestamp);

        if (row.type === 'ENTITY_TYPE_DEFINED') {
            if (definitions.has(id)) continue;
            const name = requiredString(payload.name, row.id, 'name');
            const tableName = requiredString(payload.tableName, row.id, 'tableName');
            const displayName = requiredString(payload.displayName, row.id, 'displayName');
            assertSafeIdentifier(name, row.id, 'name');
            assertSafeIdentifier(tableName, row.id, 'table');
            if (names.has(name) || tables.has(tableName)) {
                throw new Error(`dynamic-definition-name-conflict:${row.id}`);
            }
            if (!Array.isArray(payload.fields)) {
                throw new Error(`dynamic-definition-invalid-fields:${row.id}`);
            }
            validateFields(payload.fields as DynamicFieldDefinition[], row.id);
            const definedFields = payload.fields as DynamicFieldDefinition[];
            names.add(name);
            tables.add(tableName);
            definitions.set(id, {
                tenant_id: scope.tenantId,
                log_id: scope.logId,
                id,
                name,
                display_name: displayName,
                table_name: tableName,
                fields_json: JSON.stringify(definedFields),
                calendar_json:
                    payload.calendar === undefined
                        ? null
                        : calendarJsonFromPayload(
                              payload.calendar,
                              name,
                              definedFields,
                              row.id,
                              new Set<string>(),
                          ),
                is_archived: 0,
                created_at: occurredAt,
                updated_at: occurredAt,
            });
            continue;
        }

        const existing = definitions.get(id);
        if (!existing) throw new Error(`dynamic-definition-missing:${row.id}`);

        if (row.type === 'ENTITY_TYPE_ARCHIVED') {
            existing.is_archived = 1;
            existing.updated_at = occurredAt;
            continue;
        }

        const fields = parseStoredFields(existing.fields_json, row.id);
        if (payload.addFields !== undefined) {
            if (!Array.isArray(payload.addFields)) {
                throw new Error(`dynamic-definition-invalid-add-fields:${row.id}`);
            }
            for (const field of payload.addFields as DynamicFieldDefinition[]) {
                if (!field || typeof field.name !== 'string' || fields.some((item) => item.name === field.name)) {
                    throw new Error(`dynamic-definition-invalid-added-field:${row.id}`);
                }
                validateFields([field], row.id);
                fields.push(field);
            }
        }
        if (payload.updateFields !== undefined) {
            if (!Array.isArray(payload.updateFields)) {
                throw new Error(`dynamic-definition-invalid-updates:${row.id}`);
            }
            for (const update of payload.updateFields as Array<Partial<DynamicFieldDefinition> & { name: string }>) {
                const fieldIndex = fields.findIndex((field) => field.name === update.name);
                if (fieldIndex < 0) throw new Error(`dynamic-definition-field-missing:${row.id}`);
                fields[fieldIndex] = { ...fields[fieldIndex], ...update };
            }
        }
        if (payload.calendar !== undefined) {
            existing.calendar_json =
                payload.calendar === null
                    ? null
                    : calendarJsonFromPayload(
                          payload.calendar,
                          existing.name,
                          fields,
                          row.id,
                          new Set<string>(),
                      );
        }
        if (typeof payload.displayName === 'string') existing.display_name = payload.displayName;
        existing.fields_json = JSON.stringify(fields);
        existing.updated_at = occurredAt;
    }

    return [...definitions.values()];
}

function parsePayload(row: MetaRow): Record<string, unknown> {
    try {
        const payload = JSON.parse(row.payload);
        if (payload && typeof payload === 'object') return payload as Record<string, unknown>;
    } catch {
        // Typed below so callers receive a safe build category rather than payload data.
    }
    throw new Error(`dynamic-definition-invalid-payload:${row.id}`);
}

/** Validate and serialize a calendar config arriving in a meta event. */
function calendarJsonFromPayload(
    value: unknown,
    entityName: string,
    fields: readonly DynamicFieldDefinition[],
    eventId: string,
    parentTables: ReadonlySet<string>,
): string | null {
    if (!Array.isArray(value)) {
        throw new Error(`dynamic-definition-invalid-calendar:${eventId}`);
    }
    const sources: EntityCalendarSource[] = [];
    for (const entry of value) {
        const source = sanitizeCalendarSource(entry);
        if (!source) throw new Error(`dynamic-definition-invalid-calendar:${eventId}`);
        sources.push(source);
    }
    const errors = validateCalendarConfig(entityName, sources, fields, { parentTables });
    if (errors.length > 0) {
        throw new Error(`dynamic-definition-invalid-calendar:${eventId}`);
    }
    return serializeCalendarConfig(sources);
}

/** Parse projected field JSON defensively; malformed rows fail the rebuild. */
function parseStoredFields(json: string, eventId: string): DynamicFieldDefinition[] {
    try {
        const parsed: unknown = JSON.parse(json);
        if (Array.isArray(parsed)) return parsed as DynamicFieldDefinition[];
    } catch {
        // Fall through to the typed error below.
    }
    throw new Error(`dynamic-definition-invalid-fields:${eventId}`);
}

function requiredString(value: unknown, eventId: string, field: string): string {
    if (typeof value !== 'string' || !value) {
        throw new Error(`dynamic-definition-invalid-${field}:${eventId}`);
    }
    return value;
}

function validateFields(fields: DynamicFieldDefinition[], eventId: string): void {
    const names = new Set<string>();
    for (const field of fields) {
        if (!field || typeof field.name !== 'string' || typeof field.payloadKey !== 'string') {
            throw new Error(`dynamic-definition-invalid-field:${eventId}`);
        }
        assertSafeIdentifier(field.name, eventId, 'field');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.payloadKey)) {
            throw new Error(`dynamic-definition-invalid-payload-key:${eventId}`);
        }
        if (names.has(field.name)) throw new Error(`dynamic-definition-duplicate-field:${eventId}`);
        names.add(field.name);
    }
}

function assertSafeIdentifier(value: string, eventId: string, field: string): void {
    if (!/^[a-z][a-z0-9_]*$/.test(value)) {
        throw new Error(`dynamic-definition-invalid-${field}-identifier:${eventId}`);
    }
}

function toSqliteDateTime(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');
}
