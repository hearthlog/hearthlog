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
    class={cn("flex min-h-12 w-full items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] disabled:opacity-50", className)}
    onclick={() => onCheckedChange(!checked)}
>
    {#if label}<span class="min-w-0 flex-1">
        <span class="block text-[15px] font-medium text-[var(--stor-ink)]">{label}</span>
        {#if hint}<span class="block text-[12.5px] text-[var(--stor-muted-text)]">{hint}</span>{/if}
    </span>{/if}
    <span class="relative h-[30px] w-12 shrink-0 rounded-full transition-colors {checked ? 'bg-[var(--stor-action)]' : 'bg-[var(--stor-surface-well)] shadow-[inset_0_0_0_1px_var(--stor-border)]'}" aria-hidden="true">
        <span class="absolute top-[3px] h-6 w-6 rounded-full bg-white shadow transition-[left] {checked ? 'left-[21px]' : 'left-[3px]'}"></span>
    </span>
</button>
