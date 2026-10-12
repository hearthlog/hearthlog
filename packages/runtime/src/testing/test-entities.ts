import type { EntityDefinition } from '@hearthlog/contracts/event/entity-definitions';

/**
 * An entity that exists only in tests, for rules the core's own entity cannot show: a numeric field
 * (`test_amount`, in the always-enabled calendar feature). A test adds it with
 *
 *     vi.mock('@hearthlog/contracts/event/entity-definitions', async (importOriginal) =>
 *         (await import('./test-entities.js')).withTestEntities(await importOriginal()));
 *
 * so the registry, validation, and projection configs all see it. It has no generated table: a test
 * that projects it creates the table itself.
 */
export const TEST_ENTITY_DEFINITIONS: EntityDefinition[] = [
    {
        name: 'test_amount',
        feature: 'calendar',
        displayName: 'Test amount',
        table: 'test_amounts',
        fields: [
            { name: 'name', type: 'string', payloadKey: 'name', required: true },
            { name: 'amount', type: 'number', payloadKey: 'amount', required: true },
        ],
    },
];

export function withTestEntities<T extends { ENTITY_DEFINITIONS: EntityDefinition[] }>(original: T): T {
    return { ...original, ENTITY_DEFINITIONS: [...original.ENTITY_DEFINITIONS, ...TEST_ENTITY_DEFINITIONS] };
}
