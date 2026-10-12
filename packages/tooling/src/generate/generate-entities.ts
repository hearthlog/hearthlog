#!/usr/bin/env npx tsx
/**
 * Entity Code Generator
 * 
 * Generates TypeScript types and database schema from entity-definitions.ts
 * 
 * Usage: pnpm build:generated
 * 
 * Generated files:
 * - .generated/src/types.generated.ts - Event payloads and types
 * - .generated/src/schema.generated.ts - Database types and DDL
 * - .generated/src/standard-commands.generated.ts, standard-db.generated.ts - Data APIs
 * - .generated/src/event-schemas.generated.ts - Payload shapes Ledger validates
 *
 * `pnpm build:generated` runs this after writing the module catalog, in a
 * process of its own so the entity definitions include the site's modules.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROOT = hostRoot();
import { hostRoot } from '../root.js';

import { ENTITY_DEFINITIONS, type EntityDefinition as EntityDef, type EntityFieldDefinition as FieldDef } from '@hearthlog/contracts/event/entity-definitions';
import { MODULE_FEATURES } from '#generated/modules';

// ============================================================================
// Helper Functions
// ============================================================================

function toCamelCase(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function toPascalCase(str: string): string {
    const camel = toCamelCase(str);
    return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function getEventPrefix(def: EntityDef): string {
    return def.eventPrefix || def.name.toUpperCase() + '_';
}

function getPayloadKey(field: FieldDef): string {
    return field.payloadKey || toCamelCase(field.name);
}

function fieldTypeToTS(type: string): string {
    switch (type) {
        case 'number': return 'number';
        case 'boolean': return 'boolean';
        case 'string':
        default: return 'string';
    }
}

function fieldTypeToSQL(type: string): string {
    switch (type) {
        case 'number': return 'REAL';
        case 'boolean': return 'INTEGER';
        case 'string':
        default: return 'TEXT';
    }
}

function quoteSqlIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function validateFileReferences(entities: EntityDef[]): void {
    for (const entity of entities) {
        if (!entity.fileReference) continue;
        const field = entity.fields.find((candidate) => candidate.name === entity.fileReference!.versionField);
        if (!field || field.type !== 'string') {
            throw new Error(`Entity ${entity.name}: fileReference.versionField must name a string field`);
        }
    }
}

function validateIndexes(entities: EntityDef[]): void {
    const indexNames = new Set<string>();
    const automaticColumns = ['tenant_id', 'log_id', 'id', 'created_at', 'updated_at'];

    for (const entity of entities) {
        const availableColumns = new Set([
            ...automaticColumns,
            ...entity.fields.map((field) => field.name),
        ]);

        for (const index of entity.indexes ?? []) {
            if (!index.name) {
                throw new Error(`Entity ${entity.name} has an index without a name`);
            }
            if (indexNames.has(index.name)) {
                throw new Error(`Duplicate entity index name: ${index.name}`);
            }
            if (index.columns.length === 0) {
                throw new Error(`Entity index ${index.name} must include at least one column`);
            }
            for (const column of index.columns) {
                if (!availableColumns.has(column)) {
                    throw new Error(
                        `Entity index ${index.name} references unknown column ${entity.table}.${column}`,
                    );
                }
            }
            indexNames.add(index.name);
        }
    }
}

// ============================================================================
// Event Types Generator
// ============================================================================

function generateEventTypes(entities: EntityDef[]): string {
    const lines: string[] = [
        '// ============================================================================',
        '// AUTO-GENERATED FILE - DO NOT EDIT MANUALLY',
        '// Generated from entity-definitions.ts by packages/tooling/src/generate/generate-entities.ts',
        '// ============================================================================',
        '',
        '// ============================================================================',
        '// Base Event Type',
        '// ============================================================================',
        '',
        'export interface BaseEvent<T extends string, P> {',
        '    id: string;',
        '    type: T;',
        '    timestamp: number;',
        '    payload: P;',
        '}',
        '',
    ];

    // Generate types for each entity
    for (const entity of entities) {
        const pascalName = toPascalCase(entity.name);
        const prefix = getEventPrefix(entity);

        lines.push('// ============================================================================');
        lines.push(`// ${pascalName} Events`);
        lines.push('// ============================================================================');
        lines.push('');

        // Add Payload - all fields
        lines.push(`export interface Add${pascalName}Payload {`);
        lines.push('    id: string;');
        for (const field of entity.fields) {
            const key = getPayloadKey(field);
            const tsType = fieldTypeToTS(field.type);
            lines.push(`    ${key}${field.optionalInPayload ? "?" : ""}: ${tsType}${field.optionalInPayload && !field.required && field.default === undefined ? " | null" : ""};`);
        }
        lines.push('}');
        lines.push('');

        // Update Payload - all fields optional except id
        lines.push(`export interface Update${pascalName}Payload {`);
        lines.push('    id: string;');
        for (const field of entity.fields) {
            const key = getPayloadKey(field);
            const tsType = fieldTypeToTS(field.type);
            lines.push(`    ${key}?: ${tsType}${field.optionalInPayload && !field.required && field.default === undefined ? " | null" : ""};`);
        }
        lines.push('}');
        lines.push('');

        // Remove Payload - just id
        lines.push(`export interface Remove${pascalName}Payload {`);
        lines.push('    id: string;');
        lines.push('}');
        lines.push('');

        // Event types
        lines.push(`export type Add${pascalName}Event = BaseEvent<'${prefix}ADDED', Add${pascalName}Payload>;`);
        lines.push(`export type Update${pascalName}Event = BaseEvent<'${prefix}UPDATED', Update${pascalName}Payload>;`);
        lines.push(`export type Remove${pascalName}Event = BaseEvent<'${prefix}REMOVED', Remove${pascalName}Payload>;`);
        lines.push('');

        // Entity event union
        lines.push(`export type ${pascalName}Event = Add${pascalName}Event | Update${pascalName}Event | Remove${pascalName}Event;`);
        lines.push('');
    }

    // Tombstone event (special, not entity-driven)
    lines.push('// ============================================================================');
    lines.push('// Tombstone Event (Special - not entity-driven)');
    lines.push('// ============================================================================');
    lines.push('');
    lines.push('export interface TombstonePayload {');
    lines.push('    eventId: string;');
    lines.push('}');
    lines.push('');
    lines.push("export type TombstoneEvent = BaseEvent<'EVENT_TOMBSTONED', TombstonePayload>;");
    lines.push('');

    // Excision event (special, not entity-driven): hides accepted events from
    // replay. The directive is itself an event, so it syncs, audits, and can
    // be tombstoned to revive the removed events.
    lines.push('// ============================================================================');
    lines.push('// Excision Event (Special - not entity-driven)');
    lines.push('// ============================================================================');
    lines.push('');
    lines.push('export interface EventsExcisedPayload {');
    lines.push('    eventIds: string[];');
    lines.push('    note?: string;');
    lines.push('}');
    lines.push('');
    lines.push("export type EventsExcisedEvent = BaseEvent<'EVENTS_EXCISED', EventsExcisedPayload>;");
    lines.push('');

    // AppEvent union
    lines.push('// ============================================================================');
    lines.push('// Combined Event Types');
    lines.push('// ============================================================================');
    lines.push('');
    const eventUnions = entities.map(e => `${toPascalCase(e.name)}Event`).join('\n    | ');
    lines.push('export type AppEvent =');
    lines.push(`    | ${eventUnions}`);
    lines.push('    | TombstoneEvent');
    lines.push('    | EventsExcisedEvent;');
    lines.push('');

    return lines.join('\n');
}

// ============================================================================
// Database Schema Generator
// ============================================================================

function generateDbSchema(entities: EntityDef[]): string {
    validateIndexes(entities);

    for (const entity of entities) {
        if (!entity.feature) {
            throw new Error(
                `Entity ${entity.name} is missing its owning "feature" ` +
                    "(see packages/contracts/src/features/registry.ts FeatureId)",
            );
        }
    }

    const lines: string[] = [
        '// ============================================================================',
        '// AUTO-GENERATED FILE - DO NOT EDIT MANUALLY',
        '// Generated from entity-definitions.ts by packages/tooling/src/generate/generate-entities.ts',
        '// ============================================================================',
        '',
        "import type { ColumnType } from 'kysely';",
        '',
    ];

    const tableNames: string[] = [];
    const ddlNames: string[] = [];
    const indexDdlNames: string[] = [];

    // Generate types for each entity
    for (const entity of entities) {
        const pascalName = toPascalCase(entity.name);
        const tableName = `${pascalName}Table`;
        tableNames.push(tableName);

        const ddlConstName = `${entity.name.toUpperCase()}_DDL`;
        ddlNames.push(ddlConstName);

        lines.push('// ============================================================================');
        lines.push(`// ${pascalName}`);
        lines.push('// ============================================================================');
        lines.push('');

        // Plain read type (for query results)
        lines.push(`export type ${pascalName} = {`);
        lines.push('    tenant_id: string;');
        lines.push('    log_id: string;');
        lines.push('    id: string;');
        for (const field of entity.fields) {
            const tsType = fieldTypeToTS(field.type);
            const nullable = !field.required && field.default === undefined ? ' | null' : '';
            lines.push(`    ${field.name}: ${tsType}${nullable};`);
        }
        lines.push('    created_at: string;');
        lines.push('    updated_at: string;');
        lines.push('};');
        lines.push('');

        // Kysely table type
        lines.push(`export type ${tableName} = {`);
        lines.push('    tenant_id: string;');
        lines.push('    log_id: string;');
        lines.push('    id: string;');
        for (const field of entity.fields) {
            const tsType = fieldTypeToTS(field.type);
            const nullable = !field.required && field.default === undefined ? ' | null' : '';
            if (field.default !== undefined || !field.required) {
                // Fields with defaults or optional fields use ColumnType
                lines.push(`    ${field.name}: ColumnType<${tsType}${nullable}, ${tsType} | undefined, ${tsType}>;`);
            } else {
                lines.push(`    ${field.name}: ${tsType}${nullable};`);
            }
        }
        lines.push('    created_at: ColumnType<string, string | undefined, never>;');
        lines.push('    updated_at: ColumnType<string, string | undefined, string>;');
        lines.push('};');
        lines.push('');

        // DDL string — composite PK scopes projection rows per tenant/log
        const ddlFields: string[] = [
            '"tenant_id" TEXT NOT NULL',
            '"log_id" TEXT NOT NULL',
            '"id" TEXT NOT NULL',
        ];
        for (const field of entity.fields) {
            const sqlType = fieldTypeToSQL(field.type);
            let ddlLine = `"${field.name}" ${sqlType}`;

            if (field.default !== undefined) {
                const isSqlExpression = typeof field.default === 'string' && field.default.includes('(');
                let defaultVal: string | number | null;
                if (typeof field.default === 'string') {
                    // SQL expressions need to be wrapped in parentheses for SQLite
                    defaultVal = isSqlExpression ? `(${field.default})` : `'${field.default}'`;
                } else {
                    defaultVal = field.default;
                }
                ddlLine += ` DEFAULT ${defaultVal}`;
            }

            if (field.required) {
                ddlLine += ' NOT NULL';
            }

            ddlFields.push(ddlLine);
        }
        ddlFields.push('"created_at" TEXT DEFAULT (datetime(\'now\'))');
        ddlFields.push('"updated_at" TEXT DEFAULT (datetime(\'now\'))');
        ddlFields.push('PRIMARY KEY ("tenant_id", "log_id", "id")');

        lines.push(`export const ${ddlConstName} = \``);
        lines.push(`    CREATE TABLE IF NOT EXISTS "${entity.table}" (`);
        lines.push(`        ${ddlFields.join(',\\n        ')}`);
        lines.push('    );');
        lines.push('`;');
        lines.push('');

        if (entity.indexes?.length) {
            const indexDdlConstName = `${entity.name.toUpperCase()}_INDEX_DDL`;
            indexDdlNames.push(indexDdlConstName);
            lines.push(`export const ${indexDdlConstName} = [`);
            for (const index of entity.indexes) {
                const unique = index.unique ? 'UNIQUE ' : '';
                const columns = index.columns.map(quoteSqlIdentifier).join(', ');
                lines.push('    `');
                lines.push(`    CREATE ${unique}INDEX IF NOT EXISTS ${quoteSqlIdentifier(index.name)}`);
                lines.push(`    ON ${quoteSqlIdentifier(entity.table)} (${columns});`);
                lines.push('    `,');
            }
            lines.push('];');
            lines.push('');
        }
    }

    // EntityDatabaseTables interface
    lines.push('// ============================================================================');
    lines.push('// Generated Database Interface');
    lines.push('// ============================================================================');
    lines.push('');
    lines.push('export interface EntityDatabaseTables {');
    for (const entity of entities) {
        const pascalName = toPascalCase(entity.name);
        lines.push(`    ${entity.table}: ${pascalName}Table;`);
    }
    lines.push('}');
    lines.push('');

    // getAllEntityDDL function
    lines.push('/**');
    lines.push(' * Get all entity table DDL statements');
    lines.push(' */');
    lines.push('export function getAllEntityDDL(schema?: string): string[] {');
    lines.push(`    const entries: Array<[string, string]> = [${ddlNames.map((name, index) => `[${name}, '${entities[index].table}']`).join(', ')}];`);
    lines.push('    if (!schema) return entries.map(([ddl]) => ddl);');
    lines.push('    const qualifiedSchema = `"${schema.replace(/"/g, \'""\')}"`;');
    lines.push('    return entries.map(([ddl, table]) => ddl.replace(');
    lines.push('        `CREATE TABLE IF NOT EXISTS "${table}"`,');
    lines.push('        `CREATE TABLE IF NOT EXISTS ${qualifiedSchema}."${table}"`,');
    lines.push('    ));');
    lines.push('}');
    lines.push('');

    lines.push('/**');
    lines.push(' * Get all entity index DDL statements');
    lines.push(' */');
    lines.push('export function getAllEntityIndexDDL(schema?: string): string[] {');
    const indexDdlSpreads = indexDdlNames.map((name) => `...${name}`).join(', ');
    lines.push(`    const ddls = [${indexDdlSpreads}];`);
    lines.push('    if (!schema) return ddls;');
    lines.push('    const qualifiedSchema = `"${schema.replace(/"/g, \'""\')}"`;');
    lines.push('    return ddls.map((ddl) => ddl.replace(');
    lines.push('        /CREATE (UNIQUE )?INDEX IF NOT EXISTS "([^"]+)"/,' );
    lines.push('        (_match, unique = \'\', indexName) => `CREATE ${unique}INDEX IF NOT EXISTS ${qualifiedSchema}."${indexName}"`,' );
    lines.push('    ));');
    lines.push('}');
    lines.push('');

    // Export list of table names
    lines.push('/**');
    lines.push(' * List of all entity table names');
    lines.push(' */');
    const tableNameStrings = entities.map(e => `'${e.table}'`).join(', ');
    lines.push(`export const ENTITY_TABLE_NAMES = [${tableNameStrings}] as const;`);
    lines.push('');

    // Feature ownership: table -> owning feature (see features/registry.ts).
    // Drives per-tenant local SQLite scoping and the ledger append allow-list.
    lines.push('/**');
    lines.push(' * Owning feature for each entity table (tenants.json enables features).');
    lines.push(' */');
    lines.push('export const ENTITY_FEATURES: Record<string, string> = {');
    for (const entity of entities) {
        lines.push(`    '${entity.table}': '${entity.feature}',`);
    }
    lines.push('};');
    lines.push('');

    // Per-table DDL lookup (for tenant-scoped database bootstrap).
    lines.push('/**');
    lines.push(' * Table DDL statements keyed by table name.');
    lines.push(' */');
    lines.push('export const ENTITY_DDL_BY_TABLE: Record<string, string> = {');
    for (let index = 0; index < entities.length; index += 1) {
        lines.push(`    '${entities[index].table}': ${ddlNames[index]},`);
    }
    lines.push('};');
    lines.push('');

    // Per-table index DDL lookup (entities without indexes are omitted).
    lines.push('/**');
    lines.push(' * Index DDL statements keyed by table name.');
    lines.push(' */');
    lines.push('export const ENTITY_INDEX_DDL_BY_TABLE: Record<string, string[]> = {');
    for (const entity of entities) {
        if (!entity.indexes?.length) continue;
        const constName = `${entity.name.toUpperCase()}_INDEX_DDL`;
        lines.push(`    '${entity.table}': [...${constName}],`);
    }
    lines.push('};');
    lines.push('');

    lines.push('/**');
    lines.push(' * Entity DDL statements restricted to the approved tables.');
    lines.push(' */');
    lines.push('export function getEntityDDLForTables(approvedTables: ReadonlySet<string>): string[] {');
    lines.push('    const ddls: string[] = [];');
    lines.push('    for (const [table, ddl] of Object.entries(ENTITY_DDL_BY_TABLE)) {');
    lines.push('        if (approvedTables.has(table)) ddls.push(ddl);');
    lines.push('    }');
    lines.push('    return ddls;');
    lines.push('}');
    lines.push('');

    lines.push('/**');
    lines.push(' * Entity index DDL statements restricted to the approved tables.');
    lines.push(' */');
    lines.push('export function getEntityIndexDDLForTables(approvedTables: ReadonlySet<string>): string[] {');
    lines.push('    const ddls: string[] = [];');
    lines.push('    for (const [table, tableDdls] of Object.entries(ENTITY_INDEX_DDL_BY_TABLE)) {');
    lines.push('        if (!approvedTables.has(table)) continue;');
    lines.push('        ddls.push(...tableDdls);');
    lines.push('    }');
    lines.push('    return ddls;');
    lines.push('}');
    lines.push('');

    return lines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

