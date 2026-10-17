<script lang="ts">
    import { onMount, tick, untrack } from "svelte";
    import { MediaQuery } from "svelte/reactivity";
    import { page } from "$app/state";
    import { invalidate, beforeNavigate } from "$app/navigation";
    import { eventLogFilename } from "@hearthlog/runtime/store/event-log.svelte.js";
    import {
        syncStatus,
        loadStoredLogSnapshot,
        stopRealtime,
        handleOnline,
        handleOffline,
        getSyncPhase,
        runSyncCoordinator,
    } from "@hearthlog/runtime/store/sync.svelte.js";
    import { localStoreStatus } from "@hearthlog/runtime/store/local-store.svelte.js";
    import { logs } from "@hearthlog/runtime/store/logs.svelte.js";
    import NavBar from "@hearthlog/shell/components/layout/NavBar.svelte";
    import { SIDEBAR_WIDTH_KEY, readSidebarWidth } from "@hearthlog/shell/components/layout/sidebar-size.js";
    import LogCreateDrawer from "@hearthlog/shell/components/layout/LogCreateDrawer.svelte";
    import NotificationCenter from "@hearthlog/ui/components/NotificationCenter.svelte";
    import MovedBanner from "@hearthlog/shell/components/layout/MovedBanner.svelte";
    import { notify } from "@hearthlog/ui/state/notifications.svelte.js";
    import { recordTiming, measurementMetadata, beginNavigationTiming } from "@hearthlog/runtime/utils/perf.js";
    import { workspaceReadiness, workspaceIsReady } from "@hearthlog/ui/state/readiness.js";
    import { waitForWorkspace } from "@hearthlog/runtime/runtime/workspace.js";
    import { waitForPageUpdates } from "@hearthlog/runtime/runtime/page-data.svelte.js";
    import ErrorPage from "../error/ErrorPage.svelte";
    import { offlineReadiness } from "@hearthlog/runtime/store/offline-readiness.svelte.js";
    import { featureForPath, ENTITIES_PATH } from "@hearthlog/contracts/features/registry";
    import { attention } from "@hearthlog/runtime/store/attention.svelte.js";
    import { isFeatureEnabled, tenant } from "@hearthlog/contracts/tenant/config";
    import { calendarAttention } from "@hearthlog/shell/components/calendar/calendar-attention.js";
    import { createAndActivateLog, prepareForkFiles } from "@hearthlog/runtime/log-management.js";
    import { SYNC_INVALIDATION_TARGETS } from "@hearthlog/runtime/store/sync-invalidation.js";
    import { beginReadTargetTransition, failReadTargetTransition } from "@hearthlog/runtime/runtime/read-coordinator.js";
    import {
        isLocalDevelopmentHostname,
        loadCurrentUserEmail,
        LOCAL_USER_EMAIL,
    } from "@hearthlog/runtime/access/user-session.js";
    import { accessSessionState } from "@hearthlog/runtime/store/sync.svelte.js";
    import { retryAccessReauthentication } from "@hearthlog/runtime/access/session.js";
    import { initializeAppearance } from "@hearthlog/runtime/theme/appearance.svelte.js";
    import { rememberSection } from '@hearthlog/runtime/runtime/start-page.js';
    import { startWorkspaceClock } from '@hearthlog/runtime/runtime/clock.js';
    import { startNativeShell } from '@hearthlog/runtime/native/shell.svelte.js';
    import { MODULE_ROUTES } from '#generated/modules';
    import { matchesPattern } from '@hearthlog/contracts/features/route-patterns';

    type SyncIssuesDrawerComponent =
        typeof import("@hearthlog/shell/components/sync/SyncIssuesDrawer.svelte").default;

    /** `startup` is the tenant's composed modules: the host imports them and passes them in. */
    const { data, children, startup }: { data: any; children: import("svelte").Snippet; startup: { attentionContributions: Parameters<typeof attention.configure>[0]; startModules: () => (() => void) | void } } = $props();

    let startupSlow = $state(false);
    $effect(() => {
        if ($workspaceReadiness.ready || $workspaceReadiness.error) { startupSlow = false; return; }
        const timer = setTimeout(() => startupSlow = true, 8000);
        return () => clearTimeout(timer);
    });

    let logsRefreshTimeout: ReturnType<typeof setTimeout> | null = null;
    let hasRecordedFirstContentfulPaintBaseline = false;
    let hasRecordedShellInteractiveBaseline = false;
    let hasRecordedFirstSyncCompleteBaseline = false;
    let lastNotifiedSyncError = "";
    // The sidebar is a rail below 1024px, where tablets start. From there it opens
    // expanded from 1280px, and a choice made with the toggle always wins.
    const expandable = new MediaQuery("min-width: 1024px");
    const roomy = new MediaQuery("min-width: 1280px");
    let sidebarChoice = $state<boolean | null>((() => {
        try {
            const stored = localStorage.getItem("stor:sidebar-collapsed");
            return stored === null ? null : stored === "true";
        } catch { return null; }
    })());
    const sidebarCollapsed = $derived(!expandable.current || (sidebarChoice ?? !roomy.current));
    let sidebarWidth = $state(readSidebarWidth(localStorage));
    let syncIssuesOpen = $state(false);
    let createLogDrawerOpen = $state(false);
    let SyncIssuesDrawer = $state<SyncIssuesDrawerComponent | null>(null);
    let syncIssuesLoadPromise: Promise<void> | null = null;
    let userEmail = $state(
        typeof window !== "undefined" &&
            isLocalDevelopmentHostname(window.location.hostname)
            ? LOCAL_USER_EMAIL
            : "Loading account…",
    );

    const syncPhase = $derived.by(() => getSyncPhase());
    /** Pages whose endless lists scroll themselves, so the page fits the screen from lg. */
    const FIT_SECTIONS = ["/calendar"];
    /** Module pages that fit (Finance's months, Health's day pages; `/calories/foods` is an ordinary page). */
    const FIT_PAGES = MODULE_ROUTES.filter((route) => route.fitsScreen).map((route) => route.path);
    function pageFitsScreen(pathname: string): boolean {
        const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
        return FIT_SECTIONS.some((section) => path.startsWith(section)) || FIT_PAGES.some((pattern) => matchesPattern(pattern, path));
    }

    const pageRenderKey = $derived.by(() => {
        // A route a module marks `keepMounted` (Finance's month workbench) stays mounted while only its params change.
        const kept = MODULE_ROUTES.find((route) => route.keepMounted && matchesPattern(route.path, page.url.pathname));
        return kept ? kept.path : page.url.pathname;
    });

    // Navigation badges, figures and native reminders come from the composed modules, plus the calendar's own figure.
    // `startup` is the host's composed module list and never changes for a running page.
    // svelte-ignore state_referenced_locally
    attention.configure([...(isFeatureEnabled("calendar") ? [calendarAttention] : []), ...startup.attentionContributions]);

    onMount(() => initializeAppearance(tenant.id));

    onMount(() => startup.startModules());
    onMount(() => startWorkspaceClock());
    onMount(() => startNativeShell({ toggleSidebar: () => toggleSidebar() }));

    onMount(() => {
        if (import.meta.env.VITE_E2E === "1") {
            void data.workspace.ready.then(() => import("@hearthlog/runtime/testing/e2e-seed.js"))
                .then(({ installE2ESeedHelper }) => installE2ESeedHelper())
                .catch(() => undefined);
        }
        window.dispatchEvent(new CustomEvent("stor:app-mounted"));
        void logs.loadCached();
        let frameId = 0;
        let paintObserver: PerformanceObserver | null = null;

        if (!hasRecordedFirstContentfulPaintBaseline) {
            const recordFirstContentfulPaint = (entry: PerformanceEntry) => {
                if (hasRecordedFirstContentfulPaintBaseline) return;
                recordTiming(
                    "startup",
                    "firstContentfulPaint",
                    entry.startTime,
                    {
                        ...measurementMetadata(),
                        baselineMetric: "firstContentfulPaint",
                        route: page.url.pathname,
                    },
                );
                hasRecordedFirstContentfulPaintBaseline = true;
                paintObserver?.disconnect();
            };
            const firstContentfulPaint = performance.getEntriesByName(
                "first-contentful-paint",
            )[0];
            if (firstContentfulPaint) {
                recordFirstContentfulPaint(firstContentfulPaint);
            } else if ("PerformanceObserver" in window) {
                paintObserver = new PerformanceObserver((list) => {
                    const entry = list.getEntriesByName(
                        "first-contentful-paint",
                    )[0];
                    if (entry) recordFirstContentfulPaint(entry);
                });
                paintObserver.observe({ type: "paint", buffered: true });
            }
        }

        if (
            typeof window !== "undefined" &&
            !hasRecordedShellInteractiveBaseline
        ) {
            void tick().then(() => {
                frameId = window.requestAnimationFrame(() => {
                    frameId = window.requestAnimationFrame(() => {
                        recordTiming(
                            "startup",
                            "shellInteractive",
                            performance.now(),
                            {
                                ...measurementMetadata(),
                                baselineMetric: "shellInteractive",
                                route: page.url.pathname,
                            },
                        );
                        hasRecordedShellInteractiveBaseline = true;
                    });
                });
            });
        }

        return () => {
            if (frameId) {
                window.cancelAnimationFrame(frameId);
            }
            paintObserver?.disconnect();
        };
    });

    onMount(() => {
        let mounted = true;
        void loadCurrentUserEmail()
            .then((email) => {
            if (mounted) userEmail = email;
            })
            .catch((error) => {
            if (mounted) userEmail = "Account unavailable";
            console.warn("[Layout] Could not load Access identity:", error);
        });

        return () => {
            mounted = false;
        };
    });

    async function refreshLogs(): Promise<void> {
        try {
            await logs.refresh();
        } catch (error) {
            console.warn("[Layout] Failed to refresh logs:", error);
        }
    }

    function afterFirstPaint(callback: () => void): () => void {
        if (typeof window === "undefined") {
            callback();
            return () => {};
        }

        let firstFrame = 0;
        let secondFrame = 0;
        let idleHandle: number | null = null;
        const requestIdle = (
            window as Window & {
                requestIdleCallback?: (
                    callback: () => void,
                    options?: { timeout: number },
                ) => number;
                cancelIdleCallback?: (handle: number) => void;
            }
        ).requestIdleCallback;
        const cancelIdle = (
            window as Window & {
                cancelIdleCallback?: (handle: number) => void;
            }
        ).cancelIdleCallback;

        firstFrame = window.requestAnimationFrame(() => {
            secondFrame = window.requestAnimationFrame(() => {
                if (requestIdle) {
                    idleHandle = requestIdle(callback, { timeout: 1000 });
                } else {
                    callback();
                }
            });
        });

        return () => {
            if (firstFrame) window.cancelAnimationFrame(firstFrame);
            if (secondFrame) window.cancelAnimationFrame(secondFrame);
            if (idleHandle !== null && cancelIdle) cancelIdle(idleHandle);
        };
    }

    beforeNavigate(({ from, to, shallow }) => {
        if (shallow) return;
        if (!from || !to || from.url.pathname === to.url.pathname && from.url.search === to.url.search) return;

        // A route that redirects at once (Finance's `/finance` to the current month) completes the navigation already in progress.
        const resolved = MODULE_ROUTES.find((route) => route.resolvesTo && route.path === from.url.pathname);
        if (resolved && matchesPattern(resolved.resolvesTo!, to.url.pathname) && from.url.search === to.url.search) return;
        beginNavigationTiming();
    });

    $effect(() => {
        const workspace = data.workspace;
        let mounted = true;
        let cancelInitialNetworkStart: (() => void) | null = null;

        async function startInitialNetworkSync() {
            let outcome = !navigator.onLine ? 'offline' : document.visibilityState !== 'visible' ? 'skipped' : 'success';
            const route = page.url.pathname;
            const metadata = measurementMetadata();
            try {
                await runSyncCoordinator("startup");
                if (syncStatus.hasError) outcome = 'failed';
                else if (outcome === 'success' && !syncStatus.hasCompletedSync) outcome = 'skipped';
            } catch (syncError) {
                outcome = 'failed';
                console.warn("[Layout] Initial sync failed:", syncError);
            } finally {
                if (!hasRecordedFirstSyncCompleteBaseline) {
                    recordTiming("startup", "firstSyncComplete", performance.now(), {
                        ...metadata, baselineMetric: "firstSyncComplete", route,
                        logId: eventLogFilename.value, outcome,
                    });
                    hasRecordedFirstSyncCompleteBaseline = true;
                }
            }
        }

        function scheduleInitialNetworkSync() {
            if (import.meta.env.VITE_E2E === "1") {
                syncStatus.hasCompletedSync = true;
                syncStatus.hasError = false;
                return;
            }
            cancelInitialNetworkStart?.();
            cancelInitialNetworkStart = afterFirstPaint(() => {
                if (!mounted || !eventLogFilename.value || hasRecordedFirstSyncCompleteBaseline) return;
                void startInitialNetworkSync();
            });
        }

        async function init() {
            let schemaRebuilt = false;

            if (import.meta.env.DEV && "serviceWorker" in navigator) {
                const registrations =
                    await navigator.serviceWorker.getRegistrations();
                for (const registration of registrations) {
                    await registration.unregister();
                }
            }
            try {
                // console.log("[Layout] Starting initialization");

                const bootstrap = await workspace.ready;
                if (!mounted) return;
                await logs.loadCached();
                schemaRebuilt = bootstrap.schemaRebuilt;

                if (schemaRebuilt) {
                    console.log("[Layout] Schema was rebuilt");
                }

                void waitForPageUpdates().then(() => window.dispatchEvent(new CustomEvent("stor:app-ready"))).catch(() => undefined);

                if (eventLogFilename.value) {
                    scheduleInitialNetworkSync();
                } else {
                    syncStatus.hasError = false;
                    syncStatus.errorMessage = null;
                    console.log(
                        "[Layout] No event log selected after initialization; skipping sync",
                    );
                }

                console.log("[Layout] Initialization complete");
            } catch (error) {
                console.error("[Layout] Initialization failed:", error);
            }
        }

        if (mounted && import.meta.env.DEV && "serviceWorker" in navigator) {
            // ... (SW cleanup) ...
        }

        async function loopLogsRefresh() {
            if (!mounted) return;
            if (
                document.visibilityState === "visible" &&
                (typeof navigator === "undefined" || navigator.onLine)
            ) {
                await refreshLogs();
            }
            if (mounted) {
                logsRefreshTimeout = setTimeout(loopLogsRefresh, 10000);
            }
        }

        // Only call init once
        untrack(() => init()).then(() => {
            if (mounted) loopLogsRefresh();
        });

        // Visibility handler
        async function handleVisibility() {
            if (document.visibilityState === "visible") {
                if (eventLogFilename.value && workspaceIsReady()) {
                    await runSyncCoordinator("visible");
                }
                // Trigger refresh immediately on visible
                await refreshLogs();
            } else {
                await stopRealtime();
            }
        }

        document.addEventListener("visibilitychange", handleVisibility);

        return () => {
            mounted = false;
            cancelInitialNetworkStart?.();
            document.removeEventListener("visibilitychange", handleVisibility);
            if (logsRefreshTimeout) {
                clearTimeout(logsRefreshTimeout);
            }
            void stopRealtime();
        };
    });

    async function invalidateAllViews(): Promise<void> {
        await Promise.all(SYNC_INVALIDATION_TARGETS.map((target) => invalidate(target)));
    }

    async function handleSwitchLog(logId: string): Promise<void> {
        if (!workspaceIsReady()) return;
        if (!logId) return;

        let selectedLog = logs.value.find((log) => log.id === logId);
        if (!selectedLog) return;

        let transitionStarted = false;
        try {
            if (selectedLog.status === 'preparing') {
                notify.info(`Preparing ${selectedLog.name}…`);
                await prepareForkFiles(logId);
                await logs.refresh();
                selectedLog = logs.value.find((log) => log.id === logId);
                if (!selectedLog || selectedLog.status !== 'ready') throw new Error('Fork is still preparing');
            }
            beginReadTargetTransition();
            transitionStarted = true;
            await stopRealtime();

            await eventLogFilename.set(logId, selectedLog.name);
            await loadStoredLogSnapshot(logId, []);
            await runSyncCoordinator("manual");
            await waitForWorkspace();
            await invalidateAllViews();
            await waitForPageUpdates();
        } catch (error) {
            if (transitionStarted) failReadTargetTransition(error);
            console.error("[Layout] Failed to switch log:", error);
            notify.error(error instanceof Error ? error.message : 'Could not open this log');
            throw error;
        }
    }

    function openCreateLogDrawer(): void {
        if (!workspaceIsReady()) return;
        createLogDrawerOpen = true;
    }

    async function handleCreateLog(name: string): Promise<void> {
        if (!workspaceIsReady()) return;
        const response = await createAndActivateLog(name);
        notify.success(`Created and switched to "${response.name || name}".`);
    }

    function loadSyncIssues(): Promise<void> {
        syncIssuesLoadPromise ??= import(
            "@hearthlog/shell/components/sync/SyncIssuesDrawer.svelte"
        ).then((module) => {
            SyncIssuesDrawer = module.default;
        });
        return syncIssuesLoadPromise;
    }

    function openSyncIssues(): void {
        if (!workspaceIsReady()) return;
        syncIssuesOpen = true;
        void loadSyncIssues();
    }

    $effect(() => {
        rememberSection(page.url, tenant, localStorage);
    });

    function toggleSidebar(): void {
        sidebarChoice = !sidebarCollapsed;
        try { localStorage.setItem("stor:sidebar-collapsed", String(sidebarChoice)); }
        catch { /* The current session still keeps the preference. */ }
    }

    // Dragging the edge previews live and saves on release; folding saves the same choice as the toggle.
    function resizeSidebar(width: number, folded: boolean, final: boolean): void {
        sidebarWidth = width;
        sidebarChoice = folded;
        if (!final) return;
        try {
            localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
            localStorage.setItem("stor:sidebar-collapsed", String(folded));
        } catch { /* The current session still keeps the preference. */ }
    }

    $effect(() => {
        document.documentElement.style.setProperty("--stor-sidebar-width", `${sidebarWidth}px`);
    });

    // CSS keys on this attribute (page tabs, the page label), so it follows the form the sidebar is in.
    $effect(() => {
        document.documentElement.dataset.sidebarCollapsed = String(sidebarCollapsed);
    });

    function onOnline() {
        if (!workspaceIsReady()) return;
        console.log("[Layout] Network online");
        void handleOnline();
    }

    async function onOffline() {
        console.log("[Layout] Network offline");
        await handleOffline();
    }

    $effect(() => {
        const message = syncStatus.errorMessage;
        if (syncStatus.hasError && message && message !== lastNotifiedSyncError) {
            lastNotifiedSyncError = message;
            // An expired Cloudflare Access session parks sync until the user
            // re-authenticates. Attach the recovery action directly to the
            // toast so the user is never stuck without a way to sign in.
            notify.error(
                message,
                accessSessionState.expired
                    ? {
                          label: "Sign in again",
                          run: () => {
                              void retryAccessReauthentication();
                          },
                      }
                    : undefined,
            );
        }
        if (!syncStatus.hasError) lastNotifiedSyncError = "";
    });
