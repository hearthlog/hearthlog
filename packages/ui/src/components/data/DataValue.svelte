<script lang="ts">
    import type { Snippet } from 'svelte';
    import { currentPageResource } from '../../state/page-context.js';
    let { children }: { children: Snippet } = $props();
    const resource = currentPageResource();
</script>
{#if resource?.().loading}
    <span class="inline-block h-[0.85em] min-w-[3ch] rounded bg-stone-200/70 align-baseline tabular-nums motion-safe:animate-pulse" aria-label="Loading value"><span class="sr-only">Loading</span>&nbsp;</span>
{:else}
    {@render children()}
{/if}
