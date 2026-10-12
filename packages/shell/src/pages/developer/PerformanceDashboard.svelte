<script lang="ts">
    import { onMount } from "svelte";
    import { page } from "$app/state";
    import { workspaceReadiness } from "@hearthlog/ui/state/readiness.js";
    import { currentPageResource } from "@hearthlog/ui/state/page-context.js";
    import {
        clearPerfEntries,
        formatDuration,
        getBaselineMetricLabel,
        getBaselineMetricDescription,
        measurementMetadata,
        getPerfEntries,
        subscribeToPerfEntries,
        summarizeBaselineMetrics,
        type PerfEntry,
        type PerfBaselineMetric,
    } from "@hearthlog/runtime/utils/perf.js";
    import IconDeleteOutline from "~icons/mdi/delete-outline";
    import IconDownload from "~icons/mdi/download";
    import IconRefresh from "~icons/mdi/refresh";

    let entries = $state<PerfEntry[]>([]);
    const documentId = measurementMetadata().documentId as string;
    const resource = currentPageResource();
    const launchMetrics: PerfBaselineMetric[] = ['firstContentfulPaint', 'shellInteractive', 'dataReady', 'firstSyncComplete'];
    const buildEntries = $derived(entries.filter(entry => entry.metadata?.build === __BUILD_TIMESTAMP__));
    const currentEntries = $derived(buildEntries.filter(entry => entry.metadata?.documentId === documentId));
    const pageEntry = $derived(currentEntries.find(entry => entry.baselineMetric === 'pageContentReady' && entry.metadata?.loadId === resource?.().measurement?.id));
    const pageFailed = $derived(pageEntry?.metadata?.outcome === 'failed' || resource?.().error);
    let summaries = $derived(summarizeBaselineMetrics(buildEntries));
    let activeSummaries = $derived(
        summaries.filter((summary) => summary.sampleCount > 0),
    );
    let idleMetricCount = $derived(summaries.length - activeSummaries.length);
    let recentEntries = $derived(
        buildEntries
            .filter((entry) => entry.baselineMetric)
            .sort((left, right) => right.timestamp - left.timestamp)
            .slice(0, 8),
    );

    function refreshEntries() {
        entries = getPerfEntries();
    }

    function exportEntries() {
        const payload = JSON.stringify(
            {
                exportedAt: new Date().toISOString(),
                entries,
            },
            null,
            2,
        );
        const blob = new Blob([payload], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "performance-baseline.json";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    onMount(() => {
        refreshEntries();
        return subscribeToPerfEntries((nextEntries) => {
            entries = nextEntries;
        });
    });
</script>

<div class="stor-panel min-w-0 p-[var(--stor-panel-padding)]">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
            <h2 class="text-base font-semibold text-stone-900">
                Performance
            </h2>
            {#if idleMetricCount > 0}
                <p class="mt-1 text-sm text-[var(--stor-muted-text)]">
                    {idleMetricCount} idle metric{idleMetricCount === 1 ? "" : "s"}
                </p>
            {/if}
        </div>

        <div class="flex flex-wrap gap-2">
            <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--stor-surface-muted)] px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-200"
                onclick={refreshEntries}
            >
                <IconRefresh class="h-3.5 w-3.5" />
                Refresh
            </button>
            <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--stor-surface-muted)] px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-200 disabled:opacity-50"
                onclick={exportEntries}
                disabled={entries.length === 0}
            >
                <IconDownload class="h-3.5 w-3.5" />
                Export
            </button>
            <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
                onclick={() => {
                    clearPerfEntries();
                    refreshEntries();
                }}
                disabled={entries.length === 0}
            >
                <IconDeleteOutline class="h-3.5 w-3.5" />
                Clear
            </button>
        </div>
    </div>

    <section class="mt-4 rounded-lg bg-[var(--stor-surface-muted)] p-3" aria-label="Current page performance">
        <h3 class="text-sm font-semibold text-[var(--stor-ink)]">Current page</h3>
        <p class="mt-1 break-all text-xs text-[var(--stor-muted-text)]">{page.url.pathname}{page.url.search}</p>
        <dl class="mt-3">
            <div class="flex justify-between gap-3 text-xs">
                <dt class="font-medium text-[var(--stor-ink)]">{getBaselineMetricLabel('pageContentReady')}</dt>
                <dd class="shrink-0 tabular-nums text-[var(--stor-muted-text)]">{pageFailed ? 'Failed' : pageEntry ? formatDuration(pageEntry.durationMs) : resource?.().loading ? 'Pending' : 'Not recorded'}</dd>
            </div>
        </dl>
        <p class="mt-1 text-xs text-[var(--stor-muted-text)]">
            {#if pageEntry?.metadata?.kind === 'startup'}
                From opening the app, including local workspace setup.
            {:else if pageEntry?.metadata?.kind === 'navigation'}
                From navigating to this page until its required data has rendered.
            {:else if pageEntry?.metadata?.kind === 'refresh'}
                Background refresh; previously loaded content stays visible.
            {:else if resource?.().loading}
                Waiting for this page's required data to render.
            {:else}
                No retained sample for this page. Navigate or reload to record one.
            {/if}
        </p>
    </section>

    <section class="mt-4 rounded-lg bg-[var(--stor-surface-muted)] p-3" aria-label="App launch performance">
        <h3 class="text-sm font-semibold text-[var(--stor-ink)]">App launch</h3>
        <p class="mt-1 text-xs text-[var(--stor-muted-text)]">Elapsed since opening the app. These milestones overlap; do not add them together.</p>
        <dl class="mt-3 space-y-3">
            {#each launchMetrics as metric}
                {@const entry = currentEntries.find(entry => entry.baselineMetric === metric)}
                {@const failed = entry?.metadata?.outcome === 'failed' || (metric === 'dataReady' && $workspaceReadiness.error)}
                <div>
                    <div class="flex justify-between gap-3 text-xs">
                        <dt class="font-medium text-stone-700">{getBaselineMetricLabel(metric)}</dt>
                        <dd class="shrink-0 tabular-nums text-stone-600">{failed ? 'Failed' : entry?.metadata?.outcome === 'offline' ? 'Offline' : entry?.metadata?.outcome === 'skipped' ? 'Skipped' : entry ? formatDuration(entry.durationMs) : 'Pending'}</dd>
                    </div>
                    <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">{getBaselineMetricDescription(metric)}</p>
                    {#if entry}<p class="mt-0.5 break-all text-[11px] text-[var(--stor-muted-text)]">{entry.metadata?.kind} · {entry.metadata?.route}</p>{/if}
                </div>
            {/each}
        </dl>
    </section>

    <h3 class="mt-4 text-sm font-semibold text-[var(--stor-ink)]">History for this build</h3>
    {#if activeSummaries.length > 0}
        <div class="mt-4 overflow-hidden rounded-lg bg-[var(--stor-surface-muted)]">
            {#each activeSummaries as summary}
                <section class="grid gap-3 border-b border-[var(--stor-border)] p-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center">
                    <div class="min-w-0">
                        <h3 class="truncate text-sm font-semibold text-stone-900">
                            {summary.label}
                        </h3>
                        <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
                            {summary.group}
                        </p>
                        <p class="mt-1 text-xs text-[var(--stor-muted-text)]">{summary.description}</p>
                        <p class="mt-1 text-xs text-[var(--stor-muted-text)]">
                            {summary.sampleCount} sample{summary.sampleCount === 1
                                ? ""
                                : "s"}
                        </p>
                    </div>
                    <div>
                        <div class="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">
                            Latest
                        </div>
                        <div class="text-sm font-semibold text-stone-900">
                            {summary.latestMs !== null
                                ? formatDuration(summary.latestMs)
                                : "—"}
                        </div>
                    </div>
                    <div>
                        <div class="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">
                            Avg
                        </div>
                        <div class="text-sm font-semibold text-stone-900">
                            {summary.averageMs !== null
                                ? formatDuration(summary.averageMs)
                                : "—"}
                        </div>
                    </div>
                    <div>
                        <div class="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">
                            Slow
                        </div>
                        <div class="text-sm font-semibold text-stone-900">
                            {summary.slowCount}
                        </div>
                    </div>
                </section>
            {/each}
        </div>
    {:else}
        <div
            class="mt-4 rounded-lg border border-dashed border-[var(--stor-border)] bg-[var(--stor-surface-muted)] py-6 text-center"
        >
            <p class="text-sm text-[var(--stor-muted-text)]">No performance samples yet.</p>
        </div>
    {/if}

    <div class="mt-4">
        <div class="mb-2 flex items-center justify-between gap-3">
            <h3 class="text-sm font-semibold text-stone-900">Recent samples</h3>
            <span class="text-xs text-[var(--stor-muted-text)]">{recentEntries.length}</span>
        </div>

        {#if recentEntries.length > 0}
            <div class="overflow-hidden rounded-lg bg-[var(--stor-surface-muted)]">
                {#each recentEntries as entry}
                    <div class="grid gap-1 border-b border-[var(--stor-border)] px-3 py-2 text-xs last:border-b-0 sm:grid-cols-[minmax(0,1fr)_7rem_10rem] sm:items-center">
                        <div class="min-w-0">
                            <div class="truncate font-medium text-stone-900">
                                {entry.baselineMetric
                                    ? getBaselineMetricLabel(
                                            entry.baselineMetric,
                                        )
                                    : entry.operation}
                            </div>
                            <div class="truncate text-[10.5px] text-[var(--stor-muted-text)]">
                                {entry.metadata?.route ?? 'Legacy sample'} · {entry.metadata?.kind ?? entry.category} · {entry.metadata?.outcome ?? 'success'}
                            </div>
                        </div>
                        <div class="font-semibold text-stone-900">
                            {formatDuration(entry.durationMs)}
                        </div>
                        <div class="text-[var(--stor-muted-text)]">
                            {new Date(entry.timestamp).toLocaleTimeString()}
                        </div>
                    </div>
                {/each}
            </div>
        {:else}
            <div
                class="rounded-lg border border-dashed border-[var(--stor-border)] bg-[var(--stor-surface-muted)] py-8 text-center"
            >
                <p class="text-sm text-[var(--stor-muted-text)]">
                    No samples yet.
                </p>
            </div>
        {/if}
    </div>
</div>
