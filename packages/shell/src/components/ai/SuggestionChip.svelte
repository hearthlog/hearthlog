<script lang="ts">
    /** A suggestion the model is not sure enough to apply: one tap fills it. */
    let { label, onclick, disabled = false }: { label: string; onclick: () => void; disabled?: boolean } = $props();
</script>

<button
    type="button"
    class="inline-flex min-h-7 items-center rounded-full border border-[var(--stor-info-border)] bg-[var(--stor-info-soft)] px-2.5 text-[11px] font-semibold text-[var(--stor-info)] transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] disabled:opacity-50"
    {disabled}
    {onclick}
>
    Suggested: {label}
</button>
