<script lang="ts">
    import { Button as BitsButton } from "bits-ui";
    import type { VariantProps } from "class-variance-authority";
    import type { Snippet } from "svelte";
    import type { HTMLButtonAttributes } from "svelte/elements";
    import { cn } from "../../utils/cn.js";
    import { buttonVariants, spinnerTone } from "./button-variants.js";

    type ButtonProps = HTMLButtonAttributes &
        VariantProps<typeof buttonVariants> & {
            /** Saving: keeps the button's width, swaps its face for a spinner, and blocks presses. */
            busy?: boolean;
            /** A keyboard hint drawn as a key cap after the label, e.g. "N". Hidden on touch screens. */
            shortcut?: string;
            children?: Snippet;
        };

    let {
        class: className = "",
        variant = "default",
        size = "md",
        type = "button",
        busy = false,
        shortcut = "",
        disabled,
        children,
        ...restProps
    }: ButtonProps = $props();
</script>

<BitsButton.Root
    {type}
    data-stor-button-variant={variant}
    disabled={disabled || busy}
    aria-busy={busy || undefined}
    class={cn(
        buttonVariants({ variant, size }),
        // Important: base.css pins the action text colour on every action fill.
        busy && "!text-transparent disabled:opacity-100 [&>:not([data-button-spinner])]:invisible",
        className,
    )}
    {...restProps}
>
    {@render children?.()}
    {#if shortcut}<kbd class="stor-kbd" aria-hidden="true">{shortcut}</kbd>{/if}
    {#if busy}
        <span data-button-spinner class="absolute inset-0 grid place-items-center {spinnerTone[variant ?? 'default']}" aria-hidden="true">
            <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><path d="M12 3a9 9 0 1 0 9 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" /></svg>
        </span>
    {/if}
</BitsButton.Root>
