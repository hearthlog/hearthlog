import type {
    ColumnDef,
    PaginationState,
    SortingState,
} from "@tanstack/svelte-table";
import type { Snippet } from "svelte";
import type { AppFeatures } from "./table.js";

export type DataTableRow = Record<string, unknown>;

export type DataTableColumn = ColumnDef<AppFeatures, DataTableRow, unknown>;

export interface DataTablePagination {
    pageIndex: number;
    pageSize: number;
    rowCount: number;
    pageCount: number;
}

export interface DataTableSorting {
    id: string | null;
    desc: boolean;
}

export function toTablePaginationState(
    input: Pick<DataTablePagination, "pageIndex" | "pageSize">,
): PaginationState {
    return {
        pageIndex: Math.max(0, input.pageIndex),
        pageSize: input.pageSize,
    };
}

export function toTableSortingState(sorting: DataTableSorting): SortingState {
    if (!sorting.id) return [];
    return [{ id: sorting.id, desc: sorting.desc }];
}

export function fromTableSortingState(sorting: SortingState): DataTableSorting {
    const first = sorting[0];
    if (!first?.id) return { id: null, desc: false };
    return { id: first.id, desc: first.desc === true };
}

export interface DataTableProps {
    columns: DataTableColumn[];
    data: DataTableRow[];
    pagination: DataTablePagination;
    sorting?: DataTableSorting;
    onSortingChange?: (sorting: DataTableSorting) => void;
    isLoading?: boolean;
    emptyTitle?: string;
    emptyDescription?: string;
    emptyContent?: Snippet;
    /** `quiet` drops the header band and the heavy rules, for tables that sit inside a panel. */
    variant?: "default" | "quiet";
    /** Names the table for assistive technology. */
    label?: string;
    /** Extra class per row, e.g. a selection highlight. */
    rowClass?: (row: DataTableRow) => string;
    testId?: string;
    scrollTestId?: string;
}
