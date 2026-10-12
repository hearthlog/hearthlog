<script lang="ts">
    import type { HTMLInputAttributes } from "svelte/elements";
    import { cn } from "../../utils/cn.js";

    let {
        class: className = "",
        type = "text",
        value = $bindable(),
        ...restProps
    }: HTMLInputAttributes = $props();
</script>

<input
    {type}
    bind:value
    class={cn(
        "w-full rounded-xl border border-[var(--stor-field-border)] stor-well focus:bg-[var(--stor-surface)] h-11 px-3 py-2.5 text-base sm:h-9 sm:py-1.5 sm:text-sm text-[var(--stor-ink)] outline-none transition placeholder:text-[var(--stor-muted-text)] focus:border-[var(--stor-focus)] focus:ring-2 focus:ring-[var(--stor-selected)] disabled:cursor-not-allowed disabled:bg-[var(--stor-surface-muted)] disabled:text-[var(--stor-muted-text)]",
        className,
    )}
    {...restProps}
/>
