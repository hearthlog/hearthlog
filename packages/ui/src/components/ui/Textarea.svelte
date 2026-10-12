<script lang="ts">
    import type { HTMLTextareaAttributes } from "svelte/elements";
    import { cn } from "../../utils/cn.js";

    let {
        class: className = "",
        value = $bindable(),
        ...restProps
    }: HTMLTextareaAttributes = $props();
</script>

<textarea
    bind:value
    class={cn(
        "min-h-24 w-full rounded-xl border border-[var(--stor-field-border)] stor-well focus:bg-[var(--stor-surface)] px-3 py-2.5 text-base sm:text-sm text-[var(--stor-ink)] outline-none transition placeholder:text-[var(--stor-muted-text)] focus:border-[var(--stor-focus)] focus:ring-2 focus:ring-[var(--stor-selected)] disabled:cursor-not-allowed disabled:bg-[var(--stor-surface-muted)] disabled:text-[var(--stor-muted-text)]",
        className,
    )}
    {...restProps}
></textarea>
