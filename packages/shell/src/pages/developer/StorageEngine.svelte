<script lang="ts">
    import { onMount } from 'svelte';
    import Badge from '@hearthlog/ui/components/ui/Badge.svelte';
    import Button from '@hearthlog/ui/components/ui/Button.svelte';
    import DataPlaceholder from '@hearthlog/ui/components/data/DataPlaceholder.svelte';
    import { formatSqliteBytes } from '@hearthlog/runtime/db/local-statistics.js';
    import { isSavedStorage, loadStorageStatus, requestPersistentStorage, type StorageStatus } from '@hearthlog/runtime/db/storage-status.js';
    import IconDatabaseCheckOutline from '~icons/mdi/database-check-outline';
    import IconRefresh from '~icons/mdi/refresh';
    import IconCheck from '~icons/mdi/check';
    import IconClose from '~icons/mdi/close';

    let status = $state<StorageStatus | null>(null);
    let loading = $state(true);
    let error = $state('');
    let requesting = $state(false);

    async function refresh() {
        loading = true;
        error = '';
        try {
            status = await loadStorageStatus();
        } catch (cause) {
            error = cause instanceof Error ? cause.message : 'Could not inspect local storage.';
        } finally {
            loading = false;
        }
    }

    async function keepStorage() {
        requesting = true;
        try {
            await requestPersistentStorage();
            await refresh();
        } finally {
            requesting = false;
        }
    }

    onMount(() => { void refresh(); });

    const saved = $derived(isSavedStorage(status?.storageType ?? null));
    const badge = $derived.by((): { variant: 'success' | 'danger' | 'warning' | 'default'; label: string } => {
        if (!status?.storageType) return { variant: 'default', label: 'Unknown' };
        if (saved) return { variant: 'success', label: 'On disk' };
        if (status.storageType === 'memory') return { variant: 'danger', label: 'Memory · not saved' };
        return { variant: 'warning', label: 'Browser storage' };
    });
    const description = $derived.by(() => {
        switch (status?.storageType) {
            case 'opfs-wl': return 'Saved in the origin private file system, locked with Web Locks.';
            case 'opfs': return 'Saved in the origin private file system.';
            case 'memory': return 'Running in memory: SQLite could not open the database file, so nothing is saved and the next launch downloads and rebuilds everything.';
            case 'local':
            case 'session': return 'Kept in browser storage (test build).';
            default: return 'SQLite did not report where the database is.';
        }
    });

    function formatWhen(time: number): string {
        return new Date(time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }
</script>

<section class="stor-panel min-w-0 p-[var(--stor-panel-padding)]" aria-labelledby="storage-engine-heading" data-testid="storage-engine">
    <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex items-start gap-3">
            <IconDatabaseCheckOutline class="mt-0.5 h-5 w-5 shrink-0 text-[var(--stor-accent-strong)]" />
            <h2 id="storage-engine-heading" class="text-base font-semibold text-[var(--stor-ink)]">Storage engine</h2>
        </div>
        <div class="flex items-center gap-2">
            {#if status}<Badge variant={badge.variant} data-testid="storage-engine-badge">{badge.label}</Badge>{/if}
            <Button variant="ghost" size="icon" aria-label="Refresh storage engine" onclick={refresh} disabled={loading}>
                <IconRefresh class="h-4 w-4" />
            </Button>
        </div>
    </div>

    {#if status}
        <div class="mt-5">
            <p class="text-[11px] font-semibold uppercase tracking-wider text-[var(--stor-muted-text)]">Database</p>
            <p class={['mt-1 text-3xl font-semibold tracking-tight', status.storageType === 'memory' ? 'text-[var(--stor-negative)]' : 'text-[var(--stor-ink)]']} data-testid="storage-engine-type">{status.storageType ?? 'unknown'}</p>
            <p class="mt-1 max-w-2xl text-sm text-[var(--stor-muted-text)]">{description}</p>
            <p class="mt-1 text-sm text-[var(--stor-muted-text)]">Requested <span class="font-semibold text-[var(--stor-ink)]">{status.requestedVfs}</span> because this is {status.vfsReason}.</p>
        </div>

        <dl class="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--stor-border)] pt-4 text-sm sm:grid-cols-4">
            <div class="min-w-0">
                <dt class="text-[var(--stor-muted-text)]">File on disk</dt>
                <dd class="font-semibold tabular-nums text-[var(--stor-ink)]">{status.file ? formatSqliteBytes(status.file.size) : (status.fileError ?? '—')}</dd>
            </div>
            <div class="min-w-0">
                <dt class="text-[var(--stor-muted-text)]">SQLite says</dt>
                <dd class="font-semibold tabular-nums text-[var(--stor-ink)]">{status.sqliteBytes === null ? '—' : formatSqliteBytes(status.sqliteBytes)}</dd>
            </div>
            <div class="min-w-0">
                <dt class="text-[var(--stor-muted-text)]">File last written</dt>
                <dd class="font-semibold tabular-nums text-[var(--stor-ink)]">{status.file ? formatWhen(status.file.lastModified) : '—'}</dd>
            </div>
            <div class="min-w-0">
                <dt class="text-[var(--stor-muted-text)]">Persistent storage</dt>
                <dd class="font-semibold text-[var(--stor-ink)]">
                    {#if status.persisted === true}<span class="text-[var(--stor-positive)]">Granted</span>
                    {:else if status.persisted === false}<span class="text-[var(--stor-warning)]">Not granted</span>
                    {:else}Unknown{/if}
                </dd>
            </div>
        </dl>
        {#if status.storageType === 'memory' && status.file}
            <p class="mt-3 text-xs text-[var(--stor-muted-text)]">The database file is still in OPFS ({formatSqliteBytes(status.file.size)}, last written {formatWhen(status.file.lastModified)}); this launch could not open it.</p>
        {/if}

        <ul class="mt-4 flex flex-wrap gap-2" aria-label="Browser requirements">
            {#each status.checks as check (check.label)}
                <li class="inline-flex h-7 items-center gap-1.5 rounded-lg bg-[var(--stor-surface-muted)] px-2.5 text-xs text-[var(--stor-ink)]">
                    {#if check.ok}<IconCheck class="h-3.5 w-3.5 text-[var(--stor-positive)]" aria-label="available" />{:else}<IconClose class="h-3.5 w-3.5 text-[var(--stor-negative)]" aria-label="missing" />{/if}
                    {check.label}
                </li>
            {/each}
            {#if status.quota}
                <li class="inline-flex h-7 items-center rounded-lg bg-[var(--stor-surface-muted)] px-2.5 text-xs text-[var(--stor-ink)]">Quota {formatSqliteBytes(status.quota.usage)} of {formatSqliteBytes(status.quota.quota)}</li>
            {/if}
        </ul>

        {#if status.persisted === false}
            <div class="mt-4">
                <Button variant="secondary" size="sm" onclick={keepStorage} disabled={requesting}>Keep storage</Button>
            </div>
        {/if}
    {:else if loading}
        <div class="mt-5"><DataPlaceholder /></div>
    {:else}
        <p class="mt-5 text-sm text-[var(--stor-muted-text)]">{error || 'Storage details are unavailable.'}</p>
    {/if}
</section>
