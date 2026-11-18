<script lang="ts">
    import { onMount } from 'svelte';
    import Badge from '@hearthlog/ui/components/ui/Badge.svelte';
    import Button from '@hearthlog/ui/components/ui/Button.svelte';
    import { notify } from '@hearthlog/ui/state/notifications.svelte.js';
    import { launch, readLaunchHistory, type LaunchPath, type LaunchRecord } from '@hearthlog/runtime/store/launch-history.js';
    import IconHistory from '~icons/mdi/history';
    import IconRefresh from '~icons/mdi/refresh';
    import IconContentCopy from '~icons/mdi/content-copy';
    import IconChevronDown from '~icons/mdi/chevron-down';

    let history = $state<LaunchRecord[]>([]);
    let open = $state<string | null>(null);

    function refresh() {
        history = readLaunchHistory();
    }

    onMount(() => {
        refresh();
        // This launch's record fills in while its first download runs.
        const timer = setInterval(() => { if (!launch.finished) refresh(); else { refresh(); clearInterval(timer); } }, 2000);
        return () => clearInterval(timer);
    });

    const PATHS: Record<LaunchPath, { label: string; variant: 'success' | 'warning' | 'danger' }> = {
        opened: { label: 'Opened as-is', variant: 'success' },
        'schema-rebuild': { label: 'Schema rebuild', variant: 'warning' },
        'snapshot-install': { label: 'Snapshot install', variant: 'warning' },
        'full-download': { label: 'Full download', variant: 'danger' },
    };

    // Fixed status tones, never the site accent (which may be red, like a rebuild).
    const STEP_COLORS: Array<[RegExp, string]> = [
        [/^Open/, 'color-mix(in srgb, var(--stor-info) 55%, var(--stor-surface))'],
        [/^Startup/, 'var(--stor-border-strong, #cecac3)'],
        [/^Download/, 'var(--stor-info)'],
        [/rebuild|Snapshot/i, 'var(--stor-warning)'],
    ];
    function stepColor(name: string): string {
        return STEP_COLORS.find(([pattern]) => pattern.test(name))?.[1] ?? 'var(--stor-muted-text)';
    }

    /** Steps on one scale from page start to the record's end, for the bar and the detail list. */
    function bars(record: LaunchRecord) {
        const end = Math.max(record.readyMs ?? 0, ...record.steps.map((step) => step.startMs + step.ms), 1);
        return record.steps.map((step) => ({
            ...step,
            left: `${(step.startMs / end) * 100}%`,
            width: `${Math.max(0.8, (step.ms / end) * 100)}%`,
            color: stepColor(step.name),
        }));
    }

    function formatMs(ms: number | null): string {
        if (ms === null) return '—';
        return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
    }

    function formatWhen(iso: string): string {
        return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    }

    async function copyHistory() {
        try {
            await navigator.clipboard.writeText(JSON.stringify(readLaunchHistory(), null, 2));
            notify.success('Launch history copied');
        } catch {
            notify.error('Could not copy the launch history');
        }
    }

    const memoryStreak = $derived.by(() => {
        let count = 0;
        for (const record of history) {
            if (record.storage !== 'memory') break;
            count += 1;
        }
        return count;
    });
</script>

