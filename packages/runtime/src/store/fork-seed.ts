import { sql } from 'kysely';
import { db, type ActiveContext } from '../db/index.js';
import { SERVER_BATCH_ID } from '../event/handlers.js';
import { logs } from './logs.svelte.js';

class SeedMismatch extends Error {}

/**
 * Fill a new fork from its source log already on this device, instead of downloading the shared prefix again.
 * Ledger copies a fork's events through its fork point with the same ids, versions, entity versions, timestamps,
 * authors and actions, so copying the source's accepted rows stores exactly what downloading them would.
 *
 * Only when that copy is certain: the fork holds nothing locally yet, the source is downloaded without gaps through
 * the fork point, has no snapshot standing in for its early history, and no restore, removal or undo up to the fork
 * point (they change which events replay). Otherwise, or if the copy does not cover every version exactly once, it
 * rolls back and the fork downloads as before. Returns whether the fork was seeded.
 */
export async function seedForkFromSource(context: ActiveContext): Promise<boolean> {
    const fork = logs.value.find((log) => log.id === context.logId);
    const sourceLogId = fork?.sourceLogId;
    const through = fork?.sourceVersion ?? 0;
    if (!fork || !sourceLogId || through <= 0) return false;
    const { tenantId } = context;
    try {
        return await db.transaction().execute(async (tx) => {
            const occupied = await tx.selectFrom('raw_events').select('id')
                .where('tenant_id', '=', tenantId).where('log_id', '=', fork.id).limit(1).executeTakeFirst();
            if (occupied) return false;
            const progress = await tx.selectFrom('log_sync_state').select('downloaded_head_version')
                .where('tenant_id', '=', tenantId).where('log_id', '=', sourceLogId).executeTakeFirst();
            if ((progress?.downloaded_head_version ?? 0) < through) return false;
            const baseline = await tx.selectFrom('log_baselines').select('through_version')
                .where('tenant_id', '=', tenantId).where('log_id', '=', sourceLogId).executeTakeFirst();
            if (baseline) return false;
            const directive = await tx.selectFrom('raw_events').select('id')
                .where('tenant_id', '=', tenantId).where('log_id', '=', sourceLogId)
                .where('type', 'in', ['WORKSPACE_RESTORED', 'EVENTS_EXCISED', 'EVENT_TOMBSTONED'])
                .where('log_version', '<=', through).limit(1).executeTakeFirst();
            if (directive) return false;

            await sql`
                INSERT INTO raw_events (id, tenant_id, log_id, local_batch_id, local_sequence, action_id, action_index,
                    action_size, actor, type, timestamp, payload, entity_id, entity_version, log_version, sync_state,
                    projection_state, rejection_code, rejection_detail, is_tombstoned)
                SELECT id, tenant_id, ${fork.id}, ${SERVER_BATCH_ID}, log_version, action_id, action_index,
                    action_size, actor, type, timestamp, payload, entity_id, entity_version, log_version, 'synced',
                    'effective', NULL, NULL, 0
                FROM raw_events
                WHERE tenant_id = ${tenantId} AND log_id = ${sourceLogId}
                  AND log_version IS NOT NULL AND log_version <= ${through}
                  AND sync_state = 'synced' AND projection_state = 'effective'
            `.execute(tx);
            const copied = await tx.selectFrom('raw_events')
                .select((eb) => [eb.fn.countAll<number>().as('rows'), eb.fn.max('log_version').as('head'),
                    sql<number>`COUNT(DISTINCT log_version)`.as('versions')])
                .where('tenant_id', '=', tenantId).where('log_id', '=', fork.id).executeTakeFirstOrThrow();
            if (Number(copied.rows) !== through || Number(copied.versions) !== through || Number(copied.head) !== through) {
                throw new SeedMismatch();
            }
            await tx.insertInto('log_sync_state').values({
                tenant_id: tenantId, log_id: fork.id,
                downloaded_head_version: through, projected_head_version: through,
                last_synced_at: new Date().toISOString(),
            }).onConflict((oc) => oc.columns(['tenant_id', 'log_id']).doUpdateSet({
                downloaded_head_version: through, projected_head_version: through,
            })).execute();
            return true;
        });
    } catch (error) {
        if (error instanceof SeedMismatch) return false;
        throw error;
    }
}
