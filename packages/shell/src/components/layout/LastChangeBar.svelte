<script lang="ts">
    import { untrack } from "svelte";
    import { page } from "$app/state";
    import { navigateHistory } from "@hearthlog/runtime/history/navigation.js";
    import IconCheck from "~icons/mdi/check-circle-outline";
    import IconUndo from "~icons/mdi/undo-variant";
    import IconClose from "~icons/mdi/close";
    import { lastChange } from "./last-change.svelte.js";

    let { collapsed, logId }: {
        /** The rail is in place, so the bar centres over the narrower offset. */
        collapsed: boolean;
        logId: string | null;
    } = $props();

    $effect(() => lastChange.start());

    // A change belongs to its log; switching logs takes it away.
    $effect(() => {
        void logId;
        untrack(() => lastChange.dismiss());
    });

    // It stays while you work on the same page and leaves after two moves to other pages.
    let moves = 0;
    $effect(() => {
        void lastChange.current?.batchId;
        moves = 0;
    });
    $effect(() => {
        void page.url.pathname;
        untrack(() => {
            if (lastChange.current && ++moves >= 2) lastChange.dismiss();
        });
    });

    const change = $derived(lastChange.current);
    const message = $derived.by(() => {
        if (!change) return "";
        if (change.state === "undoing") return "Undoing…";
        if (change.state === "undone") return `Undid “${change.label}”.`;
        if (change.state === "failed") return "Could not undo this change. Open History to review it.";
        return `${change.label}.`;
    });

    function openHistory(): void {
        const url = new URL(window.location.href);
        url.searchParams.set("logPanel", "activity");
        navigateHistory(url);
        lastChange.dismiss();
    }
</script>

{#if change}
    <!-- From 1024px toasts stack at the bottom right, so the bar starts at the panel's left and stops short of them. -->
    <div class="pointer-events-none fixed bottom-6 right-3 z-[var(--stor-layer-toast)] hidden justify-center md:flex lg:right-[calc(24rem+40px)] lg:justify-start lg:pl-6 {collapsed ? 'md:left-20' : 'md:left-20 lg:left-[var(--stor-sidebar-width)]'}">
        <div class="stor-last-change pointer-events-auto" role="status" data-state={change.state}>
            {#if change.state === "undone"}
                <IconUndo class="h-[18px] w-[18px] shrink-0 opacity-70" aria-hidden="true" />
            {:else}
                <IconCheck class="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
            {/if}
            <span class="min-w-0 flex-1 truncate">{message}</span>
            {#if change.reversal && (change.state === "saved" || change.state === "undoing")}
                <button type="button" class="stor-last-change-action" disabled={change.state === "undoing"} onclick={() => void lastChange.undo()}>Undo</button>
            {/if}
            <button type="button" class="stor-last-change-action stor-last-change-quiet" onclick={openHistory}>History</button>
            <button type="button" class="stor-last-change-close" aria-label="Dismiss" onclick={() => lastChange.dismiss()}>
                <IconClose class="h-4 w-4" aria-hidden="true" />
            </button>
        </div>
    </div>
{/if}
