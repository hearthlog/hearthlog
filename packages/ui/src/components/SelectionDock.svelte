<script lang="ts" module>
    /** A question the dock asks in place of the selection, such as confirming a delete. */
    export interface SelectionDockConfirm {
        title: string;
        detail?: string;
        /** The confirming button's label, for example "Delete 3". */
        action: string;
        onConfirm: () => void;
    }
</script>

<script lang="ts">
    import type { Snippet } from "svelte";
    import { untrack } from "svelte";
    import IconClose from "~icons/mdi/close";

    /**
     * The glass tray at the bottom of a list while rows are selected: the count, what the selection covers, its
     * figures and the batch actions, so the list itself stays free of selection chrome. From 1024px it sticks to the
     * bottom of the list's scroller; below that it floats above the tab bar and the page action. Delete-style actions
     * confirm inside the dock (`confirm`), and a change to the selection withdraws the question.
     *
     * Action buttons in `actions` take `.stor-dock-action` (plus `-primary` for the main one or `-danger`); figures in
     * `summary` take `.stor-dock-figure`; a scope switch in `controls` takes `.stor-dock-switch` with `aria-pressed`.
     */
    let {
        count,
        label,
        scope,
        controls,
        summary,
        actions,
        allSelected = false,
        confirm = null,
        onCancelConfirm,
        onClear,
        class: className = "",
    }: {
        /** How many rows are selected. */
        count: number;
        /** What is selected, in words, for example "3 invoices selected". */
        label: string;
        /** One quiet line under the label: what the selection covers. */
        scope?: Snippet;
        /** A control beside the label, such as switching between this page and everything matching. */
        controls?: Snippet;
        /** Figures for the selection, such as totals. */
        summary?: Snippet;
        /** The batch actions. */
        actions?: Snippet;
        /** The selection reaches past the rows on screen: the count draws as a solid mark instead of the droplet. */
        allSelected?: boolean;
        confirm?: SelectionDockConfirm | null;
        onCancelConfirm?: () => void;
        onClear: () => void;
        class?: string;
    } = $props();

    let shownCount = untrack(() => count);
    $effect(() => {
        if (count === shownCount) return;
        shownCount = count;
        untrack(() => {
            if (confirm) onCancelConfirm?.();
        });
    });
</script>

<div class={["stor-dock-place", className]}>
    <div class="stor-dock stor-glass-strong" role="region" aria-label={label}>
        {#if confirm}
            <div class="stor-dock-ask" role="alertdialog" aria-label={confirm.title}>
                <strong>{confirm.title}</strong>
                {#if confirm.detail}<span>{confirm.detail}</span>{/if}
            </div>
            <span class="stor-dock-spacer" aria-hidden="true"></span>
            <div class="stor-dock-actions">
                <!-- svelte-ignore a11y_autofocus -->
                <button type="button" class="stor-dock-action" autofocus onclick={() => onCancelConfirm?.()}>Cancel</button>
                <button type="button" class="stor-dock-action stor-dock-action-confirm" onclick={confirm.onConfirm}>{confirm.action}</button>
            </div>
        {:else}
            <div class="stor-dock-what">
                <span class={["stor-dock-count", allSelected ? "stor-dock-count-all" : "stor-droplet"]}>{count}</span>
                <span class="stor-dock-label" role="status" aria-live="polite">
                    <strong>{label}</strong>
                    {#if scope}<span>{@render scope()}</span>{/if}
                </span>
            </div>
            {#if controls}{@render controls()}{/if}
            {#if summary}<div class="stor-dock-summary">{@render summary()}</div>{/if}
            <span class="stor-dock-spacer" aria-hidden="true"></span>
            <div class="stor-dock-actions">
                {@render actions?.()}
                <button type="button" class="stor-dock-action stor-dock-clear" onclick={onClear} aria-label="Clear selection">
                    <IconClose class="h-4 w-4" />
                    <kbd class="stor-kbd" aria-hidden="true">Esc</kbd>
                </button>
            </div>
        {/if}
    </div>
</div>
