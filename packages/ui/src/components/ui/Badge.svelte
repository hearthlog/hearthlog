<script lang="ts">
    import { cva, type VariantProps } from "class-variance-authority";
    import type { Snippet } from "svelte";
    import type { HTMLAttributes } from "svelte/elements";
    import { cn } from "../../utils/cn.js";

    /** A status chip: caption text on a soft fill, 6px corners, and a 6px dot before the word. Status always has a word. */
    const badgeVariants = cva(
        "inline-flex min-h-[22px] items-center gap-1.5 rounded-[6px] px-2 py-[3px] text-caption",
        {
            variants: {
                variant: {
                    default: "bg-[color-mix(in_srgb,var(--stor-ink)_7%,transparent)] text-[var(--stor-muted-text)]",
                    success: "bg-[var(--stor-positive-soft)] text-[var(--stor-positive)]",
                    warning: "bg-[var(--stor-warning-soft)] text-[var(--stor-warning)]",
                    danger: "bg-[var(--stor-negative-soft)] text-[var(--stor-negative)]",
                    info: "bg-[var(--stor-info-soft)] text-[var(--stor-info)]",
                },
            },
            defaultVariants: {
                variant: "default",
            },
        },
    );

    type BadgeProps = HTMLAttributes<HTMLSpanElement> &
        VariantProps<typeof badgeVariants> & {
            /** The leading status dot; on for every variant but the quiet default. */
            dot?: boolean;
            children?: Snippet;
        };

    let {
        class: className = "",
        variant = "default",
        dot,
        children,
        ...restProps
    }: BadgeProps = $props();

    const showDot = $derived(dot ?? (variant !== "default" && variant !== null));
</script>

<span class={cn(badgeVariants({ variant }), className)} {...restProps}>
    {#if showDot}<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true"></span>{/if}
    {@render children?.()}
</span>
