<script lang="ts">
    import { tick, untrack } from 'svelte';
    import Button from '@hearthlog/ui/components/ui/Button.svelte';
    import Input from '@hearthlog/ui/components/ui/Input.svelte';
    import { queryDatabase } from '@hearthlog/runtime/db/read-repositories.js';
    import type { ForkReview, HistoryEntry } from '@hearthlog/runtime/history/contracts.js';
    import { events } from '@hearthlog/runtime/store/events.svelte.js';
    import { syncStatus } from '@hearthlog/runtime/store/sync.svelte.js';
    import { notify } from '@hearthlog/ui/state/notifications.svelte.js';
    import { getLedgerClient, type LogSummary } from '@hearthlog/runtime/ledger/index.js';
    import { forkAndActivateLog } from '@hearthlog/runtime/log-management.js';
    import { suggestForkName } from '@hearthlog/runtime/history/lineage.js';
    import { formatNumber } from '@hearthlog/ui/utils/number-format.js';

    let {
        step,
        actionId,
        currentLogId,
        currentLogName,
        logs,
        onCancel,
        onSwitch,
        onDone,
        onBusyChange,
    }: {
        /** `fork` starts after the opened action; `copy` after the latest one. */
        step: 'fork' | 'copy';
        actionId: string | null;
        currentLogId: string | null;
        currentLogName: string | null;
        logs: LogSummary[];
        onCancel: () => void;
        onSwitch: (logId: string) => Promise<void>;
        onDone: () => void;
        onBusyChange: (busy: boolean) => void;
    } = $props();

    let entry = $state<HistoryEntry | null>(null);
    let loading = $state(true);
    let name = $state('');
    let namedFor = '';
    let review = $state<ForkReview | null>(null);
    let sourceHead = $state<number | null>(null);
    let reviewLoading = $state(false);
    let reviewRetry = $state(0);
    let busy = $state(false);
    let progress = $state('');
    let error = $state('');
    let request: { key: string; id: string } | null = null;

    const unavailable = $derived(!syncStatus.isOnline ? 'Connect to create a log. You can still read history offline.'
        : syncStatus.pendingUploads > 0 ? 'Sync your changes before creating a log.' : '');

    // The action the new log ends with.
    $effect(() => {
        const selected = step === 'copy' ? null : actionId;
        const scope = currentLogId;
        void events.updatedAt;
        if (!scope || untrack(() => busy)) return;
        let cancelled = false;
        loading = true;
        void queryDatabase(r => selected ? r.history.get({ id: selected }) : r.history.latest())
            .then(found => { if (!cancelled) entry = found; })
            .catch(cause => { if (!cancelled) error = message(cause); })
            .finally(() => { if (!cancelled) loading = false; });
        return () => { cancelled = true; };
    });

    $effect(() => {
        const target = entry;
        if (!target || namedFor === `${step}:${target.id}`) return;
        namedFor = `${step}:${target.id}`;
        name = suggestForkName(untrack(() => logs), currentLogId, target.timestamp);
        // Selected, so typing replaces the suggestion.
        void tick().then(() => (document.getElementById('fork-log-name') as HTMLInputElement | null)?.select());
    });

    $effect(() => {
        const target = entry?.status === 'ready' ? entry.version : null;
        const scope = currentLogId;
        const online = syncStatus.isOnline;
        void reviewRetry;
        void events.updatedAt;
        if (!scope || target === null || !online || untrack(() => busy)) return;
        let cancelled = false;
        reviewLoading = true;
        review = null;
        sourceHead = null;
        error = '';
        void Promise.all([
            queryDatabase(r => r.history.review(target)),
            getLedgerClient().getLog(scope),
        ]).then(([impact, log]) => {
            if (cancelled) return;
            review = impact;
            if (impact.localHead !== log.headVersion) error = 'This log has newer changes to download. Sync, then check again.';
            else sourceHead = log.headVersion;
        }).catch(cause => { if (!cancelled) error = message(cause); })
            .finally(() => { if (!cancelled) reviewLoading = false; });
        return () => { cancelled = true; };
    });

    function message(cause: unknown): string {
        return cause instanceof Error ? cause.message : 'Could not check this starting point. Try again.';
    }

    function plural(count: number, one: string, many: string): string {
        return `${formatNumber(count)} ${count === 1 ? one : many}`;
    }

    async function create(): Promise<void> {
        const target = entry;
        if (!target || target.version === null || sourceHead === null || !currentLogId || unavailable || busy) return;
        const source = currentLogId;
        const key = JSON.stringify([source, target.version, sourceHead, name.trim()]);
        if (request?.key !== key) request = { key, id: crypto.randomUUID() };
        busy = true;
        onBusyChange(true);
        error = '';
        try {
            const fork = await forkAndActivateLog({ name, targetVersion: target.version, expectedSourceHeadVersion: sourceHead,
                requestId: request.id, onProgress: value => { progress = value; } });
            onDone();
            notify.success(`Opened ${fork.name}`, { label: 'Open original log', run: async () => {
                try { await onSwitch(source); } catch (cause) { notify.error(message(cause)); }
            } });
        } catch (cause) {
            error = message(cause);
        } finally {
            busy = false;
            progress = '';
            onBusyChange(false);
        }
    }
</script>

<form class="w-full space-y-2.5" onsubmit={(event) => { event.preventDefault(); void create(); }}>
    {#if loading && !entry}
        <p role="status" class="text-sm text-[var(--stor-muted-text)] motion-safe:animate-pulse">Finding the starting point…</p>
    {:else if !entry}
        <p class="text-sm text-[var(--stor-muted-text)]">{step === 'copy' ? 'Nothing to copy yet. Save something in this log first.' : 'This action is not in this log any more.'}</p>
        <div class="flex justify-end"><Button variant="ghost" onclick={onCancel}>Cancel</Button></div>
    {:else}
        <fieldset disabled={busy} class="space-y-2.5">
            <div>
                <label for="fork-log-name" class="mb-1.5 block text-sm font-semibold text-[var(--stor-ink)]">New log name</label>
                <Input id="fork-log-name" bind:value={name} placeholder="Name this log" autocomplete="off" />
            </div>
            <p class="text-xs text-[var(--stor-muted-text)]" role="status">
                {#if entry.status !== 'ready'}
                    {entry.reason ?? 'This action is not synced yet.'}
                {:else if reviewLoading || !review}
                    Checking this starting point…
                {:else}
                    <b class="font-semibold text-[var(--stor-ink)]">Keeps {plural(review.keptActions, 'action', 'actions')}.</b>
                    {review.laterActions === 0 ? '' : `Leaves out ${plural(review.laterActions, 'newer one', 'newer ones')}.`}
                    {currentLogName ?? 'This log'} stays as it is.
                {/if}
            </p>
        </fieldset>
        {#if unavailable}<p class="text-xs text-[var(--stor-muted-text)]">{unavailable}</p>{/if}
        {#if progress}<p role="status" class="text-sm text-[var(--stor-muted-text)]">{progress}</p>{/if}
        {#if error}
            <p role="alert" class="text-sm text-[var(--stor-negative)]">{error}</p>
        {/if}
        <div class="flex flex-wrap justify-end gap-2">
            {#if error && !busy}<Button variant="secondary" onclick={() => reviewRetry++}>Check again</Button>{/if}
            <Button variant="ghost" disabled={busy} onclick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={busy || reviewLoading || sourceHead === null || Boolean(unavailable) || !name.trim() || entry.status !== 'ready'}>
                {busy ? 'Creating and switching…' : 'Create and switch'}
            </Button>
        </div>
    {/if}
</form>
