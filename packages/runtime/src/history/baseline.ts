import { sql, type Insertable, type Kysely } from 'kysely';
import { checkpointDigest, verifyCheckpointManifest, type CheckpointEvent, type CheckpointManifest } from '@hearthlog/contracts/history/checkpoint';
import { db, requireActiveContext, type Database, type RawEventTable } from '../db/index.js';
import { getLedgerClient } from '../ledger/client.js';
import { SCHEMA_LOCK_NAME, withTabLock, postTabChange } from '../store/tab-coordination.js';
import { rebuildProjectionState } from '../event/rebuild.js';
import { loadDynamicEntityTypes } from '../event/dynamic-entities.js';
import type { ActiveContext } from '../db/index.js';

function row(event: CheckpointEvent, context: ActiveContext): Insertable<RawEventTable> {
    return { id: event.id, tenant_id: context.tenantId, log_id: context.logId,
        local_batch_id: `checkpoint:${event.id}`, local_sequence: event.version,
        action_id: event.action?.id ?? null, action_index: event.action?.index ?? null, action_size: event.action?.size ?? null,
        actor: event.actor ?? null, type: event.type, timestamp: event.timestamp, payload: JSON.stringify(event.payload),
        entity_id: event.entityId, entity_version: event.entityVersion, log_version: event.version,
        sync_state: 'synced', projection_state: 'effective', is_tombstoned: 0, rejection_code: null, rejection_detail: null };
}

export async function baselineVersion(context: Pick<ActiveContext, 'tenantId' | 'logId'>): Promise<number> {
    const result = await db.selectFrom('log_baselines').select('through_version')
        .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId).executeTakeFirst();
    return result?.through_version ?? 0;
}

export const REPLAY_DIRECTIVES = ['WORKSPACE_RESTORED', 'EVENTS_EXCISED', 'EVENT_TOMBSTONED'] as const;

/**
 * Whether replay directives accepted after the baseline need history the baseline has folded away: a restore to a
 * version before it, or a removal/undo whose target is not a pending or later event. Anything unreadable counts as
 * reaching behind, so the caller falls back to the complete history.
 */
export async function directivesReachBehind(
    context: Pick<ActiveContext, 'tenantId' | 'logId'>,
    through: number,
    directives: ReadonlyArray<{ type: string; payload: unknown }>,
    laterIds: ReadonlySet<string> = new Set(),
): Promise<boolean> {
    const targets = new Set<string>();
    for (const directive of directives) {
        let payload: unknown = directive.payload;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch { return true; }
        }
        if (typeof payload !== 'object' || payload === null) return true;
        const body = payload as Record<string, unknown>;
        if (directive.type === 'WORKSPACE_RESTORED') {
            // The target's position must be present in the suffix, so even a restore to the baseline version itself needs history.
            if (typeof body.targetVersion !== 'number' || body.targetVersion <= through) return true;
        } else if (directive.type === 'EVENT_TOMBSTONED') {
            if (typeof body.eventId !== 'string' || !body.eventId) return true;
            targets.add(body.eventId);
        } else if (directive.type === 'EVENTS_EXCISED') {
            if (!Array.isArray(body.eventIds) || body.eventIds.some(id => typeof id !== 'string' || !id)) return true;
            for (const id of body.eventIds as string[]) targets.add(id);
        } else {
            return true;
        }
    }
    const missing = [...targets].filter(id => !laterIds.has(id));
    for (let offset = 0; offset < missing.length; offset += 400) {
        const chunk = missing.slice(offset, offset + 400);
        const present = await db.selectFrom('raw_events').select('id')
            .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId).where('id', 'in', chunk)
            .where(eb => eb.or([eb('log_version', 'is', null), eb('log_version', '>', through)])).execute();
        if (present.length < chunk.length) return true;
    }
    return false;
}

