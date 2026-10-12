<script lang="ts">
    import { onMount } from "svelte";
    import {
        syncLog,
        clearSyncLog,
        loadSyncLog,
        loadMoreSyncLog,
        type SyncLogType,
    } from "@hearthlog/runtime/store/sync.svelte.js";
    import IconDeleteOutline from "~icons/mdi/delete-outline";

    const typeConfig: Record<
        SyncLogType,
        { label: string; bgColor: string; textColor: string }
    > = {
        upload: {
            label: "UPLOAD",
            bgColor: "bg-green-100",
            textColor: "text-green-700",
        },
        download: {
            label: "DOWNLOAD",
            bgColor: "bg-blue-100",
            textColor: "text-blue-700",
        },
        ws_receive: {
            label: "WEBSOCKET",
            bgColor: "bg-cyan-100",
            textColor: "text-cyan-700",
        },
        ws_ready: {
            label: "READY",
            bgColor: "bg-emerald-100",
            textColor: "text-emerald-700",
        },
        ws_close: {
            label: "DISCONNECT",
            bgColor: "bg-[var(--stor-surface-muted)]",
            textColor: "text-stone-600",
        },
        ws_error: {
            label: "WS ERROR",
            bgColor: "bg-orange-100",
            textColor: "text-orange-700",
        },
        ws_resync: {
            label: "RESYNC",
            bgColor: "bg-violet-100",
            textColor: "text-violet-700",
        },
        drain: {
            label: "DRAIN",
            bgColor: "bg-amber-100",
            textColor: "text-amber-700",
        },
        error: {
            label: "ERROR",
            bgColor: "bg-red-100",
            textColor: "text-red-700",
        },
    };

    let expandedIds = $state<Set<string>>(new Set());
    let isLoadingMore = $state(false);

    onMount(() => {
        loadSyncLog();
    });

    function toggleExpanded(id: string) {
        const newSet = new Set(expandedIds);
        if (newSet.has(id)) {
            newSet.delete(id);
        } else {
            newSet.add(id);
        }
        expandedIds = newSet;
    }

    function formatTime(date: Date): string {
        return date.toLocaleTimeString("en-US", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    }

    async function handleLoadMore() {
        isLoadingMore = true;
        try {
            await loadMoreSyncLog();
        } finally {
            isLoadingMore = false;
        }
    }
</script>

<div class="stor-panel p-[var(--stor-panel-padding)]">
    <div class="mb-3 flex items-center justify-between gap-3">
        <h2 class="text-base font-semibold text-stone-900">
            Recent sync
        </h2>
        <div class="flex gap-2 items-center">
            <span class="text-xs text-[var(--stor-muted-text)]">
                {syncLog.entries.length} entries{syncLog.hasMore ? "+" : ""}
            </span>
            {#if syncLog.entries.length > 0}
                <button
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--stor-surface-muted)] px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-200"
                    onclick={clearSyncLog}
                >
                    <IconDeleteOutline class="h-3.5 w-3.5" />
                    Clear
                </button>
            {/if}
        </div>
    </div>

    {#if syncLog.entries.length > 0}
        <div
            class="max-h-80 overflow-y-auto rounded-lg bg-[var(--stor-surface-muted)]"
        >
            {#each syncLog.entries as entry (entry.id)}
                {@const config = typeConfig[entry.type]}
                <button
                    type="button"
                    class="w-full border-b border-[var(--stor-border)] px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-[var(--stor-surface-muted)] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-stone-300"
                    onclick={() => entry.details && toggleExpanded(entry.id)}
                    aria-expanded={entry.details
                        ? expandedIds.has(entry.id)
                        : undefined}
                >
                    <div class="flex items-center gap-2">
                        <span
                            class="w-14 shrink-0 text-[10.5px] text-[var(--stor-muted-text)]"
                        >
                            {formatTime(entry.timestamp)}
                        </span>
                        <span
                            class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide {config.bgColor} {config.textColor}"
                        >
                            {config.label}
                        </span>
                        <span class="text-xs text-stone-700 truncate flex-1">
                            {entry.message}
                        </span>
                        {#if entry.details}
                            <span
                                class="text-stone-300 text-xs transition-transform"
                                class:rotate-90={expandedIds.has(entry.id)}
                            >
                                ▶
                            </span>
                        {/if}
                    </div>
                    {#if entry.details && expandedIds.has(entry.id)}
                        <div
                            class="mt-2 ml-[4rem] rounded bg-[var(--stor-surface-muted)] px-2 py-1 text-[11px] text-[var(--stor-muted-text)]"
                        >
                            {entry.details}
                        </div>
                    {/if}
                </button>
            {/each}

            {#if syncLog.hasMore}
                <div class="py-3 text-center">
                    <button
                        type="button"
                        class="text-xs text-stone-700 hover:text-stone-950 font-medium disabled:opacity-50"
                        onclick={handleLoadMore}
                        disabled={isLoadingMore}
                    >
                        {isLoadingMore ? "Loading..." : "Load More"}
                    </button>
                </div>
            {/if}
        </div>
    {:else}
        <div
            class="rounded-lg border border-dashed border-[var(--stor-border)] bg-[var(--stor-surface-muted)] py-6 text-center"
        >
            <p class="text-sm text-[var(--stor-muted-text)]">No sync events</p>
        </div>
    {/if}
</div>
