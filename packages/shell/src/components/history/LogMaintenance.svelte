<script lang="ts">
    import { onMount } from 'svelte';
    import { getLedgerClient } from '@hearthlog/runtime/ledger/client.js';
    import { loadArchivedHistory, baselineVersion } from '@hearthlog/runtime/history/baseline.js';
    import { requireActiveContext } from '@hearthlog/runtime/db/index.js';
    import type { LogMaintenance, CompactionPreview } from '@hearthlog/contracts/history/checkpoint';
    import Button from '@hearthlog/ui/components/ui/Button.svelte';
    import ConfirmDialog from '@hearthlog/ui/components/ConfirmDialog.svelte';
    import CommandOnly from '@hearthlog/ui/components/commands/CommandOnly.svelte';
    import { formatNumber } from '@hearthlog/ui/utils/number-format.js';

    let { logId, onHistoryLoaded, onArchivePresence }: { logId: string; onHistoryLoaded: () => void; onArchivePresence: (present: boolean) => void } = $props();
    let state = $state<LogMaintenance | null>(null);
    let busy = $state(false);
    let error = $state('');
    let confirm = $state(false);
    let preview = $state<CompactionPreview | null>(null);
    let archived = $state(false);
    let alive = true;
    onMount(() => {
        void refresh();
        return () => { alive = false; };
    });
    async function refresh() {
        try {
            state = await getLedgerClient().getLogMaintenance(logId);
            archived = await baselineVersion(await requireActiveContext()) > 0;
            onArchivePresence(archived);
        } catch (cause) { error = message(cause); }
    }
    async function run(kind?: 'snapshot' | 'compact') {
        confirm = false;
        busy = true;
        error = '';
        try {
            if (kind) state = await getLedgerClient().startLogMaintenance(logId, kind, crypto.randomUUID(), kind === 'compact' ? preview?.checkpointId ?? undefined : state?.checkpoint?.id, kind === 'compact' ? preview?.storageGeneration : state?.storageGeneration);
            else if (state?.job) state = await getLedgerClient().stepLogMaintenance(logId, state.job.id);
            while (alive && state?.job && !['complete', 'paused'].includes(state.job.status)) {
                state = await getLedgerClient().stepLogMaintenance(logId, state.job.id);
                if (state.job?.status === 'failed') throw new Error(state.job.error ?? 'Maintenance failed');
            }
        } catch (cause) { error = message(cause); }
        finally { busy = false; }
    }
    async function reviewCompaction() {
        busy = true;
        error = '';
        try { preview = await getLedgerClient().getCompactionPreview(logId); confirm = true; }
        catch (cause) { error = message(cause); }
        finally { busy = false; }
    }
    async function history() {
        busy = true;
        error = '';
        try { await loadArchivedHistory(); archived = false; onArchivePresence(false); onHistoryLoaded(); }
        catch (cause) { error = message(cause); }
        finally { busy = false; }
    }
    function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Log maintenance failed'; }
    const resumable = $derived(state?.job && state.job.status !== 'complete');
</script>

{#if archived}
    <p class="mb-2 text-sm text-[var(--stor-muted-text)]">Earlier actions are archived.
        <Button size="sm" variant="ghost" disabled={busy} onclick={history}>Load archived history</Button>
    </p>
{/if}
{#if state?.available}
    <details class="mb-3 border-b border-[var(--stor-border)] pb-3">
        <summary class="min-h-11 cursor-pointer py-2 text-sm text-[var(--stor-muted-text)]">Log maintenance</summary>
        <div class="flex flex-wrap items-center gap-2 py-2">
            <CommandOnly>
                <Button size="sm" variant="secondary" disabled={busy || Boolean(resumable)} onclick={() => run('snapshot')}>Create snapshot</Button>
                <Button size="sm" variant="secondary" disabled={busy || Boolean(resumable) || !state.checkpoint || state.checkpoint.throughVersion <= state.compactedThroughVersion}
                    onclick={reviewCompaction}>Compact log…</Button>
                {#if resumable}<Button size="sm" disabled={busy} onclick={() => run()}>Resume operation</Button>{/if}
            </CommandOnly>
        </div>
        {#if state.checkpoint}<p class="text-xs text-[var(--stor-muted-text)]">Snapshot through version {formatNumber(state.checkpoint.throughVersion)} · {formatNumber(state.checkpoint.eventCount)} replay facts</p>{/if}
        {#if state.compactedThroughVersion}<p class="text-xs text-[var(--stor-muted-text)]">Archived through version {formatNumber(state.compactedThroughVersion)}. Older history remains available online.</p>{/if}
        {#if state.job}<p role="status" class="mt-1 text-xs text-[var(--stor-muted-text)]">{state.job.kind === 'snapshot' ? 'Snapshot' : 'Compaction'}: {state.job.status} · {formatNumber(state.job.cursor)} processed</p>{/if}
        {#if error}<p role="alert" class="mt-2 text-sm text-[var(--stor-negative)]">{error}</p>{/if}
    </details>
{/if}

<ConfirmDialog show={confirm} title="Compact this log?"
    message={`Archive ${formatNumber(preview?.activePayloadEvents ?? 0)} event payloads (${formatNumber(Math.ceil((preview?.activePayloadBytes ?? 0) / 1024))} KiB) through version ${formatNumber(preview?.throughVersion ?? 0)}. The snapshot uses ${formatNumber(Math.ceil((preview?.snapshotBytes ?? 0) / 1024))} KiB. Current records and log identity stay the same; older history remains available online.`}
    confirmLabel="Archive and compact" onConfirm={() => run('compact')} onCancel={() => confirm = false} />
