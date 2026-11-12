<script lang="ts">
    import { onMount, tick, untrack } from 'svelte';
    import { SvelteMap, SvelteSet } from 'svelte/reactivity';
    import { FEATURES } from '@hearthlog/contracts/features/registry';
    import { layoutTimeline } from '@hearthlog/runtime/history/timeline-layout.js';
    import { cachedCurrentUserEmail } from '@hearthlog/runtime/access/user-session.js';
    import { historyRouteUrl, navigateHistory } from '@hearthlog/runtime/history/navigation.js';
    import Button from '@hearthlog/ui/components/ui/Button.svelte';
    import ChangeRecord from './ChangeRecord.svelte';
    import LogMaintenance from './LogMaintenance.svelte';
    import { queryDatabase } from '@hearthlog/runtime/db/read-repositories.js';
    import { historyUrlState } from '@hearthlog/runtime/history/url.js';
    import type { HistoryCursor, HistoryEntry, HistoryFold, HistoryRecord, HistoryTimelineRow } from '@hearthlog/runtime/history/contracts.js';
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

    type Rows = { rows: HistoryTimelineRow[]; next: HistoryCursor | null; loading: boolean };
    type Members = { rows: HistoryTimelineRow[]; next: number | null; loading: boolean };

    const view = $derived(historyUrlState(historyRouteUrl()));
    const current = $derived(logs.find(log => log.id === currentLogId) ?? null);
    const filtered = $derived(Boolean(view.search || view.feature));
    const markers = $derived(filtered ? [] : forkMarkers(logs, lineage, { currentLogId, showHidden }));
    const sourceVersion = $derived(current?.sourceLogId ? current.sourceVersion ?? 0 : null);

    /** The newest actions and bursts, one page at a time. */
    let rows = $state<HistoryTimelineRow[]>([]);
    let next = $state<HistoryCursor | null>(null);
    /** Older actions fold into months from here; null when the log lists whole. */
    let foldAt = $state<number | null>(null);
    let months = $state<HistoryFold[]>([]);
    const openFolds = new SvelteSet<string>();
    const days = new SvelteMap<string, HistoryFold[]>();
    const dayRows = new SvelteMap<string, Rows>();
    const bursts = new SvelteMap<string, Members>();
    /** Actions below the newest burst when the list was read: if that changes, older history changed and the list reads again. */
    let below = -1;
    let loaded = $state(false);
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
    /** Search also looks inside saved values; slower, so only when asked. */
    let searchValues = $state(false);
    /** Bumped whenever rows on screen change, so the map's bracket is measured again. */
    let drawn = $state(0);

    const entries = $derived(layoutTimeline({ rows, markers, folds: months, complete: next === null }));
    const hasActions = $derived(rows.length > 0 || months.length > 0);

    function filters() {
        return { search: view.search, feature: view.feature, searchValues, sourceVersion };
    }
    const cursorOf = (row: HistoryTimelineRow): HistoryCursor => ({ pending: row.pending, run: row.runStart });
    const burstKey = (row: { pending: number; runStart: number }) => `${row.pending}:${row.runStart}`;

    /** Reads run one after another, so a refresh never interleaves with the read it refreshes. */
    let queue: Promise<unknown> = Promise.resolve();
    let generation = 0;
    function serial<T>(work: () => Promise<T>): Promise<T> {
        const run = queue.then(work, work);
        queue = run.catch(() => undefined);
        return run;
    }

    function navigate(values: Record<string, string | null>, replace = false) {
        const url = new URL(window.location.href);
        for (const [key, value] of Object.entries(values)) {
            if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
        }
        navigateHistory(url, replace);
    }

    /** Read the list from the top: the newest page, where folding starts, and the months below. */
    function reload(): Promise<void> {
        const mine = ++generation;
        const options = { ...filters() };
        const fold = !filtered;
        loading = true;
        error = '';
        return serial(() => queryDatabase(async r => {
            const at = fold ? await r.history.foldStart() : null;
            const page = await r.history.timeline({ ...options, since: at, limit: PAGE });
            const top = page.rows.find(row => row.pending === 0);
            const count = top ? await r.history.countBelow(cursorOf(top), options) : -1;
            const folds = at === null ? [] : await r.history.folds('month', { until: at });
            return { at, page, count, folds };
        })).then(({ at, page, count, folds }) => {
            if (mine !== generation) return;
            foldAt = at;
            rows = page.rows;
            next = page.next;
            below = count;
            months = folds;
            for (const key of [...openFolds]) {
                if (!key.startsWith('burst:') && !folds.some(month => key.startsWith(month.key))) openFolds.delete(key);
            }
            loaded = true;
            drawn++;
            void refreshOpened();
        }).catch(cause => { if (mine === generation) error = message(cause); })
            .finally(() => { if (mine === generation) loading = false; });
    }

    /** After a save or a sync: read only what changed at the top, unless older history changed too. */
    function refresh(): Promise<void> {
        const mine = generation;
        const top = rows.find(row => row.pending === 0);
        if (!top) return reload();
        const options = { ...filters() };
        return serial(() => queryDatabase(async r => {
            const count = await r.history.countBelow(cursorOf(top), options);
            if (count !== below) return null;
            const delta = await r.history.timeline({ ...options, since: foldAt, through: cursorOf(top) });
            // The next refresh compares against the new top.
            const newTop = delta.rows.find(row => row.pending === 0);
            const nextBelow = newTop ? await r.history.countBelow(cursorOf(newTop), options) : count;
            return { delta, nextBelow };
        })).then(result => {
            if (mine !== generation) return;
            if (!result) { void reload(); return; }
            const { delta, nextBelow } = result;
            below = nextBelow;
            rows = [...delta.rows, ...rows.filter(row => row.pending === 0 && row.runStart < top.runStart)];
            drawn++;
            void refreshOpened();
        }).catch(cause => { if (mine === generation) error = message(cause); });
    }

    function loadMore(): void {
        const cursor = next;
        if (!cursor || loading) return;
        const mine = generation;
        loading = true;
        void serial(() => queryDatabase(r => r.history.timeline({ ...filters(), since: foldAt, before: cursor, limit: PAGE })))
            .then(page => {
                if (mine !== generation) return;
                rows = [...rows, ...page.rows];
                next = page.next;
                drawn++;
            }).catch(cause => { if (mine === generation) error = message(cause); })
            .finally(() => { if (mine === generation) loading = false; });
    }

    /** The days of a month, or a day's rows, read when opened. */
    function dayBounds(key: string): { since: number; until: number } {
        const [year, month, day] = key.split('-').map(Number);
        const since = new Date(year!, month! - 1, day ?? 1).getTime();
        const end = day ? new Date(year!, month! - 1, day + 1) : new Date(year!, month!, 1);
        return { since, until: Math.min(end.getTime(), foldAt ?? Number.POSITIVE_INFINITY) };
    }

    async function loadFold(key: string, through: HistoryCursor | null = null): Promise<void> {
        const span = dayBounds(key);
        if (key.length === 7) {
            const found = await serial(() => queryDatabase(r => r.history.folds('day', span)));
            days.set(key, found);
        } else {
            const previous = dayRows.get(key);
            dayRows.set(key, { rows: previous?.rows ?? [], next: previous?.next ?? null, loading: true });
            const page = await serial(() => queryDatabase(r => r.history.timeline({ ...filters(), ...span, limit: PAGE, through })));
            dayRows.set(key, { rows: page.rows, next: page.next, loading: false });
        }
        drawn++;
    }

    async function loadMoreDay(key: string): Promise<void> {
        const state = dayRows.get(key);
        if (!state?.next || state.loading) return;
        dayRows.set(key, { ...state, loading: true });
        const page = await serial(() => queryDatabase(r => r.history.timeline({ ...filters(), ...dayBounds(key), before: state.next, limit: PAGE })));
        dayRows.set(key, { rows: [...state.rows, ...page.rows], next: page.next, loading: false });
        drawn++;
    }

    async function loadBurst(row: { pending: number; runStart: number }, all = false): Promise<void> {
        const key = burstKey(row);
        const previous = bursts.get(key);
        bursts.set(key, { rows: previous?.rows ?? [], next: previous?.next ?? null, loading: true });
        const page = await serial(() => queryDatabase(r => r.history.members({ pending: row.pending, run: row.runStart },
            { ...filters(), limit: all ? 100_000 : PAGE })));
        bursts.set(key, { rows: page.rows, next: page.next, loading: false });
        drawn++;
    }

    async function loadMoreBurst(key: string): Promise<void> {
        const state = bursts.get(key);
        if (!state?.next || state.loading) return;
        const [pending, run] = key.split(':').map(Number);
        bursts.set(key, { ...state, loading: true });
        const page = await serial(() => queryDatabase(r => r.history.members({ pending: pending!, run: run! },
            { ...filters(), limit: PAGE, beforePosition: state.next })));
        bursts.set(key, { rows: [...state.rows, ...page.rows], next: page.next, loading: false });
        drawn++;
    }

    /** Opened days and bursts read again after a change; they are few and small. */
    async function refreshOpened(): Promise<void> {
        try {
            for (const key of [...openFolds]) if (!key.startsWith('burst:')) await loadFold(key);
            for (const key of [...bursts.keys()]) {
                if (!openFolds.has(`burst:${key}`)) { bursts.delete(key); continue; }
                const [pending, run] = key.split(':').map(Number);
                await loadBurst({ pending: pending!, runStart: run! });
            }
        } catch { /* the next refresh tries again */ }
    }

    function toggleFold(key: string): void {
        if (openFolds.has(key)) { openFolds.delete(key); return; }
        openFolds.add(key);
        void loadFold(key).catch(cause => { error = message(cause); });
    }

    function toggleBurst(row: HistoryTimelineRow): void {
        if (locked) return;
        const key = `burst:${burstKey(row)}`;
        if (openFolds.has(key)) { openFolds.delete(key); bursts.delete(burstKey(row)); return; }
        openFolds.add(key);
        void loadBurst(row).catch(cause => { error = message(cause); });
    }

    function monthKey(timestamp: number): string {
        const date = new Date(timestamp);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }
    function dayKey(timestamp: number): string {
        const date = new Date(timestamp);
        return `${monthKey(timestamp)}-${String(date.getDate()).padStart(2, '0')}`;
    }

    /**
     * Open whatever holds an action (its month and day, its burst) and load the list down to it. With `open` false
     * (the map, while dragging) folded history only scrolls to its month and closed bursts stay closed.
     */
    async function bringIntoView(id: string, open: boolean): Promise<string | null> {
        const location = await serial(() => queryDatabase(r => r.history.locate(id)));
        if (!location) return null;
        const cursor = { pending: location.pending, run: location.runStart };
        if (foldAt !== null && location.timestamp < foldAt) {
            const month = monthKey(location.timestamp);
            if (!open) {
                const day = dayKey(location.timestamp);
                if (openFolds.has(day) && dayRows.get(day)?.rows.some(row => row.id === location.runTop)) return location.runTop;
                return openFolds.has(month) ? `fold:${day}` : `fold:${month}`;
            }
            const day = dayKey(location.timestamp);
            if (!openFolds.has(month)) { openFolds.add(month); await loadFold(month); }
            const state = dayRows.get(day);
            if (!openFolds.has(day) || !state?.rows.some(row => row.id === location.runTop)) {
                openFolds.add(day);
                await loadFold(day, cursor);
            }
        } else if (!rows.some(row => row.id === location.runTop) && next) {
            const mine = generation;
            const page = await serial(() => queryDatabase(r => r.history.timeline({ ...filters(), since: foldAt, through: cursor })));
            if (mine !== generation) return null;
            const known = new Set(page.rows.map(row => row.id));
            rows = [...page.rows, ...rows.filter(row => !known.has(row.id) && row.pending === 0 && row.runStart < location.runStart)];
            next = page.next;
            drawn++;
        }
        if (location.runTop === location.id) return location.id;
        if (!open && !openFolds.has(`burst:${burstKey(location)}`)) return location.runTop;
        openFolds.add(`burst:${burstKey(location)}`);
        if (!bursts.get(burstKey(location))?.rows.some(row => row.id === id)) await loadBurst(location, true);
        return id;
    }

    function scrollToItem(key: string, block: ScrollLogicalPosition): void {
        void tick().then(() => {
            const selector = key.startsWith('fold:') ? `[data-history-fold="${CSS.escape(key.slice(5))}"]` : `[data-history-item="${CSS.escape(key)}"]`;
            root?.querySelector(selector)?.scrollIntoView({ block });
        });
    }

    // A new log, search or filter reads from the top again.
    $effect(() => {
        void view.search; void view.feature; void currentLogId; void sourceVersion; void searchValues; void retry;
        if (!currentLogId) return;
        untrack(() => {
            openFolds.clear(); days.clear(); dayRows.clear(); bursts.clear();
            loaded = false;
            void reload();
        });
    });
    $effect(() => {
        void view.search; void view.feature; void currentLogId;
        searchValues = false;
    });

    // After a save or a sync only the top of the list reads again.
    $effect(() => {
        void events.updatedAt;
        if (!untrack(() => loaded)) return;
        void untrack(() => refresh());
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
        // A settled action reads the same after any later sync; only one still syncing is read again.
        if (untrack(() => entry)?.status !== 'ready') void events.updatedAt;
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

    // An action opened from a link opens what holds it and comes into view once it has loaded.
    $effect(() => {
        const action = view.action;
        if (!action || !loaded || scrolledTo === action) return;
        scrolledTo = action;
        void untrack(() => bringIntoView(action, true)).then(key => { if (key) scrollToItem(key, 'nearest'); }).catch(() => undefined);
    });

    // The map moves the list: scroll to the action, its burst, or the month that holds it. Only the latest counts.
    let revealing = 0;
    $effect(() => {
        const target = reveal;
        if (!target || !untrack(() => loaded)) return;
        const mine = ++revealing;
        const element = untrack(() => root)?.querySelector<HTMLElement>(`[data-history-item="${CSS.escape(target.id)}"]`);
        if (element) { element.scrollIntoView({ block: 'start' }); return; }
        void untrack(() => bringIntoView(target.id, false)).then(key => {
            if (key && mine === revealing) scrollToItem(key, 'start');
        }).catch(() => undefined);
    });

    // Load the next page when the end of the list comes into view.
    $effect(() => {
        const target = sentinel;
        if (!target) return;
        const observer = new IntersectionObserver(found => {
            if (found.some(item => item.isIntersecting)) loadMore();
        }, { root: target.closest('.stor-drawer-body'), rootMargin: '400px 0px' });
        observer.observe(target);
        return () => observer.disconnect();
    });

    // Report which part of the log is on screen, for the map's bracket.
    $effect(() => {
        const list = root;
        void drawn;
        void entries;
        if (!list) return;
        const visible = new Set<Element>();
        let frame = 0;
        const report = () => {
            frame = 0;
            const times = [...visible].flatMap(element => {
                const data = (element as HTMLElement).dataset;
                return [Number(data.time), Number(data.timeFrom)];
            }).filter(Number.isFinite);
            onRange(times.length ? { from: Math.min(...times), to: Math.max(...times) } : null);
        };
        const observer = new IntersectionObserver(found => {
            for (const item of found) {
                if (item.isIntersecting) visible.add(item.target); else visible.delete(item.target);
            }
            if (!frame) frame = requestAnimationFrame(report);
        }, { root: list.closest('.stor-drawer-body') });
        void tick().then(() => list.querySelectorAll('[data-time]').forEach(element => observer.observe(element)));
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
    function foldTitle(fold: HistoryFold): string {
        const [year, month, date] = fold.key.split('-').map(Number);
        return date
            ? day(new Date(year!, month! - 1, date).getTime())
            : new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(year!, month! - 1, 1));
    }
    function sections(fold: HistoryFold): string {
        const labels = fold.features.map(feature => FEATURES.find(item => item.id === feature)?.page?.label ?? feature);
        return labels.length ? ` · ${labels.join(', ')}` : '';
    }
    function authorText(item: HistoryEntry): string {
        return item.actor && me && item.actor.toLowerCase() !== me.toLowerCase() ? ` · ${item.actor}` : '';
    }
    function statusText(item: HistoryEntry): string {
        return item.status === 'ready' ? '' : item.status === 'attention' ? ' · Needs attention' : ' · Waiting to sync';
    }
    function actionCount(count: number): string {
        return `${formatNumber(count)} ${count === 1 ? 'action' : 'actions'}`;
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

{#snippet markerRow(found: ForkMarker)}
    {#if found.kind === 'start'}
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
    {:else}
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
{/snippet}

{#snippet actionRow(item: HistoryTimelineRow, startsDay: boolean, nested: boolean)}
    {@const Icon = item.feature ? FEATURE_ICONS[item.feature] : IconHistory}
    {#if item.runCount > 1 && !nested}
        {@const key = burstKey(item)}
        {@const open = openFolds.has(`burst:${key}`)}
        {@const members = bursts.get(key)}
        <li data-history-item={item.id} data-time={item.timestamp} data-time-from={item.runFrom}>
            {#if startsDay}<p class="px-2 pb-1.5 pt-4 text-xs font-semibold text-[var(--stor-muted-text)]">{day(item.timestamp)}</p>{/if}
            <div class={open ? 'my-1 rounded-2xl bg-[var(--stor-surface-muted)] shadow-[inset_0_0_0_1px_var(--stor-border)]' : ''}>
                <button type="button"
                    class="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] {open ? '' : 'hover:bg-[var(--stor-surface-hover)]'}"
                    aria-expanded={open} aria-controls={open ? `history-burst-${key}` : undefined}
                    disabled={locked}
                    onclick={() => toggleBurst(item)}>
                    <span class="relative shrink-0">
                        <Icon class="h-5 w-5 text-[var(--stor-muted-text)] {item.copied ? 'opacity-60' : ''}" />
                        <span class="absolute -bottom-1 -right-1.5 rounded-full bg-[var(--stor-surface-muted)] px-1 text-[0.625rem] font-semibold leading-tight text-[var(--stor-ink)] shadow-[inset_0_0_0_1px_var(--stor-border)]" aria-hidden="true">{item.runCount > 99 ? '99+' : item.runCount}</span>
                    </span>
                    <span class="min-w-0 flex-1">
                        <span class="block break-words text-sm text-[var(--stor-ink)] {item.copied ? 'font-medium' : 'font-semibold'}">{item.label}</span>
                        <span class="mt-0.5 block text-xs text-[var(--stor-muted-text)]">{time(item.runFrom) === time(item.timestamp) ? time(item.timestamp) : `${time(item.runFrom)}–${time(item.timestamp)}`} · {actionCount(item.runCount)} in a row{authorText(item)}</span>
                    </span>
                    <IconChevronDown class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)] transition-transform motion-reduce:transition-none {open ? 'rotate-180' : ''}" />
                </button>
                {#if open}
                    <ol id={`history-burst-${key}`} class="px-1 pb-1 sm:pl-6" aria-label={`${actionCount(item.runCount)} in a row`} aria-busy={members?.loading ?? true}>
                        {#each members?.rows ?? [] as member (member.id)}{@render actionRow(member, false, true)}{/each}
                        {#if !members || (members.loading && members.rows.length === 0)}
                            <li role="status" class="px-2 py-2 text-sm text-[var(--stor-muted-text)] motion-safe:animate-pulse">Loading these actions…</li>
                        {:else if members.next !== null}
                            <li class="py-1"><Button variant="ghost" size="sm" class="w-full" disabled={members.loading} onclick={() => loadMoreBurst(key)}>Show more of these</Button></li>
                        {/if}
                    </ol>
                {/if}
            </div>
        </li>
    {:else}
        {@const open = view.action === item.id}
        {#if view.step === 'fork' && open}{@render ghost()}{/if}
        <li data-history-item={item.id} data-time={item.timestamp}>
            {#if startsDay}<p class="px-2 pb-1.5 pt-4 text-xs font-semibold text-[var(--stor-muted-text)]">{day(item.timestamp)}</p>{/if}
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
{/snippet}

{#snippet foldRow(fold: HistoryFold, depth: number)}
    {@const open = openFolds.has(fold.key)}
    {@const Icon = fold.features[0] ? FEATURE_ICONS[fold.features[0] as keyof typeof FEATURE_ICONS] ?? IconHistory : IconHistory}
    <li class={depth === 0 ? 'py-1' : ''} data-history-fold={fold.key} data-time={fold.to} data-time-from={fold.from}>
        <div class={open && depth === 0 ? 'rounded-2xl shadow-[inset_0_0_0_1px_var(--stor-border)]' : ''}>
            <button type="button"
                class="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-[var(--stor-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
                aria-expanded={open} disabled={locked}
                onclick={() => toggleFold(fold.key)}>
                {#if depth === 0}<Icon class="h-5 w-5 shrink-0 text-[var(--stor-muted-text)]" />{:else}<span class="h-5 w-5 shrink-0" aria-hidden="true"></span>{/if}
                <span class="min-w-0 flex-1">
                    <span class="block break-words text-sm text-[var(--stor-ink)] {depth === 0 ? 'font-semibold' : 'font-medium'}">{foldTitle(fold)}</span>
                    <span class="mt-0.5 block text-xs text-[var(--stor-muted-text)]">{actionCount(fold.count)}{sections(fold)}</span>
                </span>
                <IconChevronDown class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)] transition-transform motion-reduce:transition-none {open ? 'rotate-180' : ''}" />
            </button>
            {#if open}
                {#if depth === 0}
                    {@const found = days.get(fold.key)}
                    <ol class="px-1 pb-1" aria-label={`Days in ${foldTitle(fold)}`}>
                        {#if !found}<li role="status" class="px-2 py-2 text-sm text-[var(--stor-muted-text)] motion-safe:animate-pulse">Loading days…</li>{/if}
                        {#each found ?? [] as child (child.key)}{@render foldRow(child, 1)}{/each}
                    </ol>
                {:else}
                    {@const state = dayRows.get(fold.key)}
                    <ol class="pb-1 sm:pl-6" aria-label={`Actions on ${foldTitle(fold)}`} aria-busy={state?.loading ?? true}>
                        {#each state?.rows ?? [] as item (item.id)}{@render actionRow(item, false, false)}{/each}
                        {#if !state || (state.loading && state.rows.length === 0)}
                            <li role="status" class="px-2 py-2 text-sm text-[var(--stor-muted-text)] motion-safe:animate-pulse">Loading this day…</li>
                        {:else if state.next}
                            <li class="py-1"><Button variant="ghost" size="sm" class="w-full" disabled={state.loading} onclick={() => loadMoreDay(fold.key)}>Show more of this day</Button></li>
                        {/if}
                    </ol>
                {/if}
            {/if}
        </div>
    </li>
{/snippet}

<div bind:this={root}>
    {#if currentLogId}{#key currentLogId}<LogMaintenance logId={currentLogId} onHistoryLoaded={() => retry++} onArchivePresence={(present) => archivedHistory = present} />{/key}{/if}
    {#if loading && !loaded}
        <p role="status" class="py-2 text-sm text-[var(--stor-muted-text)] motion-safe:animate-pulse">Loading history…</p>
    {:else if !error && !hasActions}
        <p class="py-4 text-sm text-[var(--stor-muted-text)]">{filtered ? 'No actions match your search.' : archivedHistory ? 'Load the archive to inspect earlier actions.' : 'No activity in this log yet. Your next saved action will show here.'}</p>
        {#if view.search && !searchValues}<Button variant="secondary" size="sm" onclick={() => { searchValues = true; }}>Search saved values</Button>{/if}
    {/if}
    {#if loaded && (hasActions || entries.length > 0)}
        <ol aria-label="Activity in this log" aria-busy={loading}>
            {#if view.step === 'copy' && !filtered}{@render ghost()}{/if}
            {#each entries as item (item.key)}
                {#if item.kind === 'marker'}
                    {@render markerRow(item.marker)}
                {:else if item.kind === 'row'}
                    {@render actionRow(item.row, item.startsDay, false)}
                {:else}
                    {#if item.fold.key === months[0]?.key}
                        <li class="px-2 pb-1.5 pt-5 text-xs font-semibold text-[var(--stor-muted-text)]">Earlier, by month</li>
                    {/if}
                    {@render foldRow(item.fold, 0)}
                {/if}
            {/each}
        </ol>
        {#if next}
            <p bind:this={sentinel} role="status" class="py-3 text-center text-xs text-[var(--stor-muted-text)]">Loading older actions…</p>
        {/if}
    {/if}
    {#if error}<p role="alert" class="text-sm text-[var(--stor-negative)]">{error}</p><Button variant="secondary" onclick={() => retry++}>Retry</Button>{/if}
</div>
