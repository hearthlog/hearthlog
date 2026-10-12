<script lang="ts">
    import type { HistoryRecord } from '@hearthlog/runtime/history/contracts.js';
    import { displayHistoryValue } from '@hearthlog/runtime/history/change-display.js';

    let { change }: { change: HistoryRecord } = $props();
    const verb = $derived(change.kind === 'saved' ? 'Saved values' : change.kind === 'added' ? 'Added' : change.kind === 'removed' ? 'Removed' : 'Changed');
</script>

<section class="py-2" aria-label={change.label}>
    <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h4 class="break-words text-sm font-semibold text-[var(--stor-ink)]">{change.label}</h4>
        <span class="text-xs text-[var(--stor-muted-text)]">{verb}</span>
    </div>
    <dl class="space-y-3">
        {#each change.fields as field (field.key)}
            <div class="grid gap-1">
                <dt class="text-xs font-medium capitalize text-[var(--stor-muted-text)]">{field.label}</dt>
                <dd class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-3 text-sm text-[var(--stor-ink)]">
                    {#if change.kind === 'saved'}
                        <span class="col-span-3 whitespace-pre-wrap break-words">{displayHistoryValue(field.after)}</span>
                    {:else}
                        <span class="whitespace-pre-wrap break-words"><span class="sr-only">Before: </span>{displayHistoryValue(field.before)}</span>
                        <span aria-hidden="true" class="text-[var(--stor-muted-text)]">→</span>
                        <span class="whitespace-pre-wrap break-words font-semibold"><span class="sr-only">After: </span>{displayHistoryValue(field.after)}</span>
                    {/if}
                </dd>
            </div>
        {/each}
    </dl>
</section>
