<script lang="ts">
    import JsonViewer from "@hearthlog/ui/components/JsonViewer.svelte";
    import type { AppEvent } from "@hearthlog/runtime/event/index.js";

    let { event, expanded = $bindable() } = $props<{
        event: AppEvent;
        expanded?: boolean;
    }>();

    function toggle() {
        expanded = !expanded;
    }
</script>

<li class="stor-panel overflow-hidden">
    <button
        type="button"
        class="flex w-full items-center justify-between gap-3 p-3 text-left transition hover:bg-[var(--stor-surface-muted)] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-stone-300"
        onclick={toggle}
        aria-expanded={expanded}
    >
        <div class="min-w-0">
            <div class="truncate text-sm font-semibold text-stone-900">
                {event.type}
            </div>
            <div class="mt-1 text-xs text-[var(--stor-muted-text)]">
                {new Date(event.timestamp).toLocaleString()}
            </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
            {#if event.id}
                <span
                    class="hidden rounded-full bg-[var(--stor-surface-muted)] px-2 py-1 text-[10.5px] font-semibold text-[var(--stor-muted-text)] sm:inline"
                >
                    {String(event.id).slice(0, 8)}
                </span>
            {/if}
            <span class="rounded-full border border-[var(--stor-border)] px-2.5 py-1 text-xs font-semibold text-stone-600">
                {expanded ? "Hide" : "Payload"}
            </span>
        </div>
    </button>
    {#if expanded}
        <div class="border-t border-[var(--stor-border)] p-3">
            <JsonViewer
                value={event.payload}
                label={`${event.type} event payload`}
            />
        </div>
    {/if}
</li>
