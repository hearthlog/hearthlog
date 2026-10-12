<script lang="ts">
    import { untrack, type Snippet } from "svelte";
    import { currentPageResource } from "../../state/page-context.js";
    import { commandAvailability } from "../../state/commands.js";

    let {
        children,
        onUnavailable,
    }: {
        children?: Snippet;
        onUnavailable?: () => void;
    } = $props();

    const resource = currentPageResource();
    const available = $derived($commandAvailability.available && !resource?.().loading);

    $effect(() => {
        if (!available) untrack(() => onUnavailable?.());
    });
</script>

{#if children}
    <fieldset class="contents" disabled={!available} inert={!available} aria-disabled={!available}>
        {@render children()}
    </fieldset>
{/if}
