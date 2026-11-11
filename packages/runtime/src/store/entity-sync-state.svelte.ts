import { sql } from 'kysely';
import { db, requireActiveContext } from '../db/index.js';

export type EntitySyncState = 'pending' | 'blocked';

export const entitySyncState = $state<Record<string, EntitySyncState>>({});

export function getEntitySyncState(entityId: string): EntitySyncState | null {
    return entitySyncState[entityId] ?? null;
}

export async function refreshEntitySyncState(): Promise<void> {
    try {
        const context = await requireActiveContext();
        // Two indexed branches instead of one OR across a join, which scanned every event of the log on each
        // save and sync. Pending events never carry a log version (the schema migration enforces it), so the
        // first branch reads only the unsynced tail of idx_raw_events_scope_order.
        const pending = db.selectFrom('raw_events')
            .select(['entity_id', sql<'pending' | 'blocked'>`'pending'`.as('state')])
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('log_version', 'is', null)
            .where('sync_state', '=', 'pending')
            .where('projection_state', '=', 'effective');
        const blocked = db.selectFrom('outbox_operations as operation')
            .innerJoin('raw_events as event', (join) => join
                .onRef('event.tenant_id', '=', 'operation.tenant_id')
                .onRef('event.log_id', '=', 'operation.log_id')
                .onRef('event.local_batch_id', '=', 'operation.batch_id'))
            .select(['event.entity_id', sql<'pending' | 'blocked'>`'blocked'`.as('state')])
            .where('operation.tenant_id', '=', context.tenantId)
            .where('operation.log_id', '=', context.logId)
            .where('operation.status', '=', 'needs_attention')
            .where('event.projection_state', '=', 'effective');
        const rows = await pending.unionAll(blocked).execute();
        const next: Record<string, EntitySyncState> = {};
        for (const row of rows) {
            if (!row.entity_id || row.entity_id.startsWith('tombstone:')) continue;
            if (row.state === 'blocked' || !next[row.entity_id]) next[row.entity_id] = row.state;
        }
        Object.keys(entitySyncState).forEach((key) => delete entitySyncState[key]);
        Object.assign(entitySyncState, next);
    } catch {
        Object.keys(entitySyncState).forEach((key) => delete entitySyncState[key]);
    }
}
