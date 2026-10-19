<script lang="ts">
    import { cn } from "../../utils/cn.js";

    /** An on/off switch: one row with a label, an optional short hint, and the toggle at the end. */
    let {
        checked = false,
        label,
        hint = "",
        disabled = false,
        onCheckedChange,
        ariaLabel,
        class: className = "",
    }: {
        checked?: boolean;
        label: string;
        hint?: string;
        disabled?: boolean;
        onCheckedChange: (checked: boolean) => void;
        /** When the label is not shown, e.g. a switch at the end of a list row. */
        ariaLabel?: string;
        class?: string;
    } = $props();
</script>

<button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    {disabled}
    class={cn("flex min-h-12 w-full items-center gap-3 rounded-[10px] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--stor-focus)] disabled:opacity-45", className)}
    onclick={() => onCheckedChange(!checked)}
>
    {#if label}<span class="min-w-0 flex-1">
        <span class="block text-body font-medium text-[var(--stor-ink)]">{label}</span>
        {#if hint}<span class="block text-caption text-[var(--stor-muted-text)]">{hint}</span>{/if}
    </span>{/if}
    <span class="relative h-6 w-10 shrink-0 rounded-full transition-colors duration-[var(--stor-dur-2)] {checked ? 'bg-[var(--stor-action)]' : 'bg-[var(--stor-surface-well)] shadow-[inset_0_0_0_1px_var(--stor-field-border)]'}" aria-hidden="true">
        <span class="absolute top-[3px] h-[18px] w-[18px] rounded-full shadow-[0_1px_2px_rgb(0_0_0/.2)] transition-[left] duration-[var(--stor-dur-2)] {checked ? 'left-[19px] bg-[var(--stor-action-text)]' : 'left-[3px] bg-[var(--stor-surface-raised)]'}"></span>
    </span>
</button>
