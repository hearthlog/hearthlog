<script lang="ts">
    import Badge from "@hearthlog/ui/components/ui/Badge.svelte";

    /**
     * Where a filled value came from. A model's pick wears the blue Suggested
     * tag; the history rule shows only its plain reason, with no AI mark.
     */
    let { kind, reason = "" }: { kind: "ai" | "history"; reason?: string } = $props();
</script>

{#if kind === "ai"}
    <Badge variant="info" title="Picked by AI. Saving it is your choice.">Suggested</Badge>
{:else if reason}
    <span class="text-[11px] leading-4 text-[var(--stor-muted-text)]">{reason}</span>
{/if}
