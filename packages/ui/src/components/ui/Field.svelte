<script lang="ts">
    import type { Snippet } from "svelte";
    import type { HTMLAttributes } from "svelte/elements";
    import IconAlert from "~icons/mdi/alert-circle-outline";
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

<!-- Label above at caption size, help or error below; an error also outlines the field's control in negative. -->
<div class={cn("space-y-1.5", className)} data-stor-invalid={error ? "" : undefined} {...restProps}>
    {#if label}
        <Label
            for={htmlFor || undefined}
            class={cn("block", labelClass)}
        >
            {label}
            {#if required}
                <span class="text-[var(--stor-negative)]">*</span>
            {/if}
        </Label>
    {/if}

    {@render children?.()}

    {#if error}
        <p role="alert" class="flex items-start gap-1.5 text-caption font-normal text-[var(--stor-negative)]">
            <IconAlert class="h-4 w-4 shrink-0" aria-hidden="true" />{error}
        </p>
    {:else if hint}
        <p class={cn("text-caption font-normal text-[var(--stor-muted-text)]", hintClass)}>{hint}</p>
    {/if}
</div>
