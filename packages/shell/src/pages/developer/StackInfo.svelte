<script lang="ts">
    import { onMount } from 'svelte';
    import { tenant } from '@hearthlog/contracts/tenant/config';
    import { formatSqliteBytes, type LocalSqliteStats } from '@hearthlog/runtime/db/local-statistics.js';
    import IconLayersOutline from '~icons/mdi/layers-outline';

    let { stats }: { stats: LocalSqliteStats | null } = $props();

    const stack = __STACK_INFO__;
    const mode = import.meta.env.VITE_E2E === '1' ? 'e2e' : import.meta.env.DEV ? 'development' : 'production';
    const buildDate = new Date(__BUILD_TIMESTAMP__).toLocaleString('en-US');
    const ledgerUrl = import.meta.env.VITE_LEDGER_SERVICE_URL || 'same origin';

    let opfs = $state('checking');
    let quota = $state('unknown');
    let serviceWorker = $state('checking');
    let online = $state(true);
    const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

    onMount(() => {
        online = navigator.onLine;
        const sync = () => (online = navigator.onLine);
        window.addEventListener('online', sync);
        window.addEventListener('offline', sync);

        navigator.storage
            ?.getDirectory?.()
            .then(() => (opfs = 'available'))
            .catch(() => (opfs = 'unavailable'));
        if (!navigator.storage?.getDirectory) opfs = 'unavailable';
        navigator.storage
            ?.estimate?.()
            .then(({ usage = 0, quota: limit = 0 }) => {
                quota = `${formatSqliteBytes(usage)} of ${formatSqliteBytes(limit)}`;
            })
            .catch(() => {});
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker
                .getRegistration()
                .then((registration) => {
                    serviceWorker = registration?.active ? 'active' : registration ? 'installing' : 'none';
                })
                .catch(() => (serviceWorker = 'unavailable'));
        } else {
            serviceWorker = 'unsupported';
        }

        return () => {
            window.removeEventListener('online', sync);
            window.removeEventListener('offline', sync);
        };
    });

    const frameworks = $derived([
        ['Svelte', stack.packages.svelte],
        ['SvelteKit', stack.packages['@sveltejs/kit']],
        ['Vite', stack.packages.vite],
        ['TypeScript', stack.packages.typescript],
        ['Tailwind CSS', stack.packages.tailwindcss],
        ['Bits UI', stack.packages['bits-ui']],
        ['TanStack Table', stack.packages['@tanstack/svelte-table']],
        ['TanStack Virtual', stack.packages['@tanstack/svelte-virtual']],
        ['Kysely', stack.packages.kysely],
        ['SQLocal', stack.packages.sqlocal],
        ['date-fns', stack.packages['date-fns']],
        ['Node (build)', stack.node],
    ]);
    const runtime = $derived([
        ['SQLite', stats?.sqliteVersion ?? '…'],
        ['Schema version', stats ? String(stats.schemaVersion) : '…'],
        ['OPFS', opfs],
        ['Storage used', quota],
        ['Service worker', serviceWorker],
        ['Cross-origin isolated', isolated ? 'yes' : 'no'],
        ['Network', online ? 'online' : 'offline'],
    ]);
    const build = $derived([
        ['Commit', stack.commit ? `${stack.commit}${stack.dirty ? ' (dirty)' : ''}` : 'unknown'],
        ['Branch', stack.branch || 'unknown'],
        ['Built', buildDate],
        ['Mode', mode],
    ]);
    const site = $derived([
        ['Tenant', tenant.id],
        ['Ledger app', tenant.ledgerAppName],
        ['Features', String(tenant.features.size)],
        ['Ledger URL', ledgerUrl],
    ]);
    const groups = $derived([
        { title: 'Frameworks', rows: frameworks },
        { title: 'Runtime', rows: runtime },
        { title: 'Build', rows: build },
        { title: 'Site', rows: site },
    ]);
</script>

<section class="stor-panel min-w-0 p-[var(--stor-panel-padding)]" aria-labelledby="stack-info-heading" data-testid="stack-info">
    <div class="flex items-start gap-3">
        <IconLayersOutline class="mt-0.5 h-5 w-5 shrink-0 text-[var(--stor-accent-strong)]" />
        <h2 id="stack-info-heading" class="text-base font-semibold text-[var(--stor-ink)]">Stack</h2>
    </div>
    <div class="mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
        {#each groups as group (group.title)}
            <div class="min-w-0">
                <h3 class="text-xs font-semibold uppercase tracking-wider text-[var(--stor-muted-text)]">{group.title}</h3>
                <dl class="mt-2 space-y-1.5 text-sm">
                    {#each group.rows as [label, value] (label)}
                        <div class="flex items-baseline justify-between gap-3">
                            <dt class="shrink-0 text-[var(--stor-muted-text)]">{label}</dt>
                            <dd class="min-w-0 truncate font-semibold tabular-nums text-[var(--stor-ink)]" title={value}>{value}</dd>
                        </div>
                    {/each}
                </dl>
            </div>
        {/each}
    </div>
</section>
