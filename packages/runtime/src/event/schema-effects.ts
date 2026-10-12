import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import { EVENTS_EXCISED, WORKSPACE_RESTORED } from '@hearthlog/contracts/history/replay-selection';

const SCHEMA_EFFECT_TYPES = [
    'ENTITY_TYPE_DEFINED',
    'ENTITY_TYPE_UPDATED',
    'ENTITY_TYPE_ARCHIVED',
    WORKSPACE_RESTORED,
];

/**
 * Directive events that change the projected schema (dynamic definitions and
 * restore pointers) must take the DDL rebuild path instead of a targeted
 * reprojection. Tombstones and excisions both qualify when they name a schema
 * event.
 */
export async function schemaTombstoneIds(
    database: Kysely<Database> | Transaction<Database>,
    scope: { tenantId: string; logId: string },
    events: ReadonlyArray<{ id: string; type: string; payload: unknown }>,
): Promise<Set<string>> {
    const tombstones = events.filter(event => event.type === 'EVENT_TOMBSTONED');
    const excisions = events.filter(event => event.type === EVENTS_EXCISED);
    if (!tombstones.length && !excisions.length) return new Set();
    const targetIds = [
        ...tombstones.map(event => (event.payload as { eventId: string }).eventId),
        ...excisions.flatMap(event => (event.payload as { eventIds: string[] }).eventIds),
    ];
    if (!targetIds.length) return new Set();
    const targets = await database.selectFrom('raw_events').select('id')
        .where('tenant_id', '=', scope.tenantId).where('log_id', '=', scope.logId)
        .where('id', 'in', targetIds)
        .where('type', 'in', SCHEMA_EFFECT_TYPES).execute();
    const schemaTargetIds = new Set(targets.map(row => row.id));
    const result = new Set<string>();
    for (const tombstone of tombstones) {
        if (schemaTargetIds.has((tombstone.payload as { eventId: string }).eventId)) result.add(tombstone.id);
    }
    for (const excision of excisions) {
        const targets = (excision.payload as { eventIds: string[] }).eventIds;
        if (targets.some(id => schemaTargetIds.has(id))) result.add(excision.id);
    }
    return result;
}
