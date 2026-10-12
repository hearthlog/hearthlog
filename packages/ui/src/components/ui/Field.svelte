<script lang="ts">
    import type { Snippet } from "svelte";
    import type { HTMLAttributes } from "svelte/elements";
    import Label from "./Label.svelte";
    import { cn } from "../../utils/cn.js";

    type FieldProps = HTMLAttributes<HTMLDivElement> & {
        label?: string;
        htmlFor?: string;
        hint?: string;
        error?: string;
        required?: boolean;
        labelClass?: string;
        hintClass?: string;
        children?: Snippet;
    };

    let {
        class: className = "",
        label = "",
        htmlFor = "",
        hint = "",
        error = "",
        required = false,
        labelClass = "",
        hintClass = "",
        children,
        ...restProps
    }: FieldProps = $props();
</script>

<div class={cn("space-y-1.5", className)} {...restProps}>
    {#if label}
        <Label
            for={htmlFor || undefined}
            class={cn("ml-0.5 block", labelClass)}
        >
            {label}
            {#if required}
                <span class="text-[var(--stor-negative)]">*</span>
            {/if}
        </Label>
    {/if}

    {@render children?.()}

    {#if error}
        <p class="ml-0.5 text-xs font-medium text-[var(--stor-negative)]">{error}</p>
    {:else if hint}
        <p class={cn("ml-0.5 text-xs text-[var(--stor-muted-text)]", hintClass)}>{hint}</p>
    {/if}
</div>
