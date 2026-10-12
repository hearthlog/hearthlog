<script lang="ts">
    import { cva, type VariantProps } from "class-variance-authority";
    import type { Snippet } from "svelte";
    import type { HTMLAttributes } from "svelte/elements";
    import { cn } from "../../utils/cn.js";

    const badgeVariants = cva(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        {
            variants: {
                variant: {
                    default: "border-transparent bg-[var(--stor-surface-well)] text-[var(--stor-muted-text)]",
                    success: "border-transparent bg-[var(--stor-positive-soft)] text-[var(--stor-positive)]",
                    warning: "border-transparent bg-[var(--stor-warning-soft)] text-[var(--stor-warning)]",
                    danger: "border-transparent bg-[var(--stor-negative-soft)] text-[var(--stor-negative)]",
                    info: "border-[var(--stor-info-border)] bg-[var(--stor-info-soft)] text-[var(--stor-info)]",
                },
            },
            defaultVariants: {
                variant: "default",
            },
        },
    );

    type BadgeProps = HTMLAttributes<HTMLSpanElement> &
        VariantProps<typeof badgeVariants> & {
            children?: Snippet;
        };

    let {
        class: className = "",
        variant = "default",
        children,
        ...restProps
    }: BadgeProps = $props();
</script>

<span class={cn(badgeVariants({ variant }), className)} {...restProps}>
    {@render children?.()}
</span>
