import { sql } from 'kysely';
import type { ReadModelSession } from '../db/read-session.js';
import { ENTITY_DEFINITIONS, getPayloadKey } from '@hearthlog/contracts/event/entity-definitions';
import { parseEntityFields } from './dynamic-entities.js';
import type { DynamicFieldDefinition } from './meta-entity-types.js';
import { quoteIdentifier } from './projection-builder.js';
import { withTimeout } from '../utils/async.js';
import { tenant } from '@hearthlog/contracts/tenant/config';

export interface ReferencingEntity {
    entityType: string;
    entityTypeDisplayName: string;
    entityId: string;
    entityLabel: string;
    fieldName: string;
}

export interface ReferencedByResult {
    byType: Record<string, ReferencingEntity[]>;
    totalCount: number;
}

export function createReferenceLookup(session: ReadModelSession) {
    return {
        async findReferencingEntities(
            targetEntityId: string,
            targetEntityType?: string,
        ): Promise<ReferencedByResult> {
            const result: ReferencedByResult = { byType: {}, totalCount: 0 };
            const dynamic = await session.selectFrom('entity_type_definitions')
                .selectAll()
                .where('is_archived', '=', 0)
                .execute();
            const entityTypes = [
                ...ENTITY_DEFINITIONS
                    .filter((definition) => tenant.approvedEntities.entityNames.has(definition.name))
                    .map((definition) => ({
                        name: definition.name,
                        display_name: definition.displayName ?? definition.name,
                        table_name: definition.table,
                        fields: definition.fields.map((field) => ({
                            ...field,
                            payloadKey: getPayloadKey(field),
                        })) as DynamicFieldDefinition[],
                    })),
                ...(tenant.dynamicEntities ? dynamic : []).map((definition) => ({
                    name: definition.name,
                    display_name: definition.display_name,
                    table_name: definition.table_name,
                    fields: parseEntityFields(definition),
                })),
            ];

            for (const entityType of entityTypes) {
                const fields = entityType.fields.filter((field) =>
                    field.type === 'reference' &&
                    (!targetEntityType || field.referenceTo === targetEntityType) &&
                    (!field.referenceTo || isVisibleEntityType(field.referenceTo)));
                for (const field of fields) {
                    const rows = await withTimeout(
                        session.execute(sql<Record<string, unknown>>`
                            SELECT *
                            FROM ${session.table(entityType.table_name)}
                            WHERE ${sql.raw(quoteIdentifier(field.name))} = ${targetEntityId}
                            LIMIT 50
                        `),
                        5000,
                        'Reference lookup query timed out',
                    );
                    for (const row of rows.rows) {
                        const item: ReferencingEntity = {
                            entityType: entityType.name,
                            entityTypeDisplayName: entityType.display_name,
                            entityId: String(row.id),
                            entityLabel: String(row.name ?? row.title ?? row.label ?? row.id),
                            fieldName: field.name,
                        };
                        (result.byType[entityType.name] ??= []).push(item);
                        result.totalCount += 1;
                    }
                }
            }
            return result;
        },
    };
}

function isVisibleEntityType(name: string): boolean {
    const definition = ENTITY_DEFINITIONS.find((candidate) => candidate.name === name);
    return definition
        ? tenant.approvedEntities.entityNames.has(name)
        : tenant.dynamicEntities;
}
