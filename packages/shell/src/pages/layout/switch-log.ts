import { invalidate } from "$app/navigation";
import { eventLogFilename } from "@hearthlog/runtime/store/event-log.svelte.js";
import { loadStoredLogSnapshot, runSyncCoordinator, stopRealtime } from "@hearthlog/runtime/store/sync.svelte.js";
import { logs } from "@hearthlog/runtime/store/logs.svelte.js";
import { prepareForkFiles } from "@hearthlog/runtime/log-management.js";
import { SYNC_INVALIDATION_TARGETS } from "@hearthlog/runtime/store/sync-invalidation.js";
import { beginReadTargetTransition, failReadTargetTransition } from "@hearthlog/runtime/runtime/read-coordinator.js";
import { announceInvalidation } from "@hearthlog/runtime/runtime/invalidation.js";
import { waitForWorkspace } from "@hearthlog/runtime/runtime/workspace.js";
import { waitForPageUpdates } from "@hearthlog/runtime/runtime/page-data.svelte.js";
import { workspaceIsReady } from "@hearthlog/ui/state/readiness.js";

/**
 * Opens another log: prepares a fork's files first, then switches the read target, syncs it, and refreshes every
 * view. Returns false when there is nothing to switch to (the workspace is not open, or the log is unknown); throws
 * when the switch fails. The shell layout and the native engine both switch through it.
 */
export async function switchLog(logId: string, options: { onPreparing?: (name: string) => void } = {}): Promise<boolean> {
    if (!workspaceIsReady() || !logId) return false;

    let selectedLog = logs.value.find((log) => log.id === logId);
    if (!selectedLog) return false;

    let transitionStarted = false;
    try {
        if (selectedLog.status === "preparing") {
            options.onPreparing?.(selectedLog.name);
            await prepareForkFiles(logId);
            await logs.refresh();
            selectedLog = logs.value.find((log) => log.id === logId);
            if (!selectedLog || selectedLog.status !== "ready") throw new Error("Fork is still preparing");
        }
        beginReadTargetTransition();
        transitionStarted = true;
        await stopRealtime();

        await eventLogFilename.set(logId, selectedLog.name);
        await loadStoredLogSnapshot(logId, []);
        await runSyncCoordinator("manual");
        await waitForWorkspace();
        announceInvalidation(SYNC_INVALIDATION_TARGETS);
        await Promise.all(SYNC_INVALIDATION_TARGETS.map((target) => invalidate(target)));
        await waitForPageUpdates();
        return true;
    } catch (error) {
        if (transitionStarted) failReadTargetTransition(error);
        throw error;
    }
}
