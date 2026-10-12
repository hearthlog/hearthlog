<script lang="ts">
    import CommandOnly from "@hearthlog/ui/components/commands/CommandOnly.svelte";
    import IconPencil from "~icons/mdi/pencil-outline";
    import IconTrash from "~icons/mdi/trash-can-outline";

    let {
        onEdit,
        onDelete,
    }: {
        onEdit: () => void;
        onDelete: () => void;
    } = $props();
</script>

<div class="flex items-center justify-end gap-1">
    <CommandOnly>
        <button
            type="button"
            onclick={onEdit}
            class="rounded-lg p-2 text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-surface-muted)] hover:text-[var(--stor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
            title="Edit"
            aria-label="Edit"
        >
            <IconPencil class="h-4 w-4" />
        </button>
        <button
            type="button"
            onclick={onDelete}
            class="rounded-lg p-2 text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-negative-soft)] hover:text-[var(--stor-negative)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
            title="Delete"
            aria-label="Delete"
        >
            <IconTrash class="h-4 w-4" />
        </button>
    </CommandOnly>
</div>
