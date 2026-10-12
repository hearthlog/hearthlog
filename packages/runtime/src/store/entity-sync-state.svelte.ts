import { db, requireActiveContext } from '../db/index.js';

export type EntitySyncState = 'pending' | 'blocked';

export const entitySyncState = $state<Record<string, EntitySyncState>>({});

export function getEntitySyncState(entityId: string): EntitySyncState | null {
    return entitySyncState[entityId] ?? null;
}

export async function refreshEntitySyncState(): Promise<void> {
    try {
        const context = await requireActiveContext();
        const rows = await db.selectFrom('raw_events as event')
            .leftJoin('outbox_operations as operation', 'operation.batch_id', 'event.local_batch_id')
            .select(['event.entity_id', 'event.sync_state', 'operation.status'])
            .where('event.tenant_id', '=', context.tenantId)
            .where('event.log_id', '=', context.logId)
            .where('event.projection_state', '=', 'effective')
            .where((eb) => eb.or([
                eb('event.sync_state', '=', 'pending'),
                eb('operation.status', '=', 'needs_attention'),
            ]))
            .execute();
        const next: Record<string, EntitySyncState> = {};
        for (const row of rows) {
            if (!row.entity_id || row.entity_id.startsWith('tombstone:')) continue;
            const state = row.status === 'needs_attention' ? 'blocked' : 'pending';
            if (state === 'blocked' || !next[row.entity_id]) next[row.entity_id] = state;
        }
        Object.keys(entitySyncState).forEach((key) => delete entitySyncState[key]);
        Object.assign(entitySyncState, next);
    } catch {
        Object.keys(entitySyncState).forEach((key) => delete entitySyncState[key]);
    }
}