function generateCommands(entities: EntityDef[]): string {
    return [
        '// AUTO-GENERATED by packages/tooling/src/generate/generate-entities.ts — do not edit.',
        "import { standardCommand } from '@hearthlog/runtime/commands/standard.js';",
        ...entities.map(entity => `export const ${toCamelCase(entity.name)}Commands = {
    create: standardCommand('${getEventPrefix(entity)}ADDED'),
    update: standardCommand('${getEventPrefix(entity)}UPDATED'),
    remove: standardCommand('${getEventPrefix(entity)}REMOVED'),
};`),
        '',
    ].join('\n');
}

function generateQueries(entities: EntityDef[]): string {
    return [
        '// AUTO-GENERATED by packages/tooling/src/generate/generate-entities.ts — do not edit.',
        "import type { ReadModelSession } from '@hearthlog/runtime/db/read-session.js';",
        "import { tenant } from '@hearthlog/contracts/tenant/config';",
        'export function createStandardRepositories(session: ReadModelSession) {',
        '    function assertEnabled(table: string) {',
        "        if (!tenant.approvedEntities.tables.has(table)) throw new Error(`Entity ${table} is not enabled for this tenant`);",
        '    }',
        '    return {',
        ...entities.map(entity => `        ${toCamelCase(entity.name)}: {
            list: async () => {
                assertEnabled('${entity.table}');
                return session.selectFrom('${entity.table}').selectAll().orderBy('id').execute();
            },
            get: async (id: string) => {
                assertEnabled('${entity.table}');
                return session.selectFrom('${entity.table}').selectAll().where('id', '=', id).executeTakeFirst();
            },
        },`),
        '    };', '}', '',
    ].join('\n');
}