/** Install only verified chunks; publish base, projections, claims and coverage together. */
export async function installBaseline(manifest: CheckpointManifest, context: ActiveContext): Promise<void> {
    const client = getLedgerClient();
    const session = await client.getSession();
    verifyCheckpointManifest(manifest, session.appId, context.logId);
    if (await checkpointDigest(JSON.stringify(manifest.pages)) !== manifest.sha256) throw new Error('Invalid snapshot manifest digest');
    await withTabLock(SCHEMA_LOCK_NAME, async () => {
        if (await baselineVersion(context) >= manifest.throughVersion) return;
        await sql`DROP TABLE IF EXISTS temp.checkpoint_stage`.execute(db);
        await sql`DROP TABLE IF EXISTS temp.checkpoint_claim_stage`.execute(db);
        await sql`CREATE TEMP TABLE checkpoint_stage AS SELECT * FROM raw_events WHERE 0`.execute(db);
        await sql`CREATE TEMP TABLE checkpoint_claim_stage AS SELECT * FROM entity_versions WHERE 0`.execute(db);
        try {
            for (const [index, page] of manifest.pages.entries()) {
                const chunk = await client.getCheckpointChunk(context.logId, index);
                const encoded = JSON.stringify(chunk);
                if (await checkpointDigest(encoded) !== page.sha256 || chunk.events.length !== page.count
                    || chunk.events.some(event => !Number.isSafeInteger(event.version) || event.version < 1 || event.version > manifest.throughVersion)
                    || chunk.claims.some(claim => !claim.entityId || !Number.isSafeInteger(claim.currentVersion) || claim.currentVersion < 1
                        || !Number.isSafeInteger(claim.logVersion) || claim.logVersion < 1 || claim.logVersion > manifest.throughVersion)) {
                    throw new Error('Snapshot page verification failed');
                }
                for (const event of chunk.events) {
                    const values = row(event, context);
                    await sql`INSERT INTO temp.checkpoint_stage
                        (id, tenant_id, log_id, local_batch_id, local_sequence, action_id, action_index, action_size, actor,
                         type, timestamp, payload, entity_id, entity_version, log_version, sync_state, projection_state,
                         is_tombstoned, rejection_code, rejection_detail)
                        VALUES (${values.id}, ${values.tenant_id}, ${values.log_id}, ${values.local_batch_id}, ${values.local_sequence},
                            ${values.action_id ?? null}, ${values.action_index ?? null}, ${values.action_size ?? null}, ${values.actor ?? null},
                            ${values.type}, ${values.timestamp}, ${values.payload}, ${values.entity_id}, ${values.entity_version}, ${values.log_version},
                            'synced', 'effective', 0, NULL, NULL)`.execute(db);
                }
                for (const claim of chunk.claims) {
                    await sql`INSERT INTO temp.checkpoint_claim_stage VALUES (${context.tenantId}, ${context.logId},
                        ${claim.entityId}, ${claim.currentVersion}, ${claim.logVersion}, ${Date.now()})`.execute(db);
                }
            }
            const active = await requireActiveContext();
            if (active.tenantId !== context.tenantId || active.logId !== context.logId) throw new Error('Selected log changed while loading snapshot');
            await db.transaction().execute(async tx => {
                await tx.deleteFrom('checkpoint_events').where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId).execute();
                await tx.deleteFrom('checkpoint_claims').where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId).execute();
                // Only replace the accepted prefix. Pending/rejected events and
                // immutable outbox requests retain their original identities.
                await tx.deleteFrom('raw_events').where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId)
                    .where('sync_state', '=', 'synced').where('log_version', '<=', manifest.throughVersion).execute();
                await sql`INSERT INTO checkpoint_events SELECT * FROM temp.checkpoint_stage`.execute(tx);
                await sql`INSERT INTO checkpoint_claims SELECT * FROM temp.checkpoint_claim_stage`.execute(tx);
                await tx.insertInto('log_baselines').values({ tenant_id: context.tenantId, log_id: context.logId,
                    through_version: manifest.throughVersion, manifest: JSON.stringify(manifest) })
                    .onConflict(oc => oc.columns(['tenant_id', 'log_id']).doUpdateSet({ through_version: manifest.throughVersion, manifest: JSON.stringify(manifest) })).execute();
                await rebuildProjectionState(tx, context);
                await rebuildCheckpointVersions(tx, context);
                await tx.insertInto('log_sync_state').values({ tenant_id: context.tenantId, log_id: context.logId,
                    downloaded_head_version: manifest.throughVersion, projected_head_version: manifest.throughVersion, last_synced_at: new Date().toISOString() })
                    .onConflict(oc => oc.columns(['tenant_id', 'log_id']).doUpdateSet(eb => ({
                        downloaded_head_version: eb.fn('max', ['downloaded_head_version', eb.val(manifest.throughVersion)]),
                        projected_head_version: eb.fn('max', ['projected_head_version', eb.val(manifest.throughVersion)]),
                    }))).execute();
            });
            await loadDynamicEntityTypes();
            postTabChange({ kind: 'rebuild', tenantId: context.tenantId, logId: context.logId });
        } finally {
            await sql`DROP TABLE IF EXISTS temp.checkpoint_stage`.execute(db);
            await sql`DROP TABLE IF EXISTS temp.checkpoint_claim_stage`.execute(db);
        }
    });
}

