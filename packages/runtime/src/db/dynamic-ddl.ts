/**
 * Dynamic DDL Generator
 * 
 * Generates SQL DDL for dynamic entity tables at runtime.
 */

import type { DynamicFieldDefinition } from '../event/meta-entity-types.js';
import { qualifiedIdentifier, quoteIdentifier } from '../event/projection-builder.js';

/**
 * Entity type record from the entity_type_definitions table
 */
export interface EntityTypeRecord {
    tenant_id: string;
    log_id: string;
    id: string;
    name: string;
    display_name: string;
    table_name: string;
    fields_json: string;
    calendar_json: string | null;
    is_archived: number;
    created_at: string;
    updated_at: string;
}

// ============================================================================
// DDL generation
// ============================================================================

/**
 * Map DynamicFieldType to SQLite type
 */
function getSQLiteType(type: DynamicFieldDefinition['type']): string {
    switch (type) {
        case 'number':
            return 'REAL';
        case 'boolean':
            return 'INTEGER'; // SQLite uses 0/1 for booleans
        case 'string':
        case 'reference':
        case 'datetime':
        default:
            return 'TEXT';
    }
}

/**
 * Convert a default value to SQL-safe format
 */
function toSQLDefault(value: string | number | boolean | null | undefined): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0';
    }
    if (typeof value === 'number') {
        return String(value);
    }
    // Only allow the two deterministic defaults emitted by the entity editor.
    if (/^(?:date|datetime)\('now'\)$/.test(value)) {
        return value;
    }
    // String value - escape quotes
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Parse the stored field definitions defensively: a malformed row must not
 * crash table creation with an opaque SyntaxError.
 */
function parseStoredFields(record: EntityTypeRecord): DynamicFieldDefinition[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(record.fields_json);
    } catch {
        throw new Error(
            `Dynamic entity "${record.name}" has malformed field definitions`,
        );
    }
    if (!Array.isArray(parsed)) {
        throw new Error(
            `Dynamic entity "${record.name}" has malformed field definitions`,
        );
    }
    return parsed as DynamicFieldDefinition[];
}

/**
 * Generate DDL for a dynamic entity table
 */
export function generateDynamicTableDDL(record: EntityTypeRecord, schema?: string): string {
    const fields = parseStoredFields(record);

    const columns = fields.map(f => {
        const sqlType = getSQLiteType(f.type);
        const nullable = f.required ? ' NOT NULL' : '';
        const defaultVal = f.default !== undefined ? ` DEFAULT ${toSQLDefault(f.default)}` : '';
        return `        ${quoteIdentifier(f.name)} ${sqlType}${nullable}${defaultVal}`;
    });

    return `
CREATE TABLE IF NOT EXISTS ${qualifiedIdentifier(schema, record.table_name)} (
    "tenant_id" TEXT NOT NULL,
    "log_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
${columns.join(',\n')},
    "created_at" TEXT DEFAULT (datetime('now')),
    "updated_at" TEXT DEFAULT (datetime('now')),
    PRIMARY KEY ("tenant_id", "log_id", "id")
);`.trim();
}

/**
 * Generate DDL to add a new column to an existing table
 */
export function generateAddColumnDDL(
    tableName: string,
    field: DynamicFieldDefinition,
    schema?: string,
): string {
    const sqlType = getSQLiteType(field.type);
    const defaultVal = field.default !== undefined ? ` DEFAULT ${toSQLDefault(field.default)}` : '';
    // Note: SQLite doesn't support NOT NULL on ALTER TABLE ADD COLUMN without a default
    return `ALTER TABLE ${qualifiedIdentifier(schema, tableName)} ADD COLUMN ${quoteIdentifier(field.name)} ${sqlType}${defaultVal};`;
}
