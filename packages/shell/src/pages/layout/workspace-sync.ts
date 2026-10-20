import { eventLogFilename } from "@hearthlog/runtime/store/event-log.svelte.js";
import {
    syncStatus,
    stopRealtime,
    handleOnline,
    handleOffline,
    runSyncCoordinator,
} from "@hearthlog/runtime/store/sync.svelte.js";
import { logs } from "@hearthlog/runtime/store/logs.svelte.js";
import { workspaceIsReady } from "@hearthlog/ui/state/readiness.js";
import { waitForPageUpdates } from "@hearthlog/runtime/runtime/page-data.svelte.js";
import { onPageVisibilityChange, pageVisible } from "@hearthlog/runtime/runtime/visibility.js";

const LOGS_REFRESH_MS = 10_000;

/** The first network sync runs once per page, however often the workspace is reopened. */
let initialSyncStarted = false;

export type InitialSyncOutcome = "success" | "offline" | "skipped" | "failed";

export interface WorkspaceSyncOptions {
    /** Runs the initial network sync; the layout waits for first paint, the native engine starts at once. */
    defer?: (start: () => void) => () => void;
    /** Called once the first network sync settles, with how it went. */
    onInitialSync?: (outcome: InitialSyncOutcome) => void;
}

/**
 * Opens the workspace and keeps it in sync: the first network sync, the logs list refresh, sync
 * on becoming visible (or realtime stopping while hidden), and the online and offline events.
 * Shared by the shell layout and the native engine route. Returns the cleanup.
 */
export function startWorkspaceSync(
    workspace: { ready: Promise<{ schemaRebuilt: boolean }> },
    options: WorkspaceSyncOptions = {},
): () => void {
    const defer = options.defer ?? ((start) => { start(); return () => {}; });
    let mounted = true;
    let cancelInitialNetworkStart: (() => void) | null = null;
    let logsRefreshTimeout: ReturnType<typeof setTimeout> | null = null;

    async function refreshLogs(): Promise<void> {
        try {
            await logs.refresh();
        } catch (error) {
            console.warn("[Layout] Failed to refresh logs:", error);
        }
    }

    async function startInitialNetworkSync() {
        let outcome: InitialSyncOutcome = !navigator.onLine ? "offline" : !pageVisible() ? "skipped" : "success";
        try {
            await runSyncCoordinator("startup");
            if (syncStatus.hasError) outcome = "failed";
            else if (outcome === "success" && !syncStatus.hasCompletedSync) outcome = "skipped";
        } catch (syncError) {
            outcome = "failed";
            console.warn("[Layout] Initial sync failed:", syncError);
        } finally {
            options.onInitialSync?.(outcome);
        }
    }

    function scheduleInitialNetworkSync() {
        if (import.meta.env.VITE_E2E === "1") {
            syncStatus.hasCompletedSync = true;
            syncStatus.hasError = false;
            return;
        }
        cancelInitialNetworkStart?.();
        cancelInitialNetworkStart = defer(() => {
            if (!mounted || !eventLogFilename.value || initialSyncStarted) return;
            initialSyncStarted = true;
            void startInitialNetworkSync();
        });
    }

    async function init() {
        if (import.meta.env.DEV && "serviceWorker" in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (const registration of registrations) {
                await registration.unregister();
            }
        }
        try {
            const bootstrap = await workspace.ready;
            if (!mounted) return;
            await logs.loadCached();

            if (bootstrap.schemaRebuilt) {
                console.log("[Layout] Schema was rebuilt");
            }

            void waitForPageUpdates().then(() => window.dispatchEvent(new CustomEvent("stor:app-ready"))).catch(() => undefined);

            if (eventLogFilename.value) {
                scheduleInitialNetworkSync();
            } else {
                syncStatus.hasError = false;
                syncStatus.errorMessage = null;
                console.log("[Layout] No event log selected after initialization; skipping sync");
            }

            console.log("[Layout] Initialization complete");
        } catch (error) {
            console.error("[Layout] Initialization failed:", error);
        }
    }

    async function loopLogsRefresh() {
        if (!mounted) return;
        if (pageVisible() && (typeof navigator === "undefined" || navigator.onLine)) {
            await refreshLogs();
        }
        if (mounted) {
            logsRefreshTimeout = setTimeout(loopLogsRefresh, LOGS_REFRESH_MS);
        }
    }

    void init().then(() => {
        if (mounted) void loopLogsRefresh();
    });

    async function handleVisibility() {
        if (pageVisible()) {
            if (eventLogFilename.value && workspaceIsReady()) {
                await runSyncCoordinator("visible");
            }
            await refreshLogs();
        } else {
            await stopRealtime();
        }
    }

    function onOnline() {
        if (!workspaceIsReady()) return;
        console.log("[Layout] Network online");
        void handleOnline();
    }

    function onOffline() {
        console.log("[Layout] Network offline");
        void handleOffline();
    }

    const stopVisibility = onPageVisibilityChange(() => void handleVisibility());
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
        mounted = false;
        cancelInitialNetworkStart?.();
        stopVisibility();
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
        if (logsRefreshTimeout) {
            clearTimeout(logsRefreshTimeout);
        }
        void stopRealtime();
    };
}
