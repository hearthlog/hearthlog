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
        "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-[var(--stor-surface-well)] shadow-[inset_0_0_0_1.5px_var(--stor-field-line)] text-[var(--stor-action-text)] transition duration-[var(--stor-dur-1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--stor-focus)] data-[state=checked]:bg-[var(--stor-action)] data-[state=checked]:shadow-[var(--stor-action-shadow)] disabled:cursor-not-allowed disabled:opacity-45 [&[data-state=checked]_.checkbox-check]:opacity-100",
        className,
    )}
    {...restProps}
>
    <IconCheck class="checkbox-check h-3.5 w-3.5 opacity-0" />
    {@render children?.()}
</Checkbox.Root>
