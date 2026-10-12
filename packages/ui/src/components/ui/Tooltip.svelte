<script lang="ts">
    import { Tooltip as BitsTooltip } from "bits-ui";
    import type { Snippet } from "svelte";
    import { cn } from "../../utils/cn.js";

    type TooltipSide = "top" | "right" | "bottom" | "left";
    type TooltipAlign = "start" | "center" | "end";

    let {
        content,
        side = "right",
        align = "center",
        sideOffset = 8,
        delayDuration = 300,
        disabled = false,
        class: className = "",
        trigger,
    }: {
        content: string;
        side?: TooltipSide;
        align?: TooltipAlign;
        sideOffset?: number;
        delayDuration?: number;
        disabled?: boolean;
        class?: string;
        trigger: Snippet<[{ props: Record<string, unknown> }]>;
    } = $props();
</script>

<BitsTooltip.Provider {delayDuration}>
    <BitsTooltip.Root disabled={disabled || content.trim().length === 0}>
        <BitsTooltip.Trigger>
            {#snippet child({ props })}
                {@render trigger({ props })}
            {/snippet}
        </BitsTooltip.Trigger>
        <BitsTooltip.Portal>
            <BitsTooltip.Content
                {side}
                {align}
                {sideOffset}
                collisionPadding={8}
                class={cn(
                    "z-[var(--stor-layer-tooltip)] rounded-lg bg-[var(--stor-tooltip)] px-2.5 py-1.5 text-xs font-semibold text-[var(--stor-tooltip-text)] shadow-[var(--stor-elevation-3)]",
                    className,
                )}
            >
                {content}
                <BitsTooltip.Arrow class="fill-[var(--stor-tooltip)]" />
            </BitsTooltip.Content>
        </BitsTooltip.Portal>
    </BitsTooltip.Root>
</BitsTooltip.Provider>