<section class="stor-panel min-w-0 overflow-hidden" aria-labelledby="launch-history-heading" data-testid="launch-history">
    <div class="flex flex-wrap items-start justify-between gap-3 p-[var(--stor-panel-padding)] pb-3">
        <div class="flex items-start gap-3">
            <IconHistory class="mt-0.5 h-5 w-5 shrink-0 text-[var(--stor-accent-strong)]" />
            <div>
                <h2 id="launch-history-heading" class="text-base font-semibold text-[var(--stor-ink)]">Launch history</h2>
                <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">The last {history.length} cold starts on this device, kept in browser storage outside SQLite.</p>
            </div>
        </div>
        <div class="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Copy launch history as JSON" onclick={copyHistory} disabled={history.length === 0}>
                <IconContentCopy class="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Refresh launch history" onclick={refresh}>
                <IconRefresh class="h-4 w-4" />
            </Button>
        </div>
    </div>

    {#if memoryStreak >= 2}
        <p class="mx-[var(--stor-panel-padding)] mb-3 rounded-xl bg-[var(--stor-warning-soft)] px-3 py-2 text-sm text-[var(--stor-ink)]">
            <span class="font-semibold">The last {memoryStreak} launches ran in memory.</span> The database isn’t surviving a restart on this device.
        </p>
    {/if}

    {#if history.length === 0}
        <p class="px-[var(--stor-panel-padding)] pb-[var(--stor-panel-padding)] text-sm text-[var(--stor-muted-text)]">No launches recorded yet. The next launch of this build starts the history.</p>
    {:else}
        <div class="overflow-x-auto">
            <table class="w-full min-w-[760px] border-collapse text-sm tabular-nums">
                <thead>
                    <tr class="border-y border-[var(--stor-border)] text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--stor-muted-text)]">
                        <th class="px-[var(--stor-panel-padding)] py-2 font-semibold">When</th>
                        <th class="px-3 py-2 font-semibold">Storage</th>
                        <th class="px-3 py-2 font-semibold">Start path</th>
                        <th class="px-3 py-2 font-semibold">Log at start</th>
                        <th class="px-3 py-2 font-semibold">Downloaded</th>
                        <th class="px-3 py-2 font-semibold">Ready in</th>
                        <th class="w-[22%] px-3 py-2 font-semibold">Where the time went</th>
                        <th class="px-3 py-2"><span class="sr-only">Details</span></th>
                    </tr>
                </thead>
                <tbody>
                    {#each history as record (record.id)}
                        {@const path = PATHS[record.path] ?? PATHS.opened}
                        {@const expanded = open === record.id}
                        <tr class="border-b border-[var(--stor-border)] align-middle">
                            <td class="whitespace-nowrap px-[var(--stor-panel-padding)] py-2.5">
                                <span class="font-semibold text-[var(--stor-ink)]">{formatWhen(record.startedAt)}</span>
                                {#if record.id === launch.record.id}<span class="ml-1 text-xs text-[var(--stor-accent-strong)]">this launch</span>{/if}
                                {#if record.build}<span class="block font-mono text-[11px] text-[var(--stor-muted-text)]">{record.build.slice(0, 12)}</span>{/if}
                            </td>
                            <td class={['whitespace-nowrap px-3 py-2.5', record.storage === 'memory' ? 'font-semibold text-[var(--stor-negative)]' : 'text-[var(--stor-ink)]']}>{record.storage ?? '—'}</td>
                            <td class="whitespace-nowrap px-3 py-2.5">
                                <Badge variant={path.variant} dot>{path.label}</Badge>
                                {#if !record.finished}<span class="ml-1 text-xs text-[var(--stor-muted-text)]">unfinished</span>{/if}
                            </td>
                            <td class="px-3 py-2.5 text-[var(--stor-ink)]">{record.logVersionAtStart === null ? '—' : `v${record.logVersionAtStart.toLocaleString('en-US')}`}</td>
                            <td class="px-3 py-2.5 text-[var(--stor-ink)]">{record.downloaded.toLocaleString('en-US')}</td>
                            <td class="px-3 py-2.5 font-semibold text-[var(--stor-ink)]">{formatMs(record.readyMs)}</td>
                            <td class="px-3 py-2.5">
                                <div class="relative h-2 overflow-hidden rounded-full bg-[var(--stor-surface-muted)]" role="img" aria-label={record.steps.map((step) => `${step.name} ${formatMs(step.ms)}`).join(', ') || 'No steps recorded'}>
                                    {#each bars(record) as bar (bar.name + bar.startMs)}
                                        <span class="absolute inset-y-0 rounded-full" style:left={bar.left} style:width={bar.width} style:background={bar.color}></span>
                                    {/each}
                                </div>
                            </td>
                            <td class="px-3 py-1.5 text-right">
                                <Button variant="ghost" size="icon" aria-expanded={expanded} aria-label={expanded ? 'Hide launch details' : 'Show launch details'} onclick={() => (open = expanded ? null : record.id)}>
                                    <IconChevronDown class={['h-4 w-4 transition-transform', expanded && 'rotate-180']} />
                                </Button>
                            </td>
                        </tr>
                        {#if expanded}
                            <tr class="border-b border-[var(--stor-border)] bg-[var(--stor-surface-muted)]">
                                <td colspan="8" class="px-[var(--stor-panel-padding)] py-4">
                                    <div class="grid gap-4 lg:grid-cols-2">
                                        <div>
                                            <p class="text-[11px] font-semibold uppercase tracking-wider text-[var(--stor-muted-text)]">Why this path</p>
                                            <ul class="mt-1.5 list-disc space-y-1 pl-4 text-sm text-[var(--stor-ink)]">
                                                {#each record.reasons as reason, index (index)}<li>{reason}</li>{:else}<li class="text-[var(--stor-muted-text)]">{record.finished ? 'No reason recorded.' : 'Still starting, or the tab closed before its first sync.'}</li>{/each}
                                            </ul>
                                            <p class="mt-2 text-xs text-[var(--stor-muted-text)]">Requested {record.requestedVfs ?? '—'} · storage {record.storage ?? '—'}</p>
                                        </div>
                                        <div>
                                            <p class="text-[11px] font-semibold uppercase tracking-wider text-[var(--stor-muted-text)]">Steps (from page start)</p>
                                            <ul class="mt-1.5 space-y-1.5">
                                                {#each bars(record) as bar (bar.name + bar.startMs)}
                                                    <li class="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_4.5rem] items-center gap-3 text-sm">
                                                        <span class="truncate text-[var(--stor-ink)]">{bar.name}</span>
                                                        <span class="relative h-2 overflow-hidden rounded-full bg-[var(--stor-surface)]"><span class="absolute inset-y-0 rounded-full" style:left={bar.left} style:width={bar.width} style:background={bar.color}></span></span>
                                                        <span class="text-right text-[var(--stor-muted-text)]">{formatMs(bar.ms)}</span>
                                                    </li>
                                                {:else}
                                                    <li class="text-sm text-[var(--stor-muted-text)]">No steps recorded.</li>
                                                {/each}
                                            </ul>
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        {/if}
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}
</section>
