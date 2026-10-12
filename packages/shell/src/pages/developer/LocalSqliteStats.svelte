<script lang="ts">
    import DataPlaceholder from '@hearthlog/ui/components/data/DataPlaceholder.svelte';
    import { formatSqliteBytes, type LocalSqliteStats } from '@hearthlog/runtime/db/local-statistics.js';
    import IconDatabaseOutline from '~icons/mdi/database-outline';

    let { stats, loading = false }: { stats: LocalSqliteStats | null; loading?: boolean } = $props();
    const occupiedPercent = $derived(stats && stats.allocatedBytes > 0
        ? Math.round(stats.occupiedBytes / stats.allocatedBytes * 100)
        : 0);
</script>

<section class="stor-panel min-w-0 p-[var(--stor-panel-padding)]" aria-labelledby="local-sqlite-stats-heading" data-testid="local-sqlite-stats">
    <div class="flex items-start gap-3">
        <IconDatabaseOutline class="mt-0.5 h-5 w-5 shrink-0 text-[var(--stor-accent-strong)]" />
        <div>
            <h2 id="local-sqlite-stats-heading" class="text-base font-semibold text-[var(--stor-ink)]">Local SQLite</h2>
        </div>
    </div>

    {#if stats}
        <div class="mt-5 flex flex-wrap items-end gap-x-8 gap-y-4">
            <div>
                <div class="text-3xl font-semibold tabular-nums tracking-tight text-[var(--stor-ink)]" data-testid="sqlite-allocated-size">
                    {formatSqliteBytes(stats.allocatedBytes)}
                </div>
                <p class="mt-1 text-xs text-[var(--stor-muted-text)]">Allocated database pages</p>
            </div>
            <dl class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <div><dt class="text-[var(--stor-muted-text)]">Reusable</dt><dd class="font-semibold tabular-nums text-[var(--stor-ink)]">{formatSqliteBytes(stats.reusableBytes)}</dd></div>
                <div><dt class="text-[var(--stor-muted-text)]">Page size</dt><dd class="font-semibold tabular-nums text-[var(--stor-ink)]" data-testid="sqlite-page-size">{formatSqliteBytes(stats.pageSize)}</dd></div>
            </dl>
        </div>

        <div class="mt-5 h-2 overflow-hidden rounded-full bg-[var(--stor-accent-soft)]" role="img" aria-label={`${occupiedPercent}% occupied pages, ${100 - occupiedPercent}% reusable pages`}>
            <div class="h-full rounded-full bg-[var(--stor-accent)]" style:width={`${occupiedPercent}%`}></div>
        </div>
        <div class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--stor-muted-text)]">
            <span>{formatSqliteBytes(stats.occupiedBytes)} occupied pages</span>
            <span>{formatSqliteBytes(stats.reusableBytes)} reusable pages</span>
        </div>

        <dl class="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--stor-border)] pt-4 text-sm sm:grid-cols-4">
            <div><dt class="text-[var(--stor-muted-text)]">Tables</dt><dd class="font-semibold tabular-nums text-[var(--stor-ink)]">{stats.tableCount}</dd></div>
            <div><dt class="text-[var(--stor-muted-text)]">Indexes</dt><dd class="font-semibold tabular-nums text-[var(--stor-ink)]">{stats.indexCount}</dd></div>
            <div><dt class="text-[var(--stor-muted-text)]">Pages</dt><dd class="font-semibold tabular-nums text-[var(--stor-ink)]">{stats.pageCount}</dd></div>
            <div><dt class="text-[var(--stor-muted-text)]">Schema version</dt><dd class="font-semibold tabular-nums text-[var(--stor-ink)]">{stats.schemaVersion}</dd></div>
        </dl>
        <div class="mt-4 rounded-xl bg-[var(--stor-surface-muted)] px-3 py-2 text-xs text-[var(--stor-muted-text)]">
            Active log: {stats.activeLog ? `${stats.activeLog.eventCount} events · ${stats.activeLog.pendingOperationCount} queued operations` : 'Counts unavailable'}
        </div>
    {:else if loading}
        <div class="mt-5"><DataPlaceholder /></div>
    {:else}
        <p class="mt-5 text-sm text-[var(--stor-muted-text)]">SQLite statistics are unavailable.</p>
    {/if}
</section>
