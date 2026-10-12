<script lang="ts">
    import type { Snippet } from "svelte";
    import Modal from "@hearthlog/ui/components/Modal.svelte";
    import { phoneHeader } from "@hearthlog/runtime/runtime/phone-header.svelte.js";

    /**
     * The page's one figure in the phone top bar. Tapping it opens the summary
     * sheet, which holds every figure the desktop shows (the page passes its
     * desktop components as children). Wider screens never show the bar.
     */
    let {
        label = "",
        value = "",
        unit = "",
        tone = "default",
        title,
        ariaLabel,
        context = null,
        hideLog = false,
        chip,
        more,
        children,
    }: {
        label?: string;
        value?: string;
        unit?: string;
        tone?: "default" | "warning" | "negative" | "positive";
        /** The sheet's title. */
        title: string;
        ariaLabel?: string;
        /** Shown after the section name in the top bar, e.g. the day in view. */
        context?: string | null;
        /** A wide glance (Health's three figures) takes the log button's place. */
        hideLog?: boolean;
        /** Custom chip content instead of label and value. */
        chip?: Snippet;
        /** A way on from the sheet, e.g. the week; the sheet closes first. */
        more?: { label: string; run: () => void } | { label: string; run: () => void }[];
        children: Snippet;
    } = $props();

    let open = $state(false);

    const toneClass = $derived({
        default: "text-[var(--stor-ink)]",
        warning: "text-[var(--stor-warning)]",
        negative: "text-[var(--stor-negative)]",
        positive: "text-[var(--stor-positive)]",
    }[tone]);

    $effect(() => {
        phoneHeader.glance = glance;
        return () => { if (phoneHeader.glance === glance) phoneHeader.glance = null; };
    });
    $effect(() => {
        phoneHeader.context = context;
        phoneHeader.hideLog = hideLog;
        return () => { phoneHeader.context = null; phoneHeader.hideLog = false; };
    });
</script>

{#snippet glance()}
    <button
        type="button"
        class="stor-phone-glance flex h-10 min-w-0 shrink items-center rounded-full bg-[var(--stor-surface-raised)] px-3.5 text-left shadow-[var(--stor-elevation-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
        aria-label={ariaLabel ?? (label ? `${label}: ${value} ${unit}`.trim() : title)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="phone-glance"
        onclick={() => (open = true)}
    >
        {#if chip}
            {@render chip()}
        {:else}
            <span class="flex min-w-0 flex-col items-end leading-tight">
                <span class="max-w-full truncate text-[10.5px] font-medium text-[var(--stor-muted-text)]">{label}</span>
                <span class="max-w-full truncate text-[14.5px] font-semibold tabular-nums {toneClass}">{value}{#if unit}<span class="ml-0.5 text-[11px] font-medium text-[var(--stor-muted-text)]">{unit}</span>{/if}</span>
            </span>
        {/if}
    </button>
{/snippet}

<Modal show={open} {title} onClose={() => (open = false)}>
    {@render children()}
    {#if more && (!Array.isArray(more) || more.length > 0)}
        <div class="mt-3 grid gap-2" style:grid-template-columns="repeat({Array.isArray(more) ? more.length : 1}, minmax(0, 1fr))">
            {#each Array.isArray(more) ? more : [more] as action (action.label)}
                <button
                    type="button"
                    class="flex min-h-12 w-full items-center justify-center rounded-xl bg-[var(--stor-surface-muted)] text-sm font-semibold text-[var(--stor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
                    onclick={() => { open = false; action.run(); }}
                >{action.label}</button>
            {/each}
        </div>
    {/if}
</Modal>
