import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';

type Scope = { tenantId: string; logId: string };

/** Only successfully ingested positions can extend the contiguous prefix. */
export function contiguousThrough(previous: number, versions: readonly number[]): number {
    let through = previous;
    for (const version of [...new Set(versions)].sort((a, b) => a - b)) {
        if (version <= through) continue;
        if (version !== through + 1) break;
        through = version;
    }
    return through;
}

export async function recordIngestedProgress(
    database: Kysely<Database>, scope: Scope, versions: readonly number[],
): Promise<number> {
    return database.transaction().execute(async (tx) => {
        const previous = await tx.selectFrom('log_sync_state').selectAll()
            .where('tenant_id', '=', scope.tenantId).where('log_id', '=', scope.logId).executeTakeFirst();
        const through = contiguousThrough(previous?.downloaded_head_version ?? 0, versions);
        const projected = contiguousThrough(previous?.projected_head_version ?? 0, versions);
        await tx.insertInto('log_sync_state').values({
            tenant_id: scope.tenantId, log_id: scope.logId,
            downloaded_head_version: through, projected_head_version: projected,
            last_synced_at: new Date().toISOString(),
        }).onConflict(oc => oc.columns(['tenant_id', 'log_id']).doUpdateSet({
            downloaded_head_version: through, projected_head_version: projected,
            last_synced_at: new Date().toISOString(),
        })).execute();
        return through;
    });
}

/** Schema migration: old upload acknowledgements may have overstated progress.
 * Repair every stored scope atomically; never alter events or retry requests.
 */
export async function repairStoredProgress(database: Kysely<Database>): Promise<void> {
    await database.transaction().execute(async tx => {
        const scopes = await tx.selectFrom('log_sync_state').selectAll().execute();
        for (const scope of scopes) {
            const rows = await tx.selectFrom('raw_events').select('log_version').distinct()
                .where('tenant_id', '=', scope.tenant_id).where('log_id', '=', scope.log_id)
                .where('log_version', 'is not', null).orderBy('log_version').execute();
            const baseline = await tx.selectFrom('log_baselines').select('through_version')
                .where('tenant_id', '=', scope.tenant_id).where('log_id', '=', scope.log_id).executeTakeFirst();
            const complete = contiguousThrough(baseline?.through_version ?? 0, rows.map(row => row.log_version!));
            await tx.updateTable('log_sync_state').set({
                downloaded_head_version: Math.min(scope.downloaded_head_version, complete),
                projected_head_version: Math.min(scope.projected_head_version, complete),
            }).where('tenant_id', '=', scope.tenant_id).where('log_id', '=', scope.log_id).execute();
        }
    });
}
