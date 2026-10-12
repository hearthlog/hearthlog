<script lang="ts">
    import type { Snippet } from "svelte";
    import { currentPageResource } from "../../state/page-context.js";
    const resource = currentPageResource();
    import { commandAvailability } from "../../state/commands.js";

    let {
        children,
        class: className = "contents",
    }: {
        children: Snippet;
        class?: string;
    } = $props();
</script>

<fieldset disabled={!$commandAvailability.available || resource?.().loading} class={className}>
    {@render children()}
</fieldset>
