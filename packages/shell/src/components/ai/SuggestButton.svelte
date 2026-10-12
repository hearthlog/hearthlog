<script lang="ts">
    import IconCreation from "~icons/mdi/creation";

    /** Asks for a suggestion on demand, so the person sees what happened instead of waiting for one. */
    let {
        label,
        busy = false,
        disabled = false,
        onclick,
    }: { label: string; busy?: boolean; disabled?: boolean; onclick: () => void } = $props();
</script>

<button
    type="button"
    class="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold text-[var(--stor-info)] transition hover:bg-[var(--stor-info-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] disabled:pointer-events-none disabled:opacity-50"
    aria-label={label}
    title={label}
    disabled={disabled || busy}
    {onclick}
>
    <IconCreation class="h-4 w-4 {busy ? 'motion-safe:animate-pulse' : ''}" />
    {busy ? "Thinking…" : "Suggest"}
</button>
