<script lang="ts">
    import type { HeaderContext } from "@tanstack/svelte-table";
    import IconArrowDown from "~icons/mdi/arrow-down";
    import IconArrowUp from "~icons/mdi/arrow-up";
    import IconUnfoldMoreHorizontal from "~icons/mdi/unfold-more-horizontal";
    import type { AppFeatures } from "./table.js";
    import type { DataTableRow } from "./types.js";

    let {
        name,
        subtitle,
        align = "left",
        context,
    }: {
        name: string;
        subtitle?: string;
        align?: "left" | "right";
        context?: HeaderContext<AppFeatures, DataTableRow, unknown>;
    } = $props();

    const sortDirection = $derived(context?.column.getIsSorted() ?? false);
    const canSort = $derived(context?.column.getCanSort() ?? false);
    const toggleSorting = $derived(context?.column.getToggleSortingHandler());
    const sortLabel = $derived(
        !canSort
            ? undefined
            : sortDirection === "asc"
              ? `Sort by ${name}, descending`
              : sortDirection === "desc"
                ? `Sort by ${name}, clear sorting`
                : `Sort by ${name}, ascending`,
    );
</script>

{#if canSort && toggleSorting}
    <button
        type="button"
        class="group flex w-full min-w-0 flex-col {align === 'right' ? 'items-end' : 'items-start'} gap-0.5 rounded-md px-1 py-0.5 text-left outline-none transition hover:bg-[var(--stor-surface)] focus-visible:ring-2 focus-visible:ring-[var(--stor-selected)]"
        aria-label={sortLabel}
        aria-sort={sortDirection === "asc"
            ? "ascending"
            : sortDirection === "desc"
              ? "descending"
              : "none"}
        onclick={(event) => toggleSorting(event)}
    >
        <span class="flex w-full min-w-0 items-center gap-1 {align === 'right' ? 'justify-end' : ''}">
            <span class="truncate font-semibold text-[var(--stor-ink)]">{name}</span>
            <span class="shrink-0 text-[var(--stor-muted-text)]" aria-hidden="true">
                {#if sortDirection === "asc"}
                    <IconArrowUp class="h-3.5 w-3.5 text-[var(--stor-accent-strong)]" />
                {:else if sortDirection === "desc"}
                    <IconArrowDown class="h-3.5 w-3.5 text-[var(--stor-accent-strong)]" />
                {:else}
                    <IconUnfoldMoreHorizontal class="h-3.5 w-3.5 opacity-40 transition group-hover:opacity-100" />
                {/if}
            </span>
        </span>
        {#if subtitle}
            <span
                class="whitespace-nowrap text-[10.5px] font-normal text-[var(--stor-muted-text)]"
            >
                {subtitle}
            </span>
        {/if}
    </button>
{:else}
    <div class="font-semibold text-[var(--stor-ink)] {align === 'right' ? 'text-right' : ''}">
        {name}
    </div>
    {#if subtitle}
        <div
            class="mt-0.5 whitespace-nowrap text-[10.5px] font-normal text-[var(--stor-muted-text)] {align === 'right' ? 'text-right' : ''}"
        >
            {subtitle}
        </div>
    {/if}
{/if}
