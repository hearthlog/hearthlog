import type { RawSqliteColumn } from "@hearthlog/runtime/db/raw-browser.js";
import { presentRawSqliteValue } from "@hearthlog/runtime/db/raw-browser.js";
import { renderComponent } from "@tanstack/svelte-table";
import DataTableHeader from "@hearthlog/ui/components/data-table/DataTableHeader.svelte";
import DataTableValue from "./DataTableValue.svelte";
import { createAppColumnHelper } from "@hearthlog/ui/components/data-table/table.js";
import type { DataTableColumn } from "@hearthlog/ui/components/data-table/types.js";

export function describeSqliteColumn(column: RawSqliteColumn): string {
    const parts = [column.dataType];
    if (column.primaryKeyPosition > 0) {
        parts.push(`PK ${column.primaryKeyPosition}`);
    } else if (column.notNull) {
        parts.push("NOT NULL");
    }
    return parts.join(" · ");
}

const columnHelper = createAppColumnHelper<Record<string, unknown>>();

export function toSqliteTableColumns(
    columns: RawSqliteColumn[],
): DataTableColumn[] {
    return columnHelper.columns(
        columns.map((column) =>
            columnHelper.accessor((row) => row[column.name], {
                id: column.name,
                enableSorting: true,
                header: (headerContext) =>
                    renderComponent(DataTableHeader, {
                        name: column.name,
                        subtitle: describeSqliteColumn(column),
                        context: headerContext,
                    }),
                cell: (info) =>
                    renderComponent(DataTableValue, {
                        presented: presentRawSqliteValue(info.getValue()),
                    }),
            }),
        ),
    );
}
