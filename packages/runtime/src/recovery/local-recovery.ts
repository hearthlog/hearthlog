import { bootstrapLocalStore, type LocalStoreBootstrapResult } from '../db/bootstrap.js';
import { db, requireActiveContext, sqlocalDb } from '../db/index.js';
import { shutdownSynchronization } from '../store/sync.svelte.js';
import { executeLocalReset, type ResetDependencies } from './reset-sequence.js';

export type { ResetDependencies } from './reset-sequence.js';

export interface LocalRecoverySummary {
    pending: number | null;
    blocked: number | null;
}

export async function getLocalRecoverySummary(): Promise<LocalRecoverySummary> {
    try {
        const context = await requireActiveContext();
        const [pending, blocked] = await Promise.all([
            db.selectFrom('raw_events').select((eb) => eb.fn.count('id').as('count'))
                .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId)
                .where('sync_state', 'in', ['pending', 'conflicted']).executeTakeFirst(),
            db.selectFrom('outbox_operations').select((eb) => eb.fn.count('id').as('count'))
                .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId)
                .where('status', '=', 'needs_attention').executeTakeFirst(),
        ]);
        return { pending: Number(pending?.count ?? 0), blocked: Number(blocked?.count ?? 0) };
    } catch {
        return { pending: null, blocked: null };
    }
}

export async function getLocalDatabaseFile(): Promise<Blob> {
    return await sqlocalDb.getDatabaseFile() as unknown as Blob;
}

export async function downloadLocalDatabase(): Promise<void> {
    const file = await getLocalDatabaseFile();
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = `stor-${new Date().toISOString().slice(0, 10)}.sqlite3`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

export function retryLocalMigration(): Promise<LocalStoreBootstrapResult> {
    return bootstrapLocalStore();
}

export async function resetLocalDataFromLedger(
    dependencies: ResetDependencies = {
        stopSynchronization: shutdownSynchronization,
        deleteDatabase: () => sqlocalDb.deleteDatabaseFile(),
        markReset: () => sessionStorage.setItem('databaseReset', 'true'),
        hardReload: () => location.reload(),
    },
): Promise<void> {
    await executeLocalReset(dependencies);
}