</script>

<svelte:window ononline={onOnline} onoffline={onOffline}></svelte:window>

<svelte:head>
    <title>{tenant.title}</title>
    <!-- Tenant-branded favicon (the static favicon.ico stays as fallback). -->
    <link rel="icon" type="image/svg+xml" href={tenant.faviconHref} />
</svelte:head>

<div
    data-stor-root
    class="flex h-dvh w-full flex-col bg-[var(--stor-bg)] transition-[padding] duration-150 ease-out motion-reduce:transition-none {sidebarCollapsed
        ? 'md:pl-20'
        : 'lg:pl-[var(--stor-sidebar-width)]'}"
>
    <NavBar
        userEmail={userEmail}
        logs={logs.value}
        lineage={logs.lineage}
        currentLogId={eventLogFilename.value}
        currentLogName={eventLogFilename.name}
        dataReady={$workspaceReadiness.ready}
        localStorePhase={localStoreStatus.phase}
        localStoreErrorMessage={localStoreStatus.errorMessage}
        syncPhase={syncPhase}
        syncErrorMessage={syncStatus.errorMessage}
        pendingUploads={syncStatus.pendingUploads}
        needsAttention={syncStatus.needsAttention}
        offlineAvailable={offlineReadiness.phase === "available"}
        lastSyncedAt={syncStatus.lastSyncedAt}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
        {sidebarWidth}
        onResizeSidebar={resizeSidebar}
        onOpenSyncIssues={openSyncIssues}
        onSwitchLog={handleSwitchLog}
        onCreateLog={openCreateLogDrawer}
    />

    <main
        data-stor-main
        class="min-h-0 flex-1 overflow-y-auto pt-[var(--stor-mobile-header-height)] lg:pt-0"
        data-page-fit={pageFitsScreen(page.url.pathname) ? "" : undefined}
    >
        <MovedBanner />
        {#if $workspaceReadiness.error}
            <ErrorPage error={$workspaceReadiness.error} />
        {:else}
            {#key pageRenderKey}
                {@render children()}
            {/key}
        {/if}
    </main>
    {#if startupSlow}
        <aside class="stor-panel fixed bottom-24 right-4 z-50 max-w-sm p-4 text-sm lg:bottom-4" role="status">
            Local data is taking longer than expected to open.
            <button class="mt-2 block font-semibold underline" onclick={() => window.location.reload()}>Retry loading</button>
        </aside>
    {/if}
    <NotificationCenter />
    <LogCreateDrawer
        show={createLogDrawerOpen}
        onClose={() => createLogDrawerOpen = false}
        onCreate={handleCreateLog}
    />
    {#if SyncIssuesDrawer}
        <SyncIssuesDrawer
            show={syncIssuesOpen}
            onClose={() => syncIssuesOpen = false}
        />
    {:else if syncIssuesOpen}
        <div class="fixed inset-y-0 right-0 z-50 flex w-full max-w-md items-center justify-center border-l border-[var(--stor-border)] bg-white/95 text-sm font-medium text-stone-600 shadow-[var(--stor-elevation-3)]" role="status">
            Loading sync issues…
        </div>
    {/if}
</div>
