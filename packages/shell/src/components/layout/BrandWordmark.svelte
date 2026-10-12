<script lang="ts">
    import { wordmarkParts } from "@hearthlog/contracts/tenant/brand";

    let { title }: { title: string } = $props();
    const parts = $derived(wordmarkParts(title));
</script>

{#if parts}
    <span class="stor-wordmark" role="img" aria-label={title}>{parts.before}<span class="stor-mark"></span>{parts.after}</span>
{:else}
    {title}
{/if}
