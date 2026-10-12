import { db, requireActiveContext } from '../db/index.js';

/**
 * The active log's version as this device sees it: the contiguous accepted head
 * plus the local actions that have no version yet, so saving moves the number
 * before sync catches up. `null` while local data is not open.
 */
export const logVersion = $state<{ value: number | null }>({ value: null });

export async function refreshLogVersion(logId: string | null): Promise<void> {
    if (!logId) {
        logVersion.value = null;
        return;
    }
    try {
        const context = await requireActiveContext();
        const [head, pending] = await Promise.all([
            db.selectFrom('log_sync_state')
                .select('downloaded_head_version')
                .where('tenant_id', '=', context.tenantId)
                .where('log_id', '=', logId)
                .executeTakeFirst(),
            db.selectFrom('raw_events')
                .select((eb) => eb.fn.count('id').as('count'))
                .where('tenant_id', '=', context.tenantId)
                .where('log_id', '=', logId)
                .where('log_version', 'is', null)
                .where('projection_state', '=', 'effective')
                .executeTakeFirst(),
        ]);
        logVersion.value = (head?.downloaded_head_version ?? 0) + Number(pending?.count ?? 0);
    } catch {
        logVersion.value = null;
    }
}
