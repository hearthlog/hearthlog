<script lang="ts">
    import { tick } from 'svelte';
    import { refreshAll } from '$app/navigation';
    import Button from '@hearthlog/ui/components/ui/Button.svelte';
    import type { PageResource } from '@hearthlog/runtime/runtime/page-data.svelte.js';
    let { resource }: { resource: PageResource<any> } = $props();
    $effect(() => resource.attach());
    $effect(() => {
        resource.revision;
        if (resource.pending || !resource.usable || resource.error) return;
        const measurement = resource.measurement;
        let cancelled = false;
        let frame = 0;
        void tick().then(() => {
            if (cancelled) return;
            frame = requestAnimationFrame(() => {
                frame = requestAnimationFrame(() => {
                    if (!cancelled) resource.rendered(measurement);
                });
            });
        });
        return () => { cancelled = true; cancelAnimationFrame(frame); };
    });
</script>

{#if resource.error}
    <div class="mx-3 my-2 flex flex-wrap items-center gap-2 rounded-xl bg-[var(--stor-negative-soft)] p-3 text-sm text-[var(--stor-negative)]" role="alert">
        {resource.error instanceof Error ? resource.error.message : 'This page could not load its data.'}
        <Button variant="secondary" size="sm" onclick={() => refreshAll()}>Retry</Button>
    </div>
{:else}
    <span class="sr-only" role="status">{resource.loading ? 'Loading page data' : resource.refreshing ? 'Updating page data' : 'Page data ready'}</span>
    {#if resource.refreshing}
        <div class="pointer-events-none fixed right-3 top-2 z-40 rounded-full bg-[var(--stor-surface-raised)] px-2 py-1 text-xs text-[var(--stor-muted-text)] shadow-[var(--stor-shadow-sm)]" aria-hidden="true">Updating…</div>
    {/if}
{/if}