/**
 * What Ledger checks about each known entity event: which payload keys exist,
 * their JSON kinds, and which keys an add must carry. Extra keys are allowed so
 * newer clients are never blocked, and the table only ever grows with the
 * definitions, so a Ledger deployed ahead of the frontend accepts everything the
 * frontend sends.
 */
function generateLedgerEventSchemas(entities: EntityDef[]): string {
    const lines: string[] = [
        '// ============================================================================',
        '// AUTO-GENERATED FILE - DO NOT EDIT MANUALLY',
        '// Generated by packages/tooling/src/generate/generate-entities.ts from the core entity definitions',
        '// (packages/contracts/src/event/entity-definitions.ts) and those of every module in modules/*.',
        '// ============================================================================',
        '',
        "export type PayloadKind = 'string' | 'number' | 'boolean';",
        '',
        'export interface EventSchema {',
        "    kind: 'added' | 'updated' | 'removed';",
        '    entity: string;',
        '    /** Payload keys an add must carry with a non-null value. */',
        '    required: readonly string[];',
        '    /** JSON kind of every declared payload key. */',
        '    fields: Readonly<Record<string, PayloadKind>>;',
        '}',
        '',
        'export const EVENT_SCHEMAS: Readonly<Record<string, EventSchema>> = {',
    ];
    const references: Array<[string, { entity: string; versionKey: string; requiredOnAdd: boolean }]> = [];
    const owners: Array<[string, string]> = [];
    for (const entity of entities) {
        const prefix = getEventPrefix(entity);
        const owner = MODULE_FEATURES.find((feature) => feature.id === entity.feature)?.module ?? 'core';
        const fields = Object.fromEntries(entity.fields.map((field) => [
            getPayloadKey(field),
            field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean' : 'string',
        ]));
        const required = entity.fields.filter((field) => field.required).map(getPayloadKey);
        const schemas = {
            ADDED: { kind: 'added', entity: entity.name, required, fields },
            UPDATED: { kind: 'updated', entity: entity.name, required: [], fields },
            REMOVED: { kind: 'removed', entity: entity.name, required: [], fields: {} },
        };
        for (const [suffix, schema] of Object.entries(schemas)) {
            lines.push(`    ${prefix}${suffix}: ${JSON.stringify(schema)},`);
            owners.push([`${prefix}${suffix}`, owner]);
        }
        if (entity.fileReference) {
            const versionKey = getPayloadKey(entity.fields.find((field) => field.name === entity.fileReference!.versionField)!);
            references.push([`${prefix}ADDED`, { entity: entity.name, versionKey, requiredOnAdd: true }]);
            references.push([`${prefix}UPDATED`, { entity: entity.name, versionKey, requiredOnAdd: false }]);
        }
    }
    lines.push(
        '};',
        '',
        '/**',
        ' * Which module (or the core) defines each event type. Events of features that',
        ' * no longer exist have no entry here and pass as dynamic types (shape checks only).',
        ' */',
        'export const EVENT_OWNERS: Readonly<Record<string, string>> = {',
        ...owners.map(([type, owner]) => `    ${type}: ${JSON.stringify(owner)},`),
        '};',
        '',
        '/** An event that can name an immutable file version the Ledger records per log (see `fileReference` in entity definitions). */',
        'export interface FileReference {',
        '    entity: string;',
        '    /** Payload key holding the file version id. */',
        '    versionKey: string;',
        '    /** An add must name a version; an update names one only when it replaces the file. */',
        '    requiredOnAdd: boolean;',
        '}',
        '',
        'export const FILE_REFERENCES: Readonly<Record<string, FileReference>> = {',
        ...references.map(([type, reference]) => `    ${type}: ${JSON.stringify(reference)},`),
        '};',
        '',
    );
    return lines.join('\n');
}

function main() {
    const entities = ENTITY_DEFINITIONS;
    validateIndexes(entities);
    validateFileReferences(entities);
    const outputs = new Map([
        ['.generated/src/types.generated.ts', generateEventTypes(entities)],
        ['.generated/src/schema.generated.ts', generateDbSchema(entities)],
        ['.generated/src/standard-commands.generated.ts', generateCommands(entities)],
        ['.generated/src/standard-db.generated.ts', generateQueries(entities)],
        ['.generated/src/event-schemas.generated.ts', generateLedgerEventSchemas(entities)],
    ]);
    const check = process.argv.includes('--check');
    const stale: string[] = [];
    for (const [name, output] of outputs) {
        const destination = path.join(ROOT, name);
        if (fs.existsSync(destination) && fs.readFileSync(destination, 'utf8') === output) continue;
        if (check) stale.push(name);
        else {
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, output);
        }
    }
    if (stale.length) throw new Error(`Generated entity files are stale: ${stale.join(', ')}`);
    console.log(`${check ? 'Checked' : 'Generated'} ${entities.length} entity data APIs.`);
}

if (process.env.STOR_SKIP_ENTITY_GENERATION !== '1') main();
