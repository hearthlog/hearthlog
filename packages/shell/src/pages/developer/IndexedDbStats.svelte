<script lang="ts">
    import { onMount } from 'svelte';
    import Button from '@hearthlog/ui/components/ui/Button.svelte';
    import { formatSqliteBytes } from '@hearthlog/runtime/db/local-statistics.js';
    import { loadIndexedDbStats, type IndexedDbStats } from '@hearthlog/runtime/storage/indexeddb-statistics.js';
    import IconDatabaseOutline from '~icons/mdi/database-outline';
    import IconRefresh from '~icons/mdi/refresh';

    let stats = $state<IndexedDbStats | null>(null);
    let loading = $state(true);
    let error = $state('');

    async function refresh() {
        loading = true;
        error = '';
        try {
            stats = await loadIndexedDbStats();
        } catch (cause) {
            error = cause instanceof Error ? cause.message : 'Could not inspect IndexedDB.';
        } finally {
            loading = false;
        }
    }

    onMount(() => { void refresh(); });
</script>

<section class="stor-panel min-w-0 p-[var(--stor-panel-padding)]" aria-labelledby="indexeddb-stats-heading" data-testid="indexeddb-stats">
    <div class="flex items-start justify-between gap-3">
        <div class="flex items-start gap-3">
            <IconDatabaseOutline class="mt-0.5 h-5 w-5 shrink-0 text-[var(--stor-accent-strong)]" />
            <div>
                <h2 id="indexeddb-stats-heading" class="text-base font-semibold text-[var(--stor-ink)]">IndexedDB files</h2>
            </div>
        </div>
        <Button variant="ghost" size="icon" aria-label="Refresh IndexedDB statistics" onclick={refresh} disabled={loading}>
            <IconRefresh class="h-4 w-4" />
        </Button>
    </div>

    {#if stats}
        <div class="mt-5 flex flex-wrap items-end gap-x-8 gap-y-4">
            <div>
                <p class="text-3xl font-semibold tabular-nums tracking-tight text-[var(--stor-ink)]" data-testid="indexeddb-file-size">{formatSqliteBytes(stats.fileBytes)}</p>
                <p class="mt-1 text-xs text-[var(--stor-muted-text)]">Known file payloads</p>
            </div>
            <div>
                <p class="text-2xl font-semibold tabular-nums text-[var(--stor-ink)]" data-testid="indexeddb-file-count">{stats.fileCount}</p>
                <p class="mt-1 text-xs text-[var(--stor-muted-text)]">Saved files</p>
            </div>
            <div>
                <p class="text-2xl font-semibold tabular-nums text-[var(--stor-ink)]">{stats.databases.length}</p>
                <p class="mt-1 text-xs text-[var(--stor-muted-text)]">Databases</p>
            </div>
        </div>

        <div class="mt-5 divide-y divide-[var(--stor-border)] border-t border-[var(--stor-border)]">
            {#each stats.databases as database (database.name)}
                <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 py-3 text-sm">
                    <div class="min-w-0">
                        <p class="font-medium text-[var(--stor-ink)]">{database.label}</p>
                        <p class="text-xs text-[var(--stor-muted-text)]">
                            {database.name} · {database.stores.map((store) => `${store.name}: ${store.entries}`).join(' · ') || 'No stores'}
                        </p>
                    </div>
                    {#if database.measuresFiles}
                        <p class="tabular-nums text-[var(--stor-ink)]">
                            {database.fileCount} {database.fileCount === 1 ? 'file' : 'files'} · {formatSqliteBytes(database.fileBytes)}
                            {#if database.pdfCount || database.isdocCount}
                                <span class="block text-xs text-[var(--stor-muted-text)]">{database.pdfCount} PDF · {database.isdocCount} ISDOC</span>
                            {/if}
                        </p>
                    {:else}
                        <p class="text-xs text-[var(--stor-muted-text)]">Entries only</p>
                    {/if}
                </div>
            {:else}
                <p class="py-4 text-sm text-[var(--stor-muted-text)]">No IndexedDB databases found.</p>
            {/each}
        </div>

        <p class="mt-3 text-xs text-[var(--stor-muted-text)]">File sizes count stored Blob bytes. IndexedDB metadata, indexes and disk overhead are not included.</p>
        {#if stats.originUsage !== null}
            <p class="mt-2 text-xs text-[var(--stor-muted-text)]" data-testid="origin-storage-usage">
                Browser-reported site storage: {formatSqliteBytes(stats.originUsage)}
                {#if stats.originQuota !== null} · browser quota {formatSqliteBytes(stats.originQuota)}{/if}.
                Includes SQLite, IndexedDB, caches and browser overhead; it cannot be split precisely by database.
            </p>
        {/if}
    {/if}
    {#if loading}<p class="mt-4 text-sm text-[var(--stor-muted-text)]" role="status">Reading IndexedDB statistics…</p>{/if}
    {#if error}<p class="mt-4 text-sm text-[var(--stor-negative)]" role="alert">{error}</p>{/if}
</section>
