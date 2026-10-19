<script lang="ts">
    import { Label as BitsLabel } from "bits-ui";
    import type { Snippet } from "svelte";
    import { cn } from "../../utils/cn.js";

    let {
        class: className = "",
        children,
        ...restProps
    }: BitsLabel.RootProps & { children?: Snippet } = $props();
</script>

<BitsLabel.Root
    class={cn("text-caption text-[var(--stor-muted-text)]", className)}
    {...restProps}
>
    {@render children?.()}
</BitsLabel.Root>
