<script lang="ts">
    import { invalidate } from "$app/navigation";
    import { MODULE_REFRESH_KEYS } from '#generated/modules';
    import Drawer from "@hearthlog/ui/components/Drawer.svelte";
    import {
        discardSyncIssue,
        getSyncIssues,
        reapplyLocalSyncIssue,
        rebaseSyncIssue,
        useTheirsSyncIssue,
        type SyncIssue,
    } from "@hearthlog/runtime/store/sync-issues.js";
    import { describeClash, formatClashValue, humanizeField } from "@hearthlog/runtime/store/conflict-merge.js";
    import { refreshEntitySyncState } from "@hearthlog/runtime/store/entity-sync-state.svelte.js";
    import { notify } from "@hearthlog/ui/state/notifications.svelte.js";
    import { runSyncCoordinator, signalLocalChange } from "@hearthlog/runtime/store/sync.svelte.js";

    let { show, onClose }: { show: boolean; onClose: () => void } = $props();
    let issues = $state<SyncIssue[]>([]);
    let loading = $state(false);
    let actingOn = $state<string | null>(null);

    async function load(): Promise<void> {
        loading = true;
        try {
            issues = await getSyncIssues();
        } catch (error) {
            notify.error(error instanceof Error ? error.message : "Could not load sync issues");
        } finally {
            loading = false;
        }
    }

    async function refreshApp(): Promise<void> {
        await refreshEntitySyncState();
        await Promise.all([
            ...MODULE_REFRESH_KEYS.map((key) => invalidate(key)),
            invalidate("app:entities"),
        ]);
        await load();
    }

    async function act(issue: SyncIssue, action: "rebase" | "reapply" | "discard" | "theirs"): Promise<void> {
        actingOn = issue.operationId;
        try {
            if (action === "rebase") await rebaseSyncIssue(issue.operationId);
            if (action === "reapply") await reapplyLocalSyncIssue(issue.operationId);
            if (action === "discard") await discardSyncIssue(issue.operationId);
            if (action === "theirs") await useTheirsSyncIssue(issue.operationId);
            if (action !== "discard") {
                signalLocalChange();
                await runSyncCoordinator("manual");
            }
            await refreshApp();
            notify.success(action === "discard" ? "Local change discarded"
                : action === "theirs" ? "Kept the other device's values"
                : "Local change queued again");
        } catch (error) {
            notify.error(error instanceof Error ? error.message : "Could not resolve sync issue");
        } finally {
            actingOn = null;
        }
    }

    function formatTime(value: string): string {
        return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
    }

    $effect(() => {
        if (show) void load();
    });
</script>

