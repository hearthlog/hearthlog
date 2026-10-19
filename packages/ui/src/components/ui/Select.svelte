<script lang="ts">
    import { Select } from "bits-ui";
    import type { Snippet } from "svelte";
    import { cn } from "../../utils/cn.js";
    import IconCheck from "~icons/mdi/check";
    import IconChevronDown from "~icons/mdi/chevron-down";

    export interface SelectOption {
        value: string;
        label: string;
        disabled?: boolean;
    }

    let {
        value = "",
        options = [],
        placeholder = "Select",
        disabled = false,
        id = "",
        name = "",
        ariaLabel = "",
        onValueChange = () => {},
        class: className = "",
        triggerClass = "",
        contentClass = "",
        children,
    }: {
        value?: string;
        options: SelectOption[];
        placeholder?: string;
        disabled?: boolean;
        id?: string;
        name?: string;
        ariaLabel?: string;
        onValueChange?: (value: string) => void;
        class?: string;
        triggerClass?: string;
        contentClass?: string;
        children?: Snippet;
    } = $props();
</script>

<div class={className}>
    <Select.Root
        type="single"
        {value}
        items={options}
        {disabled}
        {name}
        {onValueChange}
        loop
    >
        <Select.Trigger
            id={id || undefined}
            aria-label={ariaLabel || undefined}
            class={cn(
                "stor-field-control flex w-full items-center justify-between gap-2 h-11 px-3 py-2.5 sm:h-9 sm:py-1.5 text-left text-sm",
                triggerClass,
            )}
        >
            <Select.Value {placeholder} class="min-w-0 truncate data-[placeholder]:text-[var(--stor-faint-text)]" />
            <IconChevronDown class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)]" />
        </Select.Trigger>
        <Select.Portal>
            <Select.Content
                sideOffset={6}
                class={cn(
                    "stor-menu z-[var(--stor-layer-menu)] max-h-72 min-w-[var(--bits-select-anchor-width)] overflow-hidden p-1.5",
                    contentClass,
                )}
            >
                <Select.Viewport>
                    {#each options as option (option.value)}
                        <Select.Item
                            value={option.value}
                            label={option.label}
                            disabled={option.disabled}
                            class="flex min-h-11 cursor-default items-center justify-between gap-3 rounded-[10px] px-2.5 text-sm text-[var(--stor-ink)] outline-none data-[highlighted]:bg-[var(--stor-surface-hover)] data-[selected]:font-semibold data-[disabled]:opacity-45 sm:min-h-8"
                        >
                            {#snippet children({ selected })}
                                <span class="min-w-0 truncate">{option.label}</span>
                                {#if selected}
                                    <IconCheck class="h-4 w-4 shrink-0 text-[var(--stor-accent-strong)]" />
                                {/if}
                            {/snippet}
                        </Select.Item>
                    {/each}
                    {@render children?.()}
                </Select.Viewport>
            </Select.Content>
        </Select.Portal>
    </Select.Root>
</div>
