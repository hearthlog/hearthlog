<script lang="ts">
    import { getEntitySyncState } from "@hearthlog/runtime/store/entity-sync-state.svelte.js";

    let { entityId }: { entityId: string } = $props();
    const state = $derived(getEntitySyncState(entityId));
</script>

{#if state}
    <span
        class="shrink-0 rounded-full border px-1.5 py-0.5 text-[10.5px] font-semibold {state === 'blocked'
            ? 'border-red-200 bg-red-50 text-red-700'
            : 'border-amber-200 bg-amber-50 text-amber-700'}"
        title={state === "blocked" ? "This local change needs attention" : "Waiting to sync"}
    >
        {state === "blocked" ? "Blocked" : "Pending"}
    </span>
{/if}
