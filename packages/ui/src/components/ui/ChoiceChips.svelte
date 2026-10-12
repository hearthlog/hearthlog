<script lang="ts" generics="T extends string | number">
    import { cn } from "../../utils/cn.js";
    import IconChevronDown from "~icons/mdi/chevron-down";

    /**
     * A short list of choices as chips; the chosen one is tinted. `more` adds a
     * last chip (All, Other, Pick…) that the form answers, e.g. by opening the
     * full list or a field.
     */
    let {
        options,
        value,
        label,
        onChange,
        more,
        onMore,
        moreActive = false,
        class: className = "",
    }: {
        options: readonly { value: T; label: string }[];
        value: T | null | undefined;
        /** Names the group for assistive tech. */
        label: string;
        onChange: (value: T) => void;
        more?: string;
        onMore?: () => void;
        moreActive?: boolean;
        class?: string;
    } = $props();

    const chip = (on: boolean) => `inline-flex h-9 items-center gap-1 rounded-full px-3.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] ${on ? "bg-[var(--stor-accent-soft)] font-semibold text-[var(--stor-accent-strong)]" : "bg-[var(--stor-surface-muted)] font-medium text-[var(--stor-ink)]"}`;

    // Arrow keys move between chips so a row is one stop for Tab, like a radio group.
    function moveFocus(event: KeyboardEvent): void {
        const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        const chips = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button")];
        const next = chips[chips.indexOf(document.activeElement as HTMLButtonElement) + step];
        if (!next) return;
        event.preventDefault();
        next.focus();
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class={cn("flex flex-wrap gap-2", className)} role="group" aria-label={label} onkeydown={moveFocus}>
    {#each options as option (option.value)}
        <button type="button" class={chip(value === option.value)} aria-pressed={value === option.value} onclick={() => onChange(option.value)}>{option.label}</button>
    {/each}
    {#if more && onMore}
        <button type="button" class={chip(moreActive)} aria-expanded={moreActive} onclick={onMore}>{more}<IconChevronDown class="h-4 w-4" /></button>
    {/if}
</div>
