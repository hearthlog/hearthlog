<script lang="ts">
    import { untrack } from 'svelte';
    import { historyRouteUrl, navigateHistory } from '@hearthlog/runtime/history/navigation.js';
    import { historyUrlState } from '@hearthlog/runtime/history/url.js';
    import Drawer from '@hearthlog/ui/components/Drawer.svelte';
    import Button from '@hearthlog/ui/components/ui/Button.svelte';
    import Input from '@hearthlog/ui/components/ui/Input.svelte';
    import Select from '@hearthlog/ui/components/ui/Select.svelte';
    import LogHistory from '../history/LogHistory.svelte';
    import LogMap from '../history/LogMap.svelte';
    import LogTree from '../history/LogTree.svelte';
    import ForkComposer from '../history/ForkComposer.svelte';
    import { queryDatabase } from '@hearthlog/runtime/db/read-repositories.js';
    import { FEATURES } from '@hearthlog/contracts/features/registry';
    import { isFeatureEnabled } from '@hearthlog/contracts/tenant/config';
    import type { LogLineageIndex, LogSummary } from '@hearthlog/runtime/ledger/index.js';
    import { flattenTree, logAncestors, logTree } from '@hearthlog/runtime/history/lineage.js';
    import { mapSpan, type MapSpan } from '@hearthlog/runtime/history/log-map.js';
    import type { HistoryPoint } from '@hearthlog/runtime/history/contracts.js';
    import { logs as logStore } from '@hearthlog/runtime/store/logs.svelte.js';
    import { events } from '@hearthlog/runtime/store/events.svelte.js';
    import { syncStatus } from '@hearthlog/runtime/store/sync.svelte.js';
    import { notify } from '@hearthlog/ui/state/notifications.svelte.js';
    import IconLayers from '~icons/mdi/layers-outline';
    import IconCopy from '~icons/mdi/content-copy';
    import IconPlus from '~icons/mdi/plus';

    let {
        show,
        logs,
        lineage,
        currentLogId,
        currentLogName,
        onClose,
        onSwitch,
        onCreate,
        onOpenSyncIssues = () => {},
        createDisabled = false,
        createDisabledReason,
    }: {
        show: boolean;
        logs: LogSummary[];
        lineage: LogLineageIndex | null;
        currentLogId: string | null;
        currentLogName: string | null;
        onClose: () => void;
        onSwitch: (logId: string) => Promise<void>;
        onCreate: () => void;
        onOpenSyncIssues?: () => void;
        createDisabled?: boolean;
        createDisabledReason?: string;
    } = $props();

    const view = $derived(historyUrlState(historyRouteUrl()));
    const tree = $derived(logTree(logs, lineage, { currentLogId, showHidden: view.showHidden }));
    const shown = $derived(flattenTree(tree));
    const ancestors = $derived(logAncestors(logs, currentLogId));
    const hiddenCount = $derived(logs.filter(log => log.hiddenAt && log.id !== currentLogId).length);
    const featureOptions = [{ value: 'all', label: 'All features' }, ...FEATURES.filter(feature => isFeatureEnabled(feature.id))
        .map(feature => ({ value: feature.id, label: feature.page?.label ?? feature.id }))];

    let switchingLogId = $state<string | null>(null);
    let hidingLogId = $state<string | null>(null);
    let forkBusy = $state(false);
    let error = $state('');
    let range = $state<{ from: number; to: number } | null>(null);
    let points = $state<HistoryPoint[]>([]);
    let span = $state<MapSpan | null>(null);
    let reveal = $state<{ id: string; nonce: number } | null>(null);
    let query = $state('');

    function navigate(values: Record<string, string | null>, replace = false) {
        const url = new URL(window.location.href);
        for (const [key, value] of Object.entries(values)) {
            if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
        }
        navigateHistory(url, replace);
    }

    $effect(() => { query = view.search; });
    $effect(() => {
        const search = query;
        if (search === untrack(() => view.search)) return;
        const timer = setTimeout(() => navigate({ historySearch: search }, true), 250);
        return () => clearTimeout(timer);
    });

    // The map's span ends at the newest action; its points are read from SQL for that span.
    $effect(() => {
        const scope = currentLogId;
        const nodes = shown;
        void events.updatedAt;
        if (!show || !scope || view.tab !== 'history') return;
        let cancelled = false;
        void queryDatabase(async r => {
            const now = Date.now();
            const next = mapSpan(nodes, now, await r.history.newest());
            return { next, rows: await r.history.points(next.start, next.end) };
        }).then(({ next, rows }) => { if (!cancelled) { span = next; points = rows; } })
            .catch(() => { if (!cancelled) points = []; });
        return () => { cancelled = true; };
    });

    async function openLog(logId: string): Promise<void> {
        if (logId === currentLogId || switchingLogId || forkBusy) return;
        const log = logs.find(item => item.id === logId);
        if (!log || log.status === 'preparing') return;
        switchingLogId = logId;
        error = '';
        try {
            await onSwitch(logId);
            onClose();
        } catch (cause) {
            error = cause instanceof Error ? cause.message : 'Could not open this log.';
        } finally {
            switchingLogId = null;
        }
    }

    async function setHidden(logId: string, hidden: boolean): Promise<void> {
        const log = logs.find(item => item.id === logId);
        if (!log || hidingLogId) return;
        hidingLogId = logId;
        try {
            await logStore.setHidden(logId, hidden);
            if (hidden) {
                notify.success(`Hid ${log.name}`, { label: 'Undo', run: async () => {
                    try { await logStore.setHidden(logId, false); } catch (cause) { notify.error(cause instanceof Error ? cause.message : 'Could not show this log.'); }
                } });
            }
        } catch (cause) {
            notify.error(cause instanceof Error ? cause.message : `Could not ${hidden ? 'hide' : 'show'} this log.`);
        } finally {
            hidingLogId = null;
        }
    }

    function changeTab(tab: 'history' | 'logs'): void {
        error = '';
        navigate({ logPanel: tab === 'logs' ? 'logs' : 'activity', historyStep: null });
    }

    function createEmptyLog(): void {
        onClose();
        onCreate();
    }
