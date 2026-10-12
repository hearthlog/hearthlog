<script lang="ts">
    import { providePageResource } from "@hearthlog/runtime/runtime/page-data.svelte.js";
    import { workspaceReadiness } from "@hearthlog/ui/state/readiness.js";
    import PageDataStatus from "@hearthlog/shell/components/layout/PageDataStatus.svelte";
    import DataPlaceholder from "@hearthlog/ui/components/data/DataPlaceholder.svelte";
    import PageHeader from '@hearthlog/ui/components/PageHeader.svelte';
    import Button from '@hearthlog/ui/components/ui/Button.svelte';
    let { data } = $props();
    const resource = $derived(data.pageResource);
    providePageResource(() => resource);
    import { untrack } from "svelte";
    import DataValue from "@hearthlog/ui/components/data/DataValue.svelte";
    import { refreshPageData } from "@hearthlog/runtime/runtime/refresh.js";
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import { Tabs } from "bits-ui";
    import { tabIndicator } from "@hearthlog/ui/components/ui/tab-indicator.js";
    import type { AppEvent } from "@hearthlog/runtime/event/index.js";
    import DatabaseBrowser from "./DatabaseBrowser.svelte";
    import LocalSqliteStats from './LocalSqliteStats.svelte';
    import IndexedDbStats from './IndexedDbStats.svelte';
    import type { LocalSqliteStats as LocalSqliteStatsData } from '@hearthlog/runtime/db/local-statistics.js';
    import LedgerAdmin from "./LedgerAdmin.svelte";
    import PendingWorkImport from "./PendingWorkImport.svelte";
    import Event from "./Event.svelte";
    import SyncLog from "./SyncLog.svelte";
    import EventLogManager from "./EventLogManager.svelte";
    import PerformanceDashboard from "./PerformanceDashboard.svelte";
    import StackInfo from "./StackInfo.svelte";
    import { events as eventsSignal } from "@hearthlog/runtime/store/events.svelte.js";
    import { localStoreStatus } from "@hearthlog/runtime/store/local-store.svelte.js";
    import { getSyncPhase, syncStatus } from "@hearthlog/runtime/store/sync.svelte.js";
    import { describeAppDataState } from "@hearthlog/runtime/store/sync-state.js";
    import {
        clearOutbox,
        type OutboxEvent,
    } from "@hearthlog/runtime/store/outbox.js";
    import ConfirmDialog from "@hearthlog/ui/components/ConfirmDialog.svelte";
    import EmptyState from "@hearthlog/ui/components/EmptyState.svelte";
    import { notify } from "@hearthlog/ui/state/notifications.svelte.js";
    import IconDeleteOutline from "~icons/mdi/delete-outline";
    import IconDownload from "~icons/mdi/download";
    import IconMagnify from "~icons/mdi/magnify";
    import IconRefresh from "~icons/mdi/refresh";
    import IconUpload from "~icons/mdi/upload";
    import {
        downloadLocalDatabase,
        getLocalRecoverySummary,
        resetLocalDataFromLedger,
        retryLocalMigration,
        type LocalRecoverySummary,
    } from "@hearthlog/runtime/recovery/local-recovery.js";
    import { tenant } from "@hearthlog/contracts/tenant/config";

    let isResetting = $state(false);
    let resetStatus = $state("");
    let recoverySummary = $state<LocalRecoverySummary>({ pending: null, blocked: null });
    const events = $derived(resource.data.events as AppEvent[]);
    const sqliteStats = $derived(resource.data.sqliteStats as LocalSqliteStatsData | null);
    let eventSearch = $state("");
    let allExpanded = $state(false);
    let eventStates = $state<Record<string, boolean>>({});

    // Confirmation dialog states
    let showClearOutboxConfirm = $state(false);
    let showResetDbConfirm = $state(false);

    // Outbox debug state
    const outboxEvents = $derived(resource.data.outboxEvents as OutboxEvent[]);
    const queuedCount = $derived(sqliteStats?.activeLog?.pendingOperationCount ?? 0);
    let isDrainingOutbox = $state(false);
    let outboxMessage = $state("");

    const buildDate = new Date(__BUILD_TIMESTAMP__).toLocaleString("en-US");
    type DeveloperTab = 'overview' | 'events' | 'database' | 'performance' | 'ledger';
    const activeTab = $derived.by(() => {
        const requested = parseDeveloperTab(page.url.searchParams.get("tab"));
        return requested === "ledger" && !tenant.admin ? 'overview' : requested;
    });
    const pageTitle = $derived(
        activeTab === "database"
            ? "Local storage | stor"
            : activeTab === "ledger"
              ? "Ledger Admin | stor"
            : activeTab === "events"
              ? "Developer Events | stor"
            : activeTab === 'performance'
              ? 'Developer Performance | stor'
              : 'Developer Overview | stor',
    );
    const resetConfirmMessage = $derived.by(() => {
        const pending = recoverySummary.pending === null ? "an unknown number of" : recoverySummary.pending;
        const blocked = recoverySummary.blocked === null ? "an unknown number of" : recoverySummary.blocked;
        return `This deletes local data, including ${pending} pending events and ${blocked} blocked operations. Download SQLite first if you may need them. Remote events will be restored through normal sync after reload.`;
    });
    const syncSummary = $derived.by(() => {
        const presentation = describeAppDataState({
            localStorePhase: localStoreStatus.phase,
            localStoreErrorMessage: localStoreStatus.errorMessage,
            syncPhase: getSyncPhase(),
            syncErrorMessage: syncStatus.errorMessage,
            pendingUploads: syncStatus.pendingUploads,
            needsAttention: syncStatus.needsAttention,
            lastSyncedAt: syncStatus.lastSyncedAt,
        });
        return presentation;
    });

    const outboxSummary = $derived.by(() => {
        if (queuedCount === 0) return "No queued operations";
        if (queuedCount === 1) return "1 queued operation";
        return `${queuedCount} queued operations`;
    });

    const filteredEvents = $derived(
        events.filter((e) => {
            if (!eventSearch) return true;
            const search = eventSearch.toLowerCase();
            const typeMatch = e.type?.toLowerCase().includes(search) ?? false;
            const idMatch = e.id?.toLowerCase().includes(search) ?? false;
            const payloadString = e.payload
                ? JSON.stringify(e.payload).toLowerCase()
                : "";
            const payloadMatch = payloadString.includes(search);
            return typeMatch || idMatch || payloadMatch;
        }),
    );

    function toggleAllEvents() {
        allExpanded = !allExpanded;
        const newStates: Record<string, boolean> = {};
        events.forEach((e) => {
            newStates[e.id] = allExpanded;
        });
        eventStates = newStates;
    }

    async function refreshOutbox() {
        if (resource.loading) return;
        try { await refreshPageData("app:developer"); }
        catch (error) { console.error("Failed to refresh outbox", error); }
    }

    async function handleClearOutbox() {
        if (resource.loading) return;
        showClearOutboxConfirm = true;
    }

    async function executeClearOutbox() {
        if (resource.loading) return;
        showClearOutboxConfirm = false;
        try {
            await clearOutbox();
            const { rebuildReadModel } = await import("@hearthlog/runtime/event/index.js");
            await rebuildReadModel();
            outboxMessage = "Outbox cleared";
            await refreshOutbox();
            syncStatus.pendingUploads = 0;
            setTimeout(() => (outboxMessage = ""), 2000);
        } catch (error) {
            outboxMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    async function handleDrainOutbox() {
        if (!$workspaceReadiness.ready) return;
        isDrainingOutbox = true;
        outboxMessage = "Draining outbox...";
        try {
            // Import the drain function from sync to use the proper upload logic
            const { signalLocalChange } = await import(
                "@hearthlog/runtime/store/sync.svelte.js"
            );
            signalLocalChange();
            outboxMessage = "Drain triggered - check Network tab";
            await new Promise((resolve) => setTimeout(resolve, 2000));
            await refreshOutbox();
        } catch (error) {
            outboxMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            isDrainingOutbox = false;
            setTimeout(() => (outboxMessage = ""), 3000);
        }
    }

    async function downloadSqliteDb() {
        if (resource.loading) return;
        try {
            await downloadLocalDatabase();
        } catch (error) {
            console.error("Failed to download SQLite DB:", error);
            notify.error("Failed to download the SQLite database");
        }
    }

    async function refreshEvents() {
        if (resource.loading) return;
        try { await refreshPageData("app:developer"); }
        catch (error) { console.error("Failed to refresh events", error); }
    }

    let lastEventsUpdate = untrack(() => eventsSignal.updatedAt);
    $effect(() => {
        const updatedAt = eventsSignal.updatedAt;
        if (activeTab !== 'events' || resource.loading || updatedAt === lastEventsUpdate) return;
        lastEventsUpdate = updatedAt;
        void refreshEvents();
    });

    // Check if we just reset the database
    if (
        typeof window !== "undefined" &&
        sessionStorage.getItem("databaseReset") === "true"
    ) {
        resetStatus = "Database successfully reset from remote!";
        sessionStorage.removeItem("databaseReset");
        // Clear the status after 3 seconds
        setTimeout(() => {
            resetStatus = "";
        }, 3000);
    }

    async function resetDatabase() {
        if (!$workspaceReadiness.ready) return;
        recoverySummary = await getLocalRecoverySummary();
        showResetDbConfirm = true;
    }

    async function executeResetDatabase() {
        if (resource.loading) return;
        showResetDbConfirm = false;

        isResetting = true;
        resetStatus = "Stopping synchronization...";

        try {
            await resetLocalDataFromLedger();
        } catch (error: unknown) {
            resetStatus = `Error: ${error instanceof Error ? error.message : String(error)}`;
            console.error("Reset error:", error);
            isResetting = false;
        }
    }

    async function retryMigration(): Promise<void> {
        resetStatus = "Retrying local migration...";
        try {
            await retryLocalMigration();
            resetStatus = "Local migration completed.";
        } catch (error) {
            resetStatus = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    function parseDeveloperTab(value: string | null): DeveloperTab {
        return value === "events" ||
            value === "database" ||
            value === 'performance' ||
            value === "ledger"
            ? value
            : 'overview';
    }

    async function navigateToTab(value: string): Promise<void> {
        const tab = parseDeveloperTab(value);
        const nextUrl = new URL(page.url);
        nextUrl.searchParams.set("tab", tab);
        if (tab !== "database") {
            nextUrl.searchParams.delete("table");
            nextUrl.searchParams.delete("page");
            nextUrl.searchParams.delete("pageSize");
            nextUrl.searchParams.delete("sort");
            nextUrl.searchParams.delete("direction");
        }

        const nextPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
        const currentPath = `${page.url.pathname}${page.url.search}${page.url.hash}`;
        if (nextPath === currentPath) return;

        await goto(nextPath, {
            reset: false,
            });
    }
</script>

<svelte:head>
    <title>{pageTitle}</title>
</svelte:head>
<PageDataStatus {resource} />


<div class="stor-page w-full p-2.5 sm:p-3">
    {#snippet developerScope()}
        <p class="text-sm text-[var(--stor-muted-text)]">This browser · all local logs</p>
    {/snippet}
    <PageHeader title="Developer" context={developerScope}>
        <span class="hidden text-xs text-[var(--stor-muted-text)] sm:inline">Build {buildDate}</span>
    </PageHeader>

    <Tabs.Root value={activeTab} onValueChange={(value) => void navigateToTab(value)}>
        <Tabs.List class="stor-page-tabs stor-primary-tabs mobile-scroll flex max-w-full items-center overflow-x-auto" aria-label="Developer view" {@attach tabIndicator}>
            <Tabs.Trigger value="overview" class="stor-page-tab">Overview</Tabs.Trigger>
            <Tabs.Trigger value="events" class="stor-page-tab">Events</Tabs.Trigger>
            <Tabs.Trigger value="database" class="stor-page-tab">Storage</Tabs.Trigger>
            <Tabs.Trigger value="performance" class="stor-page-tab">Performance</Tabs.Trigger>
            {#if tenant.admin}<Tabs.Trigger value="ledger" class="stor-page-tab">Ledger</Tabs.Trigger>{/if}
        </Tabs.List>
    </Tabs.Root>

    {#if activeTab === 'overview'}
        <div class="stor-panel mt-4 grid grid-cols-3 overflow-hidden lg:mt-6" aria-label="Local status">
            <div class="min-w-0 border-r border-[var(--stor-border)] px-3 py-3 sm:px-[var(--stor-panel-padding)] sm:py-4">
                <p class="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--stor-muted-text)] sm:text-xs">Sync</p>
                <p class="mt-1 truncate text-xs font-semibold text-[var(--stor-ink)] sm:text-sm" title={syncSummary.label}>{syncSummary.label}</p>
                <p class="mt-0.5 hidden text-xs text-[var(--stor-muted-text)] sm:block">{syncSummary.description}</p>
            </div>
            <div class="min-w-0 border-r border-[var(--stor-border)] px-3 py-3 sm:px-[var(--stor-panel-padding)] sm:py-4">
                <p class="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--stor-muted-text)] sm:text-xs">Outbox</p>
                <p class="mt-1 text-xs font-semibold text-[var(--stor-ink)] sm:text-sm"><span class="sm:hidden"><DataValue>{queuedCount}</DataValue> queued</span><span class="hidden sm:inline"><DataValue>{outboxSummary}</DataValue></span></p>
                <p class="mt-0.5 hidden text-xs text-[var(--stor-muted-text)] sm:block">Active log</p>
            </div>
            <div class="min-w-0 px-3 py-3 sm:px-[var(--stor-panel-padding)] sm:py-4">
                <p class="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--stor-muted-text)] sm:text-xs">Local data</p>
                <p class="mt-1 truncate text-xs font-semibold capitalize text-[var(--stor-ink)] sm:text-sm">{localStoreStatus.phase}</p>
                <p class="mt-0.5 hidden text-xs text-[var(--stor-muted-text)] sm:block">{localStoreStatus.phase === 'ready' ? 'SQLite opened' : localStoreStatus.errorMessage ?? 'Waiting for local storage'}</p>
            </div>
        </div>

        <div class="mt-4 lg:mt-6"><StackInfo stats={sqliteStats} /></div>

        <div class="mt-4 grid min-w-0 gap-4 lg:mt-6 lg:gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]">
            <LocalSqliteStats stats={sqliteStats} loading={resource.loading} />
            <SyncLog />
        </div>
        <div class="mt-4 lg:mt-6"><IndexedDbStats /></div>

        <div class="mt-4 grid gap-4 lg:mt-6 lg:gap-6 xl:grid-cols-2">
            <section class="stor-panel p-[var(--stor-panel-padding)]">
                <h2 class="text-base font-semibold text-[var(--stor-ink)]">Inspect</h2>
                <p class="mt-1 text-sm text-[var(--stor-muted-text)]">Explore local data and events.</p>
                <div class="mt-4 flex flex-wrap gap-2">
                    <Button variant="secondary" onclick={() => void navigateToTab('database')}>Browse tables</Button>
                    <Button variant="secondary" onclick={() => void navigateToTab('events')}>View events</Button>
                </div>
            </section>
            <section class="stor-panel p-[var(--stor-panel-padding)]">
                <h2 class="text-base font-semibold text-[var(--stor-ink)]">Recovery</h2>
                <p class="mt-1 text-sm text-[var(--stor-muted-text)]">Back up or restore local data.</p>
                <div class="mt-4 flex flex-wrap gap-2">
                    <Button variant="secondary" onclick={downloadSqliteDb} disabled={resource.loading}>
                        <IconDownload class="h-4 w-4" />Download SQLite
                    </Button>
                    <Button variant="secondary" onclick={retryMigration}>
                        <IconRefresh class="h-4 w-4" />Retry migration
                    </Button>
                    <Button
                        variant="secondary"
                        class="bg-[var(--stor-negative-soft)] text-[var(--stor-negative)] hover:brightness-95"
                        onclick={resetDatabase}
                        disabled={resource.loading || isResetting}
                    >
                        <IconDeleteOutline class="h-4 w-4" />{isResetting ? 'Resetting' : 'Reset local data'}
                    </Button>
                </div>
                {#if resetStatus}
                    <p class="mt-3 text-sm text-[var(--stor-negative)]" role="status">{resetStatus}</p>
                {/if}
                <PendingWorkImport />
            </section>
        </div>
        <div class="mt-4 lg:mt-6">
                <section class="stor-panel p-[var(--stor-panel-padding)]">
                    <div class="flex items-start justify-between gap-3">
                        <h2 class="text-base font-semibold text-stone-900">
                            Sync queue
                        </h2>
                        <span class="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-semibold text-stone-600">
                            <DataValue>{queuedCount}</DataValue>
                        </span>
                    </div>

                    <div class="mt-3 grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            class="inline-flex items-center justify-center gap-2 rounded-lg bg-stone-100 px-3 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-200"
                            onclick={refreshOutbox}
                         disabled={resource.loading}>
                            <IconRefresh class="h-4 w-4" />
                            Refresh
                        </button>
                        <button
                            type="button"
                            class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--stor-action)] px-3 text-sm font-semibold text-[var(--stor-action-text)] hover:bg-[var(--stor-action-hover)] disabled:opacity-50 sm:min-h-9"
                            onclick={handleDrainOutbox}
                            disabled={resource.loading || isDrainingOutbox ||
                                queuedCount === 0}
                        >
                            <IconUpload class="h-4 w-4" />
                            {isDrainingOutbox ? "Draining" : "Drain"}
                        </button>
                    </div>

                    {#if outboxMessage}
                        <div class="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
                            {outboxMessage}
                        </div>
                    {/if}

                    <div class="mt-3">
                        {#if resource.loading}<DataPlaceholder />{:else if queuedCount > 0}
                            <div class="max-h-80 space-y-2 overflow-y-auto pr-1">
                                {#each outboxEvents as item}
                                    <article class="rounded-lg border border-stone-200 bg-stone-50 p-3">
                                        <div class="flex items-start justify-between gap-3">
                                            <div class="min-w-0">
                                                <div class="truncate text-xs font-semibold text-stone-800" title={item.eventId}>
                                                    {item.eventId}
                                                </div>
                                                <div class="mt-1 text-xs text-stone-500">
                                                    {item.retryCount} retries
                                                </div>
                                            </div>
                                            <span
                                                class="shrink-0 rounded-full px-2 py-1 text-[10.5px] font-semibold uppercase"
                                                class:bg-yellow-100={item.status ===
                                                    "pending"}
                                                class:text-yellow-700={item.status ===
                                                    "pending"}
                                                class:bg-blue-100={item.status ===
                                                    "syncing"}
                                                class:text-blue-700={item.status ===
                                                    "syncing"}
                                                class:bg-red-100={item.status ===
                                                    "failed" || item.status ===
                                                    "needs_attention"}
                                                class:text-red-700={item.status ===
                                                    "failed" || item.status ===
                                                    "needs_attention"}
                                            >
                                                {item.status}
                                            </span>
                                        </div>
                                        {#if item.lastError}
                                            <div class="mt-2 line-clamp-2 text-xs text-red-700">
                                                {item.lastError}
                                            </div>
                                        {/if}
                                    </article>
                                {/each}
                            </div>
                            <button
                                type="button"
                                class="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-100"
                                onclick={handleClearOutbox}
                             disabled={resource.loading}>
                                <IconDeleteOutline class="h-4 w-4" />
                                Clear pending events
                            </button>
                        {:else}
                            <div class="rounded-lg border border-dashed border-stone-200 bg-stone-50 px-4 py-6 text-center text-sm text-stone-500">
                                No pending events
                            </div>
                        {/if}
                    </div>
                </section>

        </div>
    {:else if activeTab === "events"}
        <div class="mt-4 lg:mt-6"><fieldset disabled={resource.loading} inert={resource.loading}><EventLogManager /></fieldset></div>
        <div class="mt-4 grid gap-4 lg:mt-6 lg:gap-6 lg:grid-cols-[19rem_minmax(0,1fr)]">
            <aside class="stor-panel p-[var(--stor-panel-padding)] lg:sticky lg:top-6 lg:self-start">
                <h2 class="text-base font-semibold text-stone-900">
                    Event stream
                </h2>

                <div class="relative mt-3">
                    <span class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-stone-400">
                        <IconMagnify class="h-4 w-4" />
                    </span>
                    <input
                        type="text"
                        bind:value={eventSearch}
                        placeholder="Search events..."
                        class="block w-full rounded-lg border border-stone-300 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200"
                    />
                </div>

                <div class="mt-4 grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        class="rounded-lg bg-stone-100 px-3 py-2 text-sm font-semibold text-stone-700 transition-colors hover:bg-stone-200"
                        onclick={toggleAllEvents}
                    >
                        {allExpanded ? "Collapse" : "Expand"}
                    </button>
                    <button
                        type="button"
                        class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--stor-action)] px-3 text-sm font-semibold text-[var(--stor-action-text)] transition-colors hover:bg-[var(--stor-action-hover)] sm:min-h-9"
                        onclick={refreshEvents}
                     disabled={resource.loading}>
                        <IconRefresh class="h-4 w-4" />
                        Refresh
                    </button>
                </div>

                <div class="mt-4 rounded-lg bg-stone-50 p-3 text-sm text-stone-600">
                    Showing <span class="font-semibold text-stone-950"><DataValue>{filteredEvents.length}</DataValue></span>
                    of <span class="font-semibold text-stone-950"><DataValue>{events.length}</DataValue></span>
                    {#if eventSearch}
                        <button
                            class="mt-2 block text-sm font-semibold text-stone-950 underline decoration-stone-300 underline-offset-4"
                            onclick={() => (eventSearch = "")}
                        >
                            Clear filter
                        </button>
                    {/if}
                </div>
            </aside>

            <section class="min-w-0">
                <svelte:boundary
                    onerror={(error: unknown) =>
                        console.error("Event Log Boundary Error:", error)}
                >
                    <ul class="space-y-2 pb-4">
                        {#each filteredEvents as event (event.id)}
                            <Event {event} bind:expanded={eventStates[event.id]} />
                        {:else}
                            <EmptyState
                                title="No events found"
                                description="No event type, payload, or identifier matches the current search."
                            />
                        {/each}
                    </ul>

                    {#snippet pending()}
                        <div class="flex justify-center py-20">
                            <div class="h-8 w-8 animate-spin rounded-full border-b-2 border-stone-900"></div>
                        </div>
                    {/snippet}

                    {#snippet failed(error: any)}
                        <div
                            class="rounded-xl border border-red-100 bg-red-50 p-4 text-center text-red-700"
                        >
                            <p class="font-medium">Error loading events</p>
                            <p class="mt-1 text-sm">
                                {error?.message ||
                                    String(error) ||
                                    "Check the console for more details."}
                            </p>
                            <button
                                class="mt-2 text-xs text-red-600 underline"
                                onclick={() => location.reload()}
                            >
                                Reload page
                            </button>
                        </div>
                    {/snippet}
                </svelte:boundary>
            </section>
        </div>
    {:else if activeTab === "database"}
        <div class="mt-4 grid min-w-0 gap-4 lg:mt-6 lg:gap-6 xl:grid-cols-2">
            <LocalSqliteStats stats={sqliteStats} loading={resource.loading} />
            <IndexedDbStats />
        </div>
        <DatabaseBrowser databasePage={resource.data.databasePage} isLoading={resource.loading || resource.refreshing} />
    {:else if activeTab === 'performance'}
        <div class="mt-4 lg:mt-6"><PerformanceDashboard /></div>
    {:else if activeTab === "ledger" && tenant.admin}
        <LedgerAdmin />
    {/if}
</div>

<ConfirmDialog
    show={showClearOutboxConfirm}
    title="Clear Outbox"
    message="Clear all pending outbox events? This will prevent them from syncing."
    onConfirm={executeClearOutbox}
    onCancel={() => (showClearOutboxConfirm = false)}
/>

<ConfirmDialog
    show={showResetDbConfirm}
    title="Reset Database"
    message={resetConfirmMessage}
    onConfirm={executeResetDatabase}
    onCancel={() => (showResetDbConfirm = false)}
/>