<Drawer {show} title="Sync issues" description="Resolve local changes the Ledger could not accept." {onClose}>
    {#if loading && issues.length === 0}
        <p class="py-10 text-center text-sm text-[var(--stor-muted-text)]">Loading sync issues…</p>
    {:else if issues.length === 0}
        <section class="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
            <h3 class="font-semibold text-emerald-900">No blocked changes</h3>
            <p class="mt-1 text-sm text-emerald-700">Local changes can sync normally.</p>
        </section>
    {:else}
        <div class="space-y-4">
            {#each issues as issue (issue.operationId)}
                <article class="rounded-xl border border-red-200 bg-white p-4 ">
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                            <div class="text-sm font-semibold text-stone-950">{issue.conflicts.length > 0 ? "Edited on two devices" : issue.errorCode ?? "Ledger rejected this change"}</div>
                            {#if issue.conflicts.length === 0}
                                <p class="mt-1 text-sm leading-5 text-stone-600">{issue.errorMessage ?? "The remote log could not accept this local operation."}</p>
                            {/if}
                        </div>
                        <span class="rounded-full bg-red-50 px-2 py-1 text-[10.5px] font-bold uppercase text-red-700">Blocked</span>
                    </div>
                    {#if issue.conflicts.length > 0}
                        <ul class="mt-3 space-y-2" aria-label="Conflicting changes">
                            {#each issue.conflicts as clash}
                                <li class="rounded-xl bg-[var(--stor-surface-muted)] p-3 text-sm">
                                    {#if clash.kind === "field"}
                                        <div class="font-semibold text-[var(--stor-ink)]">{humanizeField(clash.field)}</div>
                                        <dl class="mt-1 grid grid-cols-2 gap-3 text-xs">
                                            <div><dt class="text-[var(--stor-muted-text)]">Yours</dt><dd class="break-words text-[var(--stor-ink)]">{formatClashValue(clash.mine)}</dd></div>
                                            <div><dt class="text-[var(--stor-muted-text)]">Theirs</dt><dd class="break-words text-[var(--stor-ink)]">{formatClashValue(clash.theirs)}</dd></div>
                                        </dl>
                                    {:else}
                                        <p class="text-[var(--stor-ink)]">{describeClash(clash)}</p>
                                    {/if}
                                </li>
                            {/each}
                        </ul>
                    {/if}
                    <dl class="mt-3 grid grid-cols-2 gap-2 text-xs text-[var(--stor-muted-text)]">
                        <div><dt class="font-semibold text-stone-700">Attempts</dt><dd>{issue.retryCount} retries · {issue.rebaseCount} rebases</dd></div>
                        <div><dt class="font-semibold text-stone-700">Last attempt</dt><dd>{formatTime(issue.updatedAt)}</dd></div>
                    </dl>
                    {#if issue.affectedEntities.length > 0}
                        <div class="mt-3 flex flex-wrap gap-1.5">
                            {#each issue.affectedEntities as entity}
                                <span class="rounded-md bg-[var(--stor-surface-muted)] px-2 py-1 font-mono text-[10.5px] text-stone-600">{entity}</span>
                            {/each}
                        </div>
                    {/if}
                    <details class="mt-3 rounded-xl bg-[var(--stor-surface-muted)] p-3 text-xs text-stone-600">
                        <summary class="cursor-pointer font-semibold text-stone-700">Inspect events and history</summary>
                        <div class="mt-3 space-y-2">
                            {#each issue.events as event}
                                <div class="rounded-lg bg-[var(--stor-surface-muted)] p-2"><span class="font-mono font-semibold">{event.type}</span><div class="mt-1 break-all text-[var(--stor-muted-text)]">{event.id}</div></div>
                            {/each}
                            {#each issue.history as entry}
                                <div class="border-l-2 border-[var(--stor-border)] pl-2"><span class="font-semibold">{entry.action}</span> · {formatTime(entry.createdAt)}</div>
                            {/each}
                        </div>
                    </details>
                    <div class="mt-4 grid gap-2 sm:grid-cols-2">
                        {#if issue.canRebase}
                            <button type="button" class="rounded-xl bg-stone-950 px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-50" disabled={actingOn !== null} onclick={() => void act(issue, "rebase")}>{issue.conflicts.length > 0 ? "Keep mine" : "Retry with latest"}</button>
                        {/if}
                        {#if issue.conflicts.length > 0}
                            <button type="button" class="rounded-xl border border-[var(--stor-field-border)] bg-white px-3 py-2.5 text-sm font-semibold text-stone-800 disabled:opacity-50" disabled={actingOn !== null} onclick={() => void act(issue, "theirs")}>Use theirs</button>
                        {:else if issue.canReapply}
                            <button type="button" class="rounded-xl border border-[var(--stor-field-border)] bg-white px-3 py-2.5 text-sm font-semibold text-stone-800 disabled:opacity-50" disabled={actingOn !== null} onclick={() => void act(issue, "reapply")}>Reapply as new</button>
                        {/if}
                        <button type="button" class="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm font-semibold text-red-700 disabled:opacity-50" disabled={actingOn !== null} onclick={() => void act(issue, "discard")}>Discard local</button>
                    </div>
                </article>
            {/each}
        </div>
    {/if}
</Drawer>