export async function rebuildCheckpointVersions(database: Kysely<Database>, context: ActiveContext): Promise<void> {
    await sql`INSERT INTO entity_versions (tenant_id, log_id, entity_id, current_version, log_version, updated_at)
        SELECT tenant_id, log_id, entity_id, MAX(current_version), MAX(log_version), MAX(updated_at) FROM (
            SELECT tenant_id, log_id, entity_id, current_version, log_version, updated_at FROM checkpoint_claims
            UNION ALL SELECT tenant_id, log_id, entity_id, entity_version, log_version, timestamp FROM raw_events
                WHERE sync_state = 'synced' AND entity_id IS NOT NULL AND entity_version IS NOT NULL AND log_version IS NOT NULL
        ) WHERE tenant_id = ${context.tenantId} AND log_id = ${context.logId} GROUP BY tenant_id, log_id, entity_id
        ON CONFLICT(tenant_id, log_id, entity_id) DO UPDATE SET current_version = excluded.current_version,
            log_version = excluded.log_version, updated_at = excluded.updated_at`.execute(database);
}

/** Explicit historical inspection/directive fallback, never the ordinary sync path. */
export async function loadArchivedHistory(): Promise<void> {
    const context = await requireActiveContext();
    const through = await baselineVersion(context);
    if (!through) return;
    await withTabLock(SCHEMA_LOCK_NAME, async () => {
        const client = getLedgerClient();
        await sql`DROP TABLE IF EXISTS temp.archived_history_stage`.execute(db);
        await sql`CREATE TEMP TABLE archived_history_stage AS SELECT * FROM raw_events WHERE 0`.execute(db);
        let cursor = 0;
        try {
            while (cursor < through) {
                const events = await client.getEventPage(context.logId, cursor, 128);
                if (!events.length) throw new Error('Archived history is incomplete');
                for (const event of events) {
                    if (event.version > through) break;
                    if (event.version !== cursor + 1) throw new Error('Archived history contains a gap');
                    const value = row(event, context);
                    const keys = Object.keys(value) as Array<keyof typeof value>;
                    await sql`INSERT INTO temp.archived_history_stage (${sql.join(keys.map(key => sql.ref(key)))})
                        VALUES (${sql.join(keys.map(key => sql.val(value[key])))})`.execute(db);
                    cursor = event.version;
                }
            }
            const active = await requireActiveContext();
            if (active.tenantId !== context.tenantId || active.logId !== context.logId) throw new Error('Selected log changed while loading history');
            await db.transaction().execute(async tx => {
                // A lost acknowledgement can leave the same event pending
                // locally. Adopt its accepted metadata without changing the
                // original payload, local batch identity, or outbox body.
                await sql`INSERT INTO raw_events SELECT * FROM temp.archived_history_stage WHERE 1
                    ON CONFLICT(tenant_id, log_id, id) DO UPDATE SET
                        log_version = excluded.log_version, entity_version = excluded.entity_version,
                        action_id = COALESCE(excluded.action_id, raw_events.action_id),
                        action_index = COALESCE(excluded.action_index, raw_events.action_index),
                        action_size = COALESCE(excluded.action_size, raw_events.action_size),
                        actor = COALESCE(excluded.actor, raw_events.actor), sync_state = 'synced',
                        projection_state = 'effective', rejection_code = NULL, rejection_detail = NULL`.execute(tx);
                await sql`UPDATE local_batches SET status = CASE WHEN EXISTS (
                    SELECT 1 FROM raw_events pending WHERE pending.tenant_id = local_batches.tenant_id
                        AND pending.log_id = local_batches.log_id AND pending.local_batch_id = local_batches.id
                        AND pending.log_version IS NULL
                    ) THEN 'pending' ELSE 'synced' END
                    WHERE tenant_id = ${context.tenantId} AND log_id = ${context.logId}
                        AND id IN (SELECT raw.local_batch_id FROM raw_events raw
                            JOIN temp.archived_history_stage staged USING(tenant_id, log_id, id))`.execute(tx);
                // Receipt-only rows were excluded from projection because their
                // prefix was already represented by the baseline. Full replay
                // now restores their original membership interpretation.
                await sql`UPDATE raw_events SET projection_state = 'effective'
                    WHERE tenant_id = ${context.tenantId} AND log_id = ${context.logId}
                      AND projection_state = 'baseline_covered' AND log_version <= ${through}`.execute(tx);
                for (const table of ['checkpoint_events', 'checkpoint_claims', 'log_baselines'] as const) {
                    await tx.deleteFrom(table).where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId).execute();
                }
                await rebuildProjectionState(tx, context);
                await rebuildCheckpointVersions(tx, context);
            });
            await loadDynamicEntityTypes();
            postTabChange({ kind: 'rebuild', tenantId: context.tenantId, logId: context.logId });
        } finally {
            await sql`DROP TABLE IF EXISTS temp.archived_history_stage`.execute(db);
        }
    });
}
