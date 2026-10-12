<script lang="ts">
    import { FlexRender } from "@tanstack/svelte-table";
    import type { Snippet } from "svelte";
    import EmptyState from "../EmptyState.svelte";
    import { createAppTable } from "./table.js";
    import type { DataTableProps } from "./types.js";
    import {
        fromTableSortingState,
        toTablePaginationState,
        toTableSortingState,
    } from "./types.js";

    let {
        columns,
        data,
        pagination,
        sorting = { id: null, desc: false },
        onSortingChange,
        isLoading = false,
        emptyTitle = "No rows",
        emptyDescription = "There is nothing to show.",
        emptyContent,
        variant = "default",
        label,
        rowClass,
        testId = "data-table",
        scrollTestId = "data-table-scroll",
    }: DataTableProps = $props();

    const table = createAppTable({
        get columns() {
            return columns;
        },
        get data() {
            return data;
        },
        getRowId: (row) => String(row.id ?? ""),
        get rowCount() {
            return pagination.rowCount;
        },
        get state() {
            return {
                pagination: toTablePaginationState(pagination),
                sorting: toTableSortingState(sorting),
            };
        },
        onSortingChange: (updater) => {
            const next = fromTableSortingState(
                typeof updater === "function"
                    ? updater(toTableSortingState(sorting))
                    : updater,
            );
            const current = fromTableSortingState(toTableSortingState(sorting));
            if (
                next.id === current.id &&
                (next.id === null || next.desc === current.desc)
            ) {
                return;
            }
            onSortingChange?.(next);
        },
        manualPagination: true,
        manualSorting: true,
        enableSortingRemoval: true,
        enableMultiSort: false,
        sortDescFirst: false,
    });

    const rows = $derived(table.getRowModel().rows);
    const quiet = $derived(variant === "quiet");
</script>

{#snippet emptyFallback()}
    {#if emptyContent}
        {@render emptyContent()}
    {:else}
        <EmptyState title={emptyTitle} description={emptyDescription} surface={false} />
    {/if}
{/snippet}

{#if isLoading && rows.length === 0}
    <div class="p-4">
        <div
            class="grid gap-3 p-5"
            role="status"
            aria-label="Loading table rows"
        >
            {#each Array(5) as _, index (index)}
                <div
                    class="h-8 rounded-lg bg-[var(--stor-surface-muted)] motion-safe:animate-pulse"
                    style:width={`${100 - (index % 3) * 12}%`}
                    aria-hidden="true"
                ></div>
            {/each}
        </div>
    </div>
{:else if rows.length === 0}
    <div class="p-4">
        {@render emptyFallback()}
    </div>
{:else}
    <div class="max-w-full overflow-x-auto" data-testid={scrollTestId}>
        <table
            class="w-full border-collapse text-left text-sm {quiet ? '' : 'min-w-max'}"
            data-testid={testId}
            aria-label={label}
        >
            <thead>
                {#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
                    <tr class={quiet ? "" : "bg-[var(--stor-surface-muted)]"}>
                        {#each headerGroup.headers as header (header.id)}
                            <th
                                scope="col"
                                class="px-3 align-bottom {quiet
                                    ? 'pb-2 pt-0 text-xs'
                                    : 'border-b border-[var(--stor-border)] py-2.5'} {header.column.columnDef.meta?.className ?? ''}"
                            >
                                {#if !header.isPlaceholder}
                                    <FlexRender {header} />
                                {/if}
                            </th>
                        {/each}
                    </tr>
                {/each}
            </thead>
            <tbody class={quiet ? "divide-y divide-[color-mix(in_srgb,var(--stor-border)_55%,transparent)]" : "divide-y divide-[var(--stor-border)]"}>
                {#each rows as row (row.id)}
                    <tr class="align-middle transition-colors hover:bg-[var(--stor-surface-muted)]/70 {rowClass ? rowClass(row.original) : ''}">
                        {#each row.getAllCells() as cell (cell.id)}
                            <td class="max-w-[36rem] px-3 {quiet ? 'h-14' : 'py-2.5'} {cell.column.columnDef.meta?.className ?? ''}">
                                <FlexRender {cell} />
                            </td>
                        {/each}
                    </tr>
                {/each}
            </tbody>
        </table>
    </div>
{/if}
