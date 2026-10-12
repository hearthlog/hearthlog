import { sql } from 'kysely';
import { normalizeCalendarSources, serializeCalendarConfig } from '@hearthlog/contracts/calendar/config';
import type { EntityTypeRecord } from './dynamic-ddl.js';
import { ENTITY_DEFINITIONS, getEntityDefinition, getPayloadKey } from '@hearthlog/contracts/event/entity-definitions';
import { parseEntityFields } from '../event/dynamic-entities.js';
import type { DynamicFieldDefinition } from '../event/meta-entity-types.js';
import { quoteIdentifier } from '../event/projection-builder.js';
import type { ReadModelSession } from './read-session.js';
import { withTimeout } from '../utils/async.js';
import { tenant } from '@hearthlog/contracts/tenant/config';

const DB_TIMEOUT_MS = 5000;

export type EntityTypeWithStatic = EntityTypeRecord & { is_static?: boolean };

export interface EntityQuery {
    search: string;
    pageSize: number;
    requestedPage: number;
    sortField: string | null;
    sortDirection: 'asc' | 'desc';
}

export function createEntityRepository(session: ReadModelSession) {
    const { scope } = session;

    async function getDynamicDefinition(name: string): Promise<EntityTypeRecord | null> {
        const record = await session.selectFrom('entity_type_definitions')
            .selectAll()
            .where('name', '=', name)
            .where('is_archived', '=', 0)
            .executeTakeFirst();
        return record as EntityTypeRecord | undefined ?? null;
    }

    function staticRecord(name: string): EntityTypeWithStatic | null {
        const definition = getEntityDefinition(name);
        if (!definition) return null;
        return {
            tenant_id: scope.tenantId,
            log_id: scope.logId,
            id: definition.name,
            name: definition.name,
            display_name: definition.displayName ?? titleCase(definition.name),
            table_name: definition.table,
            fields_json: JSON.stringify(definition.fields),
            calendar_json: serializeCalendarConfig(
                normalizeCalendarSources(definition.calendar),
            ),
            is_archived: 0,
            created_at: session.view.effectiveNow,
            updated_at: session.view.effectiveNow,
            is_static: true,
        };
    }

    async function getEntityType(name: string): Promise<{
        record: EntityTypeWithStatic;
        fields: DynamicFieldDefinition[];
    } | null> {
        // Static names are reserved and take precedence over dynamic records.
        // Check the tenant approval before touching the projection so a direct
        // URL/reference lookup cannot query a disabled feature's table.
        const definition = getEntityDefinition(name);
        if (definition) {
            if (!tenant.approvedEntities.entityNames.has(name)) return null;
            const record = staticRecord(name);
            if (!record) return null;
            return {
                record,
                fields: definition.fields.map((field) => ({
                    ...field,
                    payloadKey: getPayloadKey(field),
                })) as DynamicFieldDefinition[],
            };
        }

        if (!tenant.dynamicEntities) return null;
        const dynamic = await getDynamicDefinition(name);
        if (dynamic) {
            return {
                record: dynamic,
                fields: parseEntityFields(dynamic),
            };
        }
        return null;
    }

    async function loadReferenceOptions(entityName: string): Promise<Array<{ id: string; label: string }>> {
        const target = await getEntityType(entityName);
        if (!target) return [];
        const displayField = ['name', 'title', 'label'].find((candidate) =>
            target.fields.some((field) => field.name === candidate));
        const columns = ['id', displayField].filter(Boolean) as string[];
        const orderBy = displayField
            ? sql`ORDER BY ${sql.raw(quoteIdentifier(displayField))} ASC`
            : sql``;
        const rows = await withTimeout(
            session.execute(sql<Record<string, unknown>>`
                SELECT ${sql.raw(columns.map(quoteIdentifier).join(', '))}
                FROM ${session.table(target.record.table_name)}
                ${orderBy}
                LIMIT 100
            `),
            DB_TIMEOUT_MS,
            `Reference query for ${entityName} timed out`,
        );
        return rows.rows.map((row) => ({
            id: String(row.id),
            label: String(row.name ?? row.title ?? row.label ?? row.id),
        }));
    }

    return {
        async getEntityCatalog(): Promise<EntityTypeWithStatic[]> {
            const dynamic = await withTimeout(
                session.selectFrom('entity_type_definitions')
                    .selectAll()
                    .where('is_archived', '=', 0)
                    .orderBy('display_name', 'asc')
                    .execute(),
                DB_TIMEOUT_MS,
                'Entity catalog query timed out',
            );
            // Feature scoping: only entities the tenant is approved for are
            // part of the catalog (dynamic types are per-log and always shown).
            const approvedStatic = ENTITY_DEFINITIONS.filter(
                (definition) => tenant.approvedEntities.entityNames.has(definition.name),
            ).map((definition) => staticRecord(definition.name)!);
            return [
                ...approvedStatic,
                ...(tenant.dynamicEntities ? dynamic as EntityTypeRecord[] : []),
            ].sort((left, right) => left.display_name.localeCompare(right.display_name));
        },

        getEntityType,

        async queryEntities(entityName: string, query: EntityQuery) {
            const entityType = await getEntityType(entityName);
            if (!entityType) return null;
            const searchableColumns = [...new Set(['id', ...entityType.fields.map((field) => field.name)])];
            const where = buildSearchWhere(searchableColumns, query.search);
            const countRows = await withTimeout(
                session.execute(sql<{ count: number | string }>`
                    SELECT COUNT(*) AS count
                    FROM ${session.table(entityType.record.table_name)}
                    ${where}
                `),
                DB_TIMEOUT_MS,
                `Count query for ${entityName} timed out`,
            );
            const totalRows = Number(countRows.rows[0]?.count ?? 0);
            const totalPages = Math.max(1, Math.ceil(totalRows / query.pageSize));
            const currentPage = Math.min(query.requestedPage, totalPages);
            const offset = (currentPage - 1) * query.pageSize;
            const sortableFields = new Set(entityType.fields.map((field) => field.name));
            const sortField = query.sortField && sortableFields.has(query.sortField)
                ? query.sortField
                : null;
            const orderBy = sortField
                ? sql`ORDER BY ${sql.raw(quoteIdentifier(sortField))} ${sql.raw(query.sortDirection.toUpperCase())}`
                : sql`ORDER BY ${sql.raw(quoteIdentifier('id'))} ASC`;
            const rows = await withTimeout(
                session.execute(sql<Record<string, unknown>>`
                    SELECT *
                    FROM ${session.table(entityType.record.table_name)}
                    ${where}
                    ${orderBy}
                    LIMIT ${query.pageSize}
                    OFFSET ${offset}
                `),
                DB_TIMEOUT_MS,
                `Query for ${entityName} timed out`,
            );
            const referenceOptionEntries = await Promise.all(
                entityType.fields
                    .filter((field) => field.type === 'reference' && field.referenceTo)
                    .map(async (field) => [field.name, await loadReferenceOptions(field.referenceTo!)] as const),
            );
            return {
                entityType: entityType.record,
                fields: entityType.fields,
                entities: rows.rows,
                referenceOptions: Object.fromEntries(referenceOptionEntries),
                referencedBy: {},
                search: query.search,
                sortField,
                sortDirection: query.sortDirection,
                currentPage,
                pageSize: query.pageSize,
                totalRows,
                totalPages,
            };
        },
    };
}

function buildSearchWhere(columns: string[], search: string) {
    if (!search) return sql``;
    const pattern = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    const clauses = columns.map((column) =>
        sql`CAST(${sql.raw(quoteIdentifier(column))} AS TEXT) LIKE ${pattern} ESCAPE ${'\\'}`);
    return sql`WHERE (${sql.join(clauses, sql` OR `)})`;
}

function titleCase(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
