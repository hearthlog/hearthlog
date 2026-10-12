<script lang="ts">
    import { Checkbox } from "bits-ui";
    import type { Snippet } from "svelte";
    import { cn } from "../../utils/cn.js";
    import IconCheck from "~icons/mdi/check";

    let {
        checked = false,
        onCheckedChange = () => {},
        disabled = false,
        class: className = "",
        children,
        ...restProps
    }: Checkbox.RootProps & { children?: Snippet } = $props();
</script>

<Checkbox.Root
    {checked}
    {onCheckedChange}
    {disabled}
    class={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-[var(--stor-field-border)] stor-well text-[var(--stor-action-text)] transition data-[state=checked]:border-[var(--stor-accent)] data-[state=checked]:bg-[var(--stor-action)] data-[state=checked]:shadow-[0_1px_2px_rgb(0_0_0/.18),inset_0_1px_0_rgb(255_255_255/.22)] disabled:cursor-not-allowed disabled:opacity-50 [&[data-state=checked]_.checkbox-check]:opacity-100",
        className,
    )}
    {...restProps}
>
    <IconCheck class="checkbox-check h-3.5 w-3.5 opacity-0" />
    {@render children?.()}
</Checkbox.Root>
