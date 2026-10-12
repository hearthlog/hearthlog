<script lang="ts">
    import type { Snippet } from "svelte";
    import IconChevronRight from "~icons/mdi/chevron-right";

    /**
     * What a form fills in for you, or what it folds away, as one muted line.
     * Tapping it opens the fields underneath; nothing in it is hidden or guessed.
     */
    let {
        open = $bindable(false),
        summary,
        tone = "muted",
        children,
    }: {
        open?: boolean;
        summary: string;
        /** `muted` for a line of defaults, `link` for a plain fold. */
        tone?: "muted" | "link";
        /** The fields it opens; without them the line only flips `open` for the form to show its own fields. */
        children?: Snippet;
    } = $props();
</script>

{#if open}
    {#if children}<div class="flex flex-col gap-3">{@render children()}</div>{/if}
{:else}
    <button
        type="button"
        class="flex min-h-11 w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] {tone === 'muted'
            ? 'rounded-xl bg-[var(--stor-surface-muted)] px-3 py-2.5 text-[13px] font-medium leading-snug text-[var(--stor-muted-text)]'
            : 'text-sm font-semibold text-[var(--stor-accent-text)]'}"
        aria-expanded="false"
        onclick={() => (open = true)}
    >
        <span class="min-w-0 flex-1">{summary}</span>
        <IconChevronRight class="h-[18px] w-[18px] shrink-0" />
    </button>
{/if}