</script>

<Drawer {show} title={currentLogName ?? 'Your log'} onClose={() => { if (!forkBusy) onClose(); }}
    footer={view.tab === 'logs' || view.step === 'copy' || (view.step === 'fork' && view.action) ? panelFooter : undefined}>
    {#snippet lead()}
        <div class="space-y-3">
            {#if ancestors.length > 0}
                <p class="-mt-2 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-[var(--stor-muted-text)]" aria-label="Where this log came from">
                    <IconLayers class="mr-0.5 h-3.5 w-3.5" />
                    {#each ancestors as ancestor (ancestor.id)}
                        <button type="button" class="rounded-md px-1 py-0.5 font-medium hover:bg-[var(--stor-surface-hover)] hover:text-[var(--stor-ink)] disabled:hover:bg-transparent"
                            disabled={switchingLogId !== null || forkBusy} onclick={() => void openLog(ancestor.id)}>{ancestor.name}</button>
                        <span aria-hidden="true" class="text-[var(--stor-border)]">›</span>
                    {/each}
                    <span class="px-1 font-semibold text-[var(--stor-ink)]">{currentLogName}</span>
                </p>
            {/if}
            <div class="flex items-center gap-2">
                <div class="stor-segmented-control flex min-w-0 flex-1" role="group" aria-label="Show">
                    <button type="button" class="stor-segmented-option flex-1" aria-pressed={view.tab === 'history'} onclick={() => changeTab('history')}>History</button>
                    <button type="button" class="stor-segmented-option flex-1" aria-pressed={view.tab === 'logs'} onclick={() => changeTab('logs')}>Logs</button>
                </div>
                <Button variant="secondary" size="sm" disabled={forkBusy} aria-pressed={view.step === 'copy'}
                    onclick={() => navigate({ logPanel: 'activity', historyStep: view.step === 'copy' ? null : 'copy', historyAction: null })}>
                    <IconCopy class="h-4 w-4" />Copy this log
                </Button>
            </div>
            {#if view.tab === 'history'}
                {#if shown.length > 0 && span}
                    <LogMap nodes={shown} {logs} {currentLogId} {points} {span} {range} openActionId={view.action}
                        disabled={switchingLogId !== null || forkBusy} onOpen={(id) => void openLog(id)}
                        onPick={(id) => navigate({ historyAction: id, historyStep: null })}
                        onReveal={(id) => { reveal = { id, nonce: (reveal?.nonce ?? 0) + 1 }; }} />
                {/if}
                <div class="grid grid-cols-[minmax(0,1fr)_8rem] gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]">
                    <Input type="search" aria-label="Search history" placeholder="Search history" bind:value={query} />
                    <Select ariaLabel="Filter history by feature" value={view.feature || 'all'} options={featureOptions}
                        onValueChange={value => navigate({ historyFeature: value === 'all' ? null : value })} />
                </div>
            {/if}
            {#if error}<p role="alert" class="text-sm text-[var(--stor-negative)]">{error}</p>{/if}
        </div>
    {/snippet}

    {#if view.tab === 'logs'}
        {#if logs.length === 0}
            <p class="rounded-2xl bg-[var(--stor-surface-muted)] p-5 text-sm text-[var(--stor-muted-text)]">No logs yet. Create an empty log to get started.</p>
        {:else}
            <LogTree nodes={tree} {currentLogId} {switchingLogId} busyLogId={hidingLogId}
                hideDisabledReason={syncStatus.isOnline ? undefined : 'Connect to hide or show logs.'}
                onOpen={(id) => void openLog(id)} onHide={(id, hidden) => void setHidden(id, hidden)} />
        {/if}
    {:else}
        <LogHistory {currentLogId} {currentLogName} {logs} {lineage} showHidden={view.showHidden} {switchingLogId} {reveal} locked={forkBusy}
            onOpenLog={(id) => void openLog(id)} {onOpenSyncIssues} onRange={(value) => { range = value; }} />
    {/if}

</Drawer>

{#snippet panelFooter()}
    {#if view.tab === 'logs'}
        <div class="flex w-full flex-wrap items-center justify-between gap-2">
            {#if hiddenCount > 0 || view.showHidden}
                <Button variant="ghost" size="sm" aria-pressed={view.showHidden} onclick={() => navigate({ hiddenLogs: view.showHidden ? null : '1' }, true)}>
                    {view.showHidden ? 'Hide hidden logs' : `Show ${hiddenCount} hidden`}
                </Button>
            {:else}
                <span></span>
            {/if}
            <Button variant="secondary" size="sm" disabled={createDisabled} title={createDisabled ? createDisabledReason : undefined} onclick={createEmptyLog}>
                <IconPlus class="h-4 w-4" />New empty log
            </Button>
        </div>
    {:else if view.step === 'copy' || (view.step === 'fork' && view.action)}
        <ForkComposer step={view.step} actionId={view.action} {currentLogId} {currentLogName} {logs}
            onCancel={() => navigate({ historyStep: null })} onSwitch={onSwitch} onDone={onClose}
            onBusyChange={(busy) => { forkBusy = busy; }} />
    {/if}
{/snippet}
