import type { DynamicFieldDefinition } from "@hearthlog/runtime/event/meta-entity-types.js";
import type { ReferencedByResult } from "@hearthlog/runtime/event/reference-lookup.js";
import { renderComponent } from "@tanstack/svelte-table";
import DataTableHeader from "@hearthlog/ui/components/data-table/DataTableHeader.svelte";
import EntityActionsCell from "./EntityActionsCell.svelte";
import EntityRefsCell from "./EntityRefsCell.svelte";
import EntityValue from "./EntityValue.svelte";
import { createAppColumnHelper } from "@hearthlog/ui/components/data-table/table.js";
import type { DataTableColumn } from "@hearthlog/ui/components/data-table/types.js";

export type DataTableEntityColumn = DataTableColumn;

export interface EntityTableCallbacks {
    getReferencedBy: (id: string) => ReferencedByResult | null;
    getReferenceLabel: (fieldName: string, value: unknown) => string | null;
    entityHref: (name: string) => string;
    onEdit: (row: Record<string, unknown>) => void;
    onDelete: (id: string) => void;
}

export function describeEntityField(field: DynamicFieldDefinition): string {
    const parts: string[] = [field.type];
    if (field.required) parts.push("required");
    if (field.referenceTo) parts.push(`→ ${field.referenceTo}`);
    else if (field.enum?.length) parts.push(`${field.enum.length} options`);
    return parts.join(" · ");
}

const columnHelper = createAppColumnHelper<Record<string, unknown>>();

export function toEntityTableColumns(
    fields: DynamicFieldDefinition[],
    callbacks: EntityTableCallbacks,
): DataTableColumn[] {
    const dataColumns = fields.map((field) =>
        columnHelper.accessor((row) => row[field.name], {
            id: field.name,
            enableSorting: true,
            header: (headerContext) =>
                renderComponent(DataTableHeader, {
                    name: field.name,
                    subtitle: describeEntityField(field),
                    context: headerContext,
                }),
            cell: (info) =>
                renderComponent(EntityValue, {
                    value: info.getValue(),
                    field,
                    referenceLabel: callbacks.getReferenceLabel(
                        field.name,
                        info.getValue(),
                    ),
                }),
        }),
    );
    const refsColumn = columnHelper.display({
        id: "__refs",
        enableSorting: false,
        header: () =>
            renderComponent(DataTableHeader, {
                name: "References",
            }),
        cell: (info) =>
            renderComponent(EntityRefsCell, {
                refs: callbacks.getReferencedBy(
                    String(info.row.original.id),
                ),
                entityHref: callbacks.entityHref,
            }),
    });
    const actionsColumn = columnHelper.display({
        id: "__actions",
        enableSorting: false,
        header: () =>
            renderComponent(DataTableHeader, {
                name: "Actions",
                align: "right",
            }),
        cell: (info) =>
            renderComponent(EntityActionsCell, {
                onEdit: () => callbacks.onEdit(info.row.original),
                onDelete: () =>
                    callbacks.onDelete(String(info.row.original.id)),
            }),
    });
    return columnHelper.columns([...dataColumns, refsColumn, actionsColumn]);
}
