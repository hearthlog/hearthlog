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
        "stor-field-control w-full h-11 px-3 py-2.5 text-base sm:h-9 sm:py-1.5 sm:text-sm",
        className,
    )}
    {...restProps}
/>
