import { invalidate } from "$app/navigation";
import { MODULE_REFRESH_KEYS } from '#generated/modules';
import {
    getLedgerClient,
    type CreateLogResponse,
    type LogSummary,
} from "./ledger/index.js";
import { db, requireActiveContext } from './db/index.js';
import { eventLogFilename } from "./store/event-log.svelte.js";
import { logs } from "./store/logs.svelte.js";
import {
    loadStoredLogSnapshot,
    runSyncCoordinator,
    stopRealtime,
    syncStatus,
} from "./store/sync.svelte.js";
import {
    beginReadTargetTransition,
    cancelReadTargetTransition,
} from "./runtime/read-coordinator.js";
import { validateNewLogName } from "./log-validation.js";
import { announceInvalidation } from "./runtime/invalidation.js";

async function invalidateAllViews(): Promise<void> {
    const keys = [...MODULE_REFRESH_KEYS, "app:entities", "app:entity-types"];
    announceInvalidation(keys);
    await Promise.all(keys.map((key) => invalidate(key)));
}

/** Resume copying inherited private files; safe to call after an interrupted tab. */
export async function prepareForkFiles(logId: string, onProgress?: (message: string) => void): Promise<void> {
    let status = 'preparing';
    while (status !== 'ready') {
        const response = await fetch(`/api/log-forks/v1/${logId}/prepare`, { method: 'POST' });
        const result = await response.json() as { status?: string; error?: string; remaining?: number };
        if (!response.ok) throw new Error(result.error ?? 'Could not prepare this fork.');
        status = result.status ?? 'preparing';
        if (status !== 'ready') {
            if (status !== 'preparing' || !Number.isSafeInteger(result.remaining) || (result.remaining ?? 0) < 1) {
                throw new Error('Fork preparation did not report progress. Try again.');
            }
            onProgress?.(`Preparing documents… ${result.remaining} remaining`);
        }
    }
}

/** Create a server log and make its empty read model active in this tab. */
export async function createAndActivateLog(name: string): Promise<CreateLogResponse> {
    const normalized = validateNewLogName(name, logs.value);
    const response = await getLedgerClient().createLog({ name: normalized });

    await logs.refresh();

    let transitionStarted = false;
    try {
        beginReadTargetTransition();
        transitionStarted = true;
        await stopRealtime();
        await eventLogFilename.set(response.id, response.name || normalized);
        await loadStoredLogSnapshot(response.id, []);
        await runSyncCoordinator("manual");
        await invalidateAllViews();
        return response;
    } catch (error) {
        if (transitionStarted) cancelReadTargetTransition();
        throw error;
    }
}

/** Fork a synchronized accepted prefix, prepare private files, then activate it locally. */
export async function forkAndActivateLog(input: {
    name: string;
    targetVersion: number;
    expectedSourceHeadVersion: number;
    requestId: string;
    onProgress?: (message: string) => void;
}): Promise<LogSummary> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('Connect to fork this log.');
    const context = await requireActiveContext();
    const sourceLogId = context.logId;
    const normalized = validateNewLogName(input.name, logs.value.filter(log => log.status !== 'preparing'));
    input.onProgress?.('Checking accepted changes…');
    await runSyncCoordinator('manual');
    const pending = await db.selectFrom('raw_events').select('id')
        .where('tenant_id', '=', context.tenantId).where('log_id', '=', sourceLogId)
        .where(eb => eb.or([eb('projection_state', '=', 'pending_ddl'), eb.and([
            eb('log_version', 'is', null), eb('sync_state', 'in', ['pending', 'conflicted']),
        ])])).executeTakeFirst();
    const progress = await db.selectFrom('log_sync_state').selectAll()
        .where('tenant_id', '=', context.tenantId).where('log_id', '=', sourceLogId).executeTakeFirst();
    if (pending || syncStatus.pendingUploads > 0 || !progress
        || progress.downloaded_head_version !== progress.projected_head_version
        || progress.projected_head_version !== input.expectedSourceHeadVersion) {
        throw new Error('Finish synchronizing this log, then review the fork point again.');
    }
    const client = getLedgerClient();
    input.onProgress?.('Creating the new log…');
    const fork = await client.forkLog(sourceLogId, {
        name: normalized,
        targetVersion: input.targetVersion,
        expectedSourceHeadVersion: input.expectedSourceHeadVersion,
        requestId: input.requestId,
    });
    input.onProgress?.('Preparing documents…');
    if (fork.status !== 'ready') await prepareForkFiles(fork.id, input.onProgress);
    input.onProgress?.('Opening the new log…');
    await logs.refresh();
    let transitionStarted = false;
    try {
        beginReadTargetTransition();
        transitionStarted = true;
        await stopRealtime();
        await eventLogFilename.set(fork.id, fork.name);
        await loadStoredLogSnapshot(fork.id, []);
        await runSyncCoordinator('manual');
        await invalidateAllViews();
        return { ...fork, status: 'ready' };
    } catch (cause) {
        if (transitionStarted) cancelReadTargetTransition();
        throw new Error(`The new log is ready, but could not be opened. Select it from the log switcher. ${cause instanceof Error ? cause.message : ''}`);
    }
}
