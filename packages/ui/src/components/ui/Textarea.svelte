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
        "stor-field-control min-h-24 w-full px-3 py-2.5 text-base sm:text-sm",
        className,
    )}
    {...restProps}
></textarea>
