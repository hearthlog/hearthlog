import {
    createTableHook,
    rowPaginationFeature,
    rowSortingFeature,
    tableFeatures,
} from "@tanstack/svelte-table";

export interface DataTableColumnMeta {
    subtitle?: string;
    /** Classes for the column's header and cells, for example to hide it on a phone or align its numbers. */
    className?: string;
}

const appFeatures = tableFeatures({
    rowPaginationFeature,
    rowSortingFeature,
    columnMeta: {} as DataTableColumnMeta,
});

export type AppFeatures = typeof appFeatures;

export const {
    createAppColumnHelper,
    createAppTable,
    useCellContext,
    useHeaderContext,
    useTableContext,
} = createTableHook({
    features: appFeatures,
});
