<script lang="ts">
    import { Button as BitsButton } from "bits-ui";
    import { cva, type VariantProps } from "class-variance-authority";
    import type { Snippet } from "svelte";
    import type { HTMLButtonAttributes } from "svelte/elements";
    import { cn } from "../../utils/cn.js";

    const buttonVariants = cva(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-[background-color,color,box-shadow,transform,filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] duration-100 active:translate-y-px motion-reduce:transition-none motion-reduce:active:translate-y-0 disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none",
        {
            variants: {
                variant: {
                    default: "bg-[var(--stor-action)] text-[var(--stor-action-text)] hover:bg-[var(--stor-action-hover)] active:brightness-95",
                    secondary: "bg-[var(--stor-surface-raised)] shadow-[var(--stor-elevation-2)] text-[var(--stor-ink)] hover:shadow-[var(--stor-elevation-3)] active:brightness-95",
                    ghost: "text-[var(--stor-muted-text)] hover:bg-[var(--stor-accent-soft)] hover:text-[var(--stor-accent-strong)]",
                    destructive: "bg-[var(--stor-negative)] text-[var(--stor-negative-text)] hover:brightness-90 active:brightness-95",
                },
                size: {
                    sm: "h-11 px-3 sm:h-9",
                    md: "h-11 px-4 sm:h-9",
                    icon: "h-11 w-11 p-0 sm:h-9 sm:w-9",
                },
            },
            defaultVariants: {
                variant: "default",
                size: "md",
            },
        },
    );

    type ButtonProps = HTMLButtonAttributes &
        VariantProps<typeof buttonVariants> & {
            children?: Snippet;
        };

    let {
        class: className = "",
        variant = "default",
        size = "md",
        type = "button",
        children,
        ...restProps
    }: ButtonProps = $props();
</script>

<BitsButton.Root
    {type}
    data-stor-button-variant={variant}
    class={cn(buttonVariants({ variant, size }), className)}
    {...restProps}
>
    {@render children?.()}
</BitsButton.Root>
