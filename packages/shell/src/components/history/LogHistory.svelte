<script lang="ts">
    import { onMount, tick, untrack } from 'svelte';
    import { cachedCurrentUserEmail } from '@hearthlog/runtime/access/user-session.js';
    import { historyRouteUrl, navigateHistory } from '@hearthlog/runtime/history/navigation.js';
    import Button from '@hearthlog/ui/components/ui/Button.svelte';
    import ChangeRecord from './ChangeRecord.svelte';
    import LogMaintenance from './LogMaintenance.svelte';
    import { queryDatabase } from '@hearthlog/runtime/db/read-repositories.js';
    import { historyUrlState } from '@hearthlog/runtime/history/url.js';
    import type { HistoryEntry, HistoryItem, HistoryRecord } from '@hearthlog/runtime/history/contracts.js';
    import { formatHistoryDateTime } from '@hearthlog/runtime/history/history.js';
    import { FEATURE_ICONS } from '../layout/feature-icons.js';
    import { events } from '@hearthlog/runtime/store/events.svelte.js';
    import type { LogLineageIndex, LogSummary } from '@hearthlog/runtime/ledger/index.js';
    import { forkMarkers, ownChanges, type ForkMarker } from '@hearthlog/runtime/history/lineage.js';
    import { formatForkPoint, formatLogDay } from '@hearthlog/runtime/history/log-format.js';
    import { formatNumber } from '@hearthlog/ui/utils/number-format.js';
    import IconHistory from '~icons/mdi/history';
    import IconChevronRight from '~icons/mdi/chevron-right';
    import IconChevronDown from '~icons/mdi/chevron-down';
    import IconSourceBranch from '~icons/mdi/source-branch';
    import IconPlus from '~icons/mdi/plus';

    const PAGE = 60;

    let {
        currentLogId,
        currentLogName,
        logs,
        lineage,
        showHidden,
        switchingLogId = null,
        reveal = null,
        locked = false,
        onOpenLog,
        onOpenSyncIssues,
        onRange,
    }: {
        currentLogId: string | null;
        currentLogName: string | null;
        logs: LogSummary[];
        lineage: LogLineageIndex | null;
        showHidden: boolean;
        switchingLogId?: string | null;
        /** An action to scroll to without opening it, from the map. */
        reveal?: { id: string; nonce: number } | null;
        /** A new log is being created; the list stays still. */
        locked?: boolean;
        onOpenLog: (logId: string) => void;
        onOpenSyncIssues: () => void;
        /** The time span of the actions on screen. */
        onRange: (range: { from: number; to: number } | null) => void;
    } = $props();

    const view = $derived(historyUrlState(historyRouteUrl()));
    const current = $derived(logs.find(log => log.id === currentLogId) ?? null);
    const markers = $derived(forkMarkers(logs, lineage, { currentLogId, showHidden }));
    const markersByKey = $derived(new Map(markers.map(marker => [marker.key, marker])));
    const markerPositions = $derived(markers.map(marker => ({ key: marker.key, version: marker.version })));
    const sourceVersion = $derived(current?.sourceLogId ? current.sourceVersion ?? 0 : null);

    let items = $state<HistoryItem[]>([]);
    let limit = $state(PAGE);
    let loading = $state(true);
    let archivedHistory = $state(false);
    let error = $state('');
    let retry = $state(0);
    let entry = $state<HistoryEntry | null>(null);
    let changes = $state<HistoryRecord[]>([]);
    let detailLoading = $state(false);
    let detailError = $state('');
    let me = $state('');
    onMount(() => {
        // Authors are named only when someone else wrote the action.
        void cachedCurrentUserEmail().then((email) => { me = email; }).catch(() => undefined);
    });
    let root = $state<HTMLElement | null>(null);
    let sentinel = $state<HTMLElement | null>(null);
    let scrolledTo = '';
    /** An older action the map asked for, so the list loads until it. */
    let revealThrough = $state<string | null>(null);
    let revealPending = $state<string | null>(null);

    const total = $derived(items[0]?.total ?? 0);

    function navigate(values: Record<string, string | null>, replace = false) {
        const url = new URL(window.location.href);
        for (const [key, value] of Object.entries(values)) {
            if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
        }
        navigateHistory(url, replace);
    }

    // A new search or filter starts from the top again.
    $effect(() => {
        void view.search; void view.feature; void currentLogId;
        limit = PAGE;
        revealThrough = null;
    });

    $effect(() => {
        const scope = currentLogId;
        const options = { search: view.search, feature: view.feature, limit, through: revealThrough ?? view.action,
            sourceVersion, markers: markerPositions };
        void events.updatedAt;
        void retry;
        if (!scope) return;
        let cancelled = false;
        loading = true;
        error = '';
        void queryDatabase(r => r.history.list(options)).then(rows => {
            if (!cancelled) items = rows;
        }).catch(cause => { if (!cancelled) error = message(cause); })
            .finally(() => { if (!cancelled) loading = false; });
        return () => { cancelled = true; };
    });

    // Old links name a version; open the action it belongs to.
    $effect(() => {
        const version = view.version;
        if (!version || !currentLogId) return;
        void queryDatabase(r => r.history.get({ version })).then(found => {
            navigate({ historyVersion: null, historyAction: found?.id ?? null }, true);
        }).catch(() => navigate({ historyVersion: null }, true));
    });

    $effect(() => {
        const action = view.action;
        void events.updatedAt;
        if (!action || !currentLogId) { entry = null; changes = []; return; }
        let cancelled = false;
        detailLoading = true;
        detailError = '';
        void queryDatabase(async r => {
            const selected = await r.history.get({ id: action });
            if (!selected) throw new Error('This action is not in this log. Choose another one.');
            if (!cancelled) entry = selected;
            return selected.status === 'ready' ? r.history.changes(selected) : r.history.savedValues(selected.id);
        }).then(records => { if (!cancelled) changes = records; })
            .catch(cause => { if (!cancelled) detailError = message(cause); })
            .finally(() => { if (!cancelled) detailLoading = false; });
        return () => { cancelled = true; };
    });

    // Bring an action opened from a link into view once it has loaded.
    $effect(() => {
        const action = view.action;
        if (!action || scrolledTo === action || !items.some(item => item.id === action)) return;
        scrolledTo = action;
        void tick().then(() => root?.querySelector(`[data-history-item="${CSS.escape(action)}"]`)?.scrollIntoView({ block: 'nearest' }));
    });

    // The map moves the list: scroll to the action, loading older ones first when needed.
    $effect(() => {
        const target = reveal;
        if (!target) return;
        const element = untrack(() => root)?.querySelector<HTMLElement>(`[data-history-item="${CSS.escape(target.id)}"]`);
        if (element) { element.scrollIntoView({ block: 'start' }); return; }
        revealPending = target.id;
        if (untrack(() => revealThrough) !== target.id) revealThrough = target.id;
    });
    $effect(() => {
        const id = revealPending;
        if (!id || !items.some(item => item.id === id)) return;
        revealPending = null;
        void tick().then(() => root?.querySelector(`[data-history-item="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' }));
    });

    // Load the next page when the end of the list comes into view.
    $effect(() => {
        const target = sentinel;
        if (!target) return;
        const observer = new IntersectionObserver(entries => {
            if (entries.some(item => item.isIntersecting) && !loading && items.length < total) limit += PAGE;
        }, { root: target.closest('.stor-drawer-body'), rootMargin: '400px 0px' });
        observer.observe(target);
        return () => observer.disconnect();
    });

    // Report which part of the log is on screen, for the map's bracket.
    $effect(() => {
        const list = root;
        void items;
        if (!list) return;
        const visible = new Set<Element>();
        let frame = 0;
        const report = () => {
            frame = 0;
            const times = [...visible].map(element => Number((element as HTMLElement).dataset.time)).filter(Number.isFinite);
            onRange(times.length ? { from: Math.min(...times), to: Math.max(...times) } : null);
        };
        const observer = new IntersectionObserver(entries => {
            for (const item of entries) {
                if (item.isIntersecting) visible.add(item.target); else visible.delete(item.target);
            }
            if (!frame) frame = requestAnimationFrame(report);
        }, { root: list.closest('.stor-drawer-body') });
        list.querySelectorAll('[data-time]').forEach(element => observer.observe(element));
        return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
    });

    function toggle(item: HistoryEntry) {
        if (locked) return;
        navigate(view.action === item.id
            ? { historyAction: null, historyStep: null }
            : { historyAction: item.id, historyStep: null });
    }

    function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Could not load history. Try again.'; }
    function day(timestamp: number) { return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(timestamp); }
    function time(timestamp: number) { return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(timestamp); }
    function marker(item: HistoryItem): ForkMarker | undefined {
        return item.kind === 'marker' ? markersByKey.get(item.markerKey) : undefined;
    }
    function authorText(item: HistoryEntry): string {
        return item.actor && me && item.actor.toLowerCase() !== me.toLowerCase() ? ` · ${item.actor}` : '';
    }
    function statusText(item: HistoryEntry): string {
        return item.status === 'ready' ? '' : item.status === 'attention' ? ' · Needs attention' : ' · Waiting to sync';
    }
</script>

{#snippet ghost()}
    <li class="py-1">
        <div class="flex items-center gap-2 rounded-xl px-3 py-2 text-sm outline-dashed outline-[1.5px] -outline-offset-[1.5px] outline-[var(--stor-ink)]">
            <IconPlus class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)]" />
            <span class="min-w-0"><span class="block font-semibold text-[var(--stor-ink)]">New log starts here</span>
                <span class="block text-xs text-[var(--stor-muted-text)]">It keeps everything below this line.</span></span>
        </div>
    </li>
{/snippet}

<div bind:this={root}>
    {#if currentLogId}{#key currentLogId}<LogMaintenance logId={currentLogId} onHistoryLoaded={() => retry++} onArchivePresence={(present) => archivedHistory = present} />{/key}{/if}
    {#if loading && items.length === 0}
        <p role="status" class="py-2 text-sm text-[var(--stor-muted-text)] motion-safe:animate-pulse">Loading history…</p>
    {:else if !error && !items.some(item => item.kind === 'action')}
        <p class="py-4 text-sm text-[var(--stor-muted-text)]">{view.search || view.feature ? 'No actions match your search.' : archivedHistory ? 'Load the archive to inspect earlier actions.' : 'No activity in this log yet. Your next saved action will show here.'}</p>
    {/if}
    {#if items.length > 0}
        <ol aria-label="Activity in this log" aria-busy={loading}>
            {#if view.step === 'copy' && !view.search && !view.feature}{@render ghost()}{/if}
            {#each items as item (item.id)}
                {#if item.kind === 'marker'}
                    {@const found = marker(item)}
                    {#if found?.kind === 'start'}
                        <li class="py-2" data-time={Date.parse(found.log.sourceTimestamp ?? '') || undefined}>
                            <div class="rounded-2xl bg-[var(--stor-surface-muted)] px-3 py-2.5">
                                <p class="text-sm font-semibold text-[var(--stor-ink)]">{currentLogName ?? 'This log'} starts here</p>
                                <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
                                    {#if found.log.sourceLogId && logs.some(log => log.id === found.log.sourceLogId)}
                                        {found.version === 0 ? 'Started empty from' : 'Copied from'}
                                        <button type="button" class="font-semibold text-[var(--stor-ink)] underline decoration-[var(--stor-border)] underline-offset-2 hover:decoration-[var(--stor-ink)] disabled:no-underline"
                                            disabled={switchingLogId !== null || locked} onclick={() => onOpenLog(found.log.sourceLogId!)}>{found.log.sourceLogName ?? 'its source'}</button>{found.version === 0 ? '.' : ` up to ${formatForkPoint(found.log.sourceTimestamp)}.`}
                                        {found.log.sourceLogName ?? 'The source'} is unchanged.
                                    {:else}
                                        Copied from a log that is no longer available{found.version === 0 ? '' : `, up to ${formatForkPoint(found.log.sourceTimestamp)}`}.
                                    {/if}
                                </p>
                            </div>
                        </li>
                    {:else if found}
                        {@const log = found.log}
                        <li class="py-1">
                            <button type="button"
                                class="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left shadow-[inset_0_0_0_1px_var(--stor-border)] hover:bg-[var(--stor-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] disabled:cursor-default disabled:hover:bg-transparent"
                                aria-label={log.status === 'preparing' ? `${log.name} started here, preparing` : `Open ${log.name}, which started here`}
                                disabled={log.status === 'preparing' || switchingLogId !== null || locked}
                                onclick={() => onOpenLog(log.id)}>
                                <IconSourceBranch class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)]" />
                                <span class="min-w-0 flex-1">
                                    <span class="block break-words text-sm font-semibold text-[var(--stor-ink)]">{log.name}</span>
                                    <span class="block text-xs text-[var(--stor-muted-text)]">{log.status === 'preparing' ? 'Started here · preparing'
                                        : `Started here · ${formatNumber(ownChanges(log))} own ${ownChanges(log) === 1 ? 'change' : 'changes'}${ownChanges(log) > 0 && log.lastUpdatedAt ? ` · ${formatLogDay(log.lastUpdatedAt)}` : ''}`}</span>
                                </span>
                                {#if switchingLogId === log.id}<span class="shrink-0 text-xs text-[var(--stor-muted-text)]" role="status">Opening…</span>
                                {:else if log.status !== 'preparing'}<IconChevronRight class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)]" />{/if}
                            </button>
                        </li>
                    {/if}
                {:else}
                    {@const Icon = item.feature ? FEATURE_ICONS[item.feature] : IconHistory}
                    {@const open = view.action === item.id}
                    {#if view.step === 'fork' && open}{@render ghost()}{/if}
                    <li data-history-item={item.id} data-time={item.timestamp}>
                        {#if item.startsDay}<p class="px-2 pb-1.5 pt-4 text-xs font-semibold text-[var(--stor-muted-text)]">{day(item.timestamp)}</p>{/if}
                        <div class={open ? 'my-1 rounded-2xl bg-[var(--stor-surface-muted)] shadow-[inset_0_0_0_1px_var(--stor-border)]' : ''}>
                            <button type="button"
                                class="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] {open ? '' : 'hover:bg-[var(--stor-surface-hover)]'}"
                                aria-expanded={open} aria-controls={open ? `history-detail-${item.id}` : undefined}
                                disabled={locked}
                                onclick={() => toggle(item)}>
                                <Icon class="h-5 w-5 shrink-0 text-[var(--stor-muted-text)] {item.copied ? 'opacity-60' : ''}" />
                                <span class="min-w-0 flex-1">
                                    <span class="block break-words text-sm text-[var(--stor-ink)] {item.copied ? 'font-medium' : 'font-semibold'}">{item.label}</span>
                                    <span class="mt-0.5 block text-xs text-[var(--stor-muted-text)]">{time(item.timestamp)}{item.eventCount > 1 ? ` · ${formatNumber(item.eventCount)} changes` : ''}{authorText(item)}{statusText(item)}</span>
                                </span>
                                <IconChevronDown class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)] transition-transform motion-reduce:transition-none {open ? 'rotate-180' : ''}" />
                            </button>
                            {#if open}
                                <div id={`history-detail-${item.id}`} class="space-y-3 px-3 pb-3 sm:pl-10">
                                    {#if entry && entry.id === item.id && entry.status !== 'ready'}
                                        <p class="text-sm text-[var(--stor-muted-text)]">{entry.status === 'attention' ? 'Needs attention' : 'Waiting to sync'} · {entry.reason}</p>
                                        {#if entry.status === 'attention'}<Button variant="secondary" size="sm" onclick={onOpenSyncIssues}>Open sync issues</Button>{/if}
                                        <p class="text-xs text-[var(--stor-muted-text)]">Saved values on this device; these are not a confirmed before and after.</p>
                                    {/if}
                                    {#if detailLoading}<p role="status" class="text-sm text-[var(--stor-muted-text)] motion-safe:animate-pulse">Loading this action…</p>
                                    {:else if detailError}<p role="alert" class="text-sm text-[var(--stor-negative)]">{detailError}</p><Button variant="secondary" size="sm" onclick={() => retry++}>Retry</Button>
                                    {:else}
                                        {#each changes as change (change.key)}<ChangeRecord {change} />{/each}
                                        {#if changes.length === 0}<p class="text-sm text-[var(--stor-muted-text)]">This action has no field details to show.</p>{/if}
                                    {/if}
                                    <div class="flex flex-wrap items-center gap-2">
                                        <Button variant={view.step === 'fork' ? 'default' : 'secondary'} size="sm" aria-pressed={view.step === 'fork'}
                                            disabled={locked || item.status !== 'ready'}
                                            title={item.status === 'ready' ? undefined : 'Only synced actions can start a log.'}
                                            onclick={() => navigate({ historyStep: view.step === 'fork' ? null : 'fork' })}>
                                            <IconSourceBranch class="h-4 w-4" />New log after this
                                        </Button>
                                    </div>
                                    {#if entry && entry.id === item.id}
                                        <details class="text-xs text-[var(--stor-muted-text)]"><summary class="min-h-11 cursor-pointer py-3 sm:min-h-0 sm:py-1">Technical details</summary>
                                            <p class="break-all">{formatHistoryDateTime(entry.timestamp)} · {entry.version === null ? 'Not synced' : `Version ${entry.version}`}{entry.actor ? ` · ${entry.actor}` : ''} · {entry.id}</p></details>
                                    {/if}
                                </div>
                            {/if}
                        </div>
                    </li>
                {/if}
            {/each}
        </ol>
        {#if items.length < total}
            <p bind:this={sentinel} role="status" class="py-3 text-center text-xs text-[var(--stor-muted-text)]">Loading older actions…</p>
        {/if}
    {/if}
    {#if error}<p role="alert" class="text-sm text-[var(--stor-negative)]">{error}</p><Button variant="secondary" onclick={() => retry++}>Retry</Button>{/if}
</div>
