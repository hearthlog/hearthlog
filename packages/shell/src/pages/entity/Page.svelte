<script lang="ts">
    import DataValue from "@hearthlog/ui/components/data/DataValue.svelte";
    import DataTable from "@hearthlog/ui/components/data-table/DataTable.svelte";
    import DataTablePagination from "@hearthlog/ui/components/data-table/DataTablePagination.svelte";
    import {
        toEntityTableColumns,
        type DataTableEntityColumn,
    } from "@hearthlog/shell/components/data-table/entity-columns.js";
    import { providePageResource } from "@hearthlog/runtime/runtime/page-data.svelte.js";
    import PageDataStatus from "@hearthlog/shell/components/layout/PageDataStatus.svelte";
    import { executeLocalCommand } from "@hearthlog/runtime/commands/index.js";
    import { goto} from "$app/navigation";
    import { refreshPageData as invalidate } from "@hearthlog/runtime/runtime/refresh.js";
    import { page } from "$app/state";
    import type { EntityTypeRecord } from "@hearthlog/runtime/db/dynamic-ddl.js";
    import type { DynamicFieldDefinition } from "@hearthlog/runtime/event/meta-entity-types.js";
    import type { ReferencedByResult } from "@hearthlog/runtime/event/reference-lookup.js";
    import CommandConfirmDialog from "@hearthlog/ui/components/commands/CommandConfirmDialog.svelte";
    import CommandDrawer from "@hearthlog/ui/components/commands/CommandDrawer.svelte";
    import CommandOnly from "@hearthlog/ui/components/commands/CommandOnly.svelte";
    import EmptyState from "@hearthlog/ui/components/EmptyState.svelte";
    import PageHeader from "@hearthlog/ui/components/PageHeader.svelte";
    import Button from "@hearthlog/ui/components/ui/Button.svelte";
    import Checkbox from "@hearthlog/ui/components/ui/Checkbox.svelte";
    import DateTimePicker from "@hearthlog/ui/components/ui/DateTimePicker.svelte";
    import Field from "@hearthlog/ui/components/ui/Field.svelte";
    import Input from "@hearthlog/ui/components/ui/Input.svelte";
    import Select from "@hearthlog/ui/components/ui/Select.svelte";
    import { untrack } from "svelte";
    import { contextualHref } from "@hearthlog/runtime/runtime/view.js";
    import IconChevronLeft from "~icons/mdi/chevron-left";
    import IconMagnify from "~icons/mdi/magnify";
    import IconPlus from "~icons/mdi/plus";

    let { data: routeData } = $props();
    const resource = $derived(routeData.pageResource);
    const data = $derived(resource.data);
    providePageResource(() => resource);
    const entityHref = (name: string) => contextualHref(`/entities/${name}`);

    let entityType = $derived(data.entityType as EntityTypeRecord);
    let fields = $derived(data.fields as DynamicFieldDefinition[]);
    let entities = $derived(data.entities as Record<string, unknown>[]);
    let referenceOptions = $derived(
        (data.referenceOptions ?? {}) as Record<
            string,
            Array<{ id: string; label: string }>
        >,
    );
    let referencedBy = $derived(
        (data.referencedBy ?? {}) as Record<string, ReferencedByResult>,
    );
    let totalRows = $derived((data.totalRows ?? 0) as number);
    let totalPages = $derived((data.totalPages ?? 1) as number);

    // Form state
    let isCreating = $state(false);
    let isEditing = $state<string | null>(null);
    let formData = $state<Record<string, unknown>>({});

    // Search state
    let searchQuery = $state("");

    // Confirmation dialog state
    let showDeleteConfirm = $state(false);
    let itemToDeleteId = $state<string | null>(null);

    // Sorting, pagination, search: single source of truth for header display
    // AND query, updated synchronously on user intent. The old split (URL
    // $state synced from data in an $effect) lagged a click by one load,
    // resetting TanStack headers to unsorted for a frame — the white flash.
    let sortState = $state<{ id: string | null; desc: boolean }>({
        id: null,
        desc: false,
    });

    // Pagination state
    let currentPage = $state(1);
    let pageSize = $state(20);
    let lastDataStateKey = "";

    // Stale-while-revalidate: a sort/page/search navigation creates a fresh
    // PageResource whose initial entities are []. Without a snapshot the table
    // would flash skeleton/empty. viewSnapshot lags one load behind by design,
    // mirroring DatabaseBrowser's viewPage. Declared before any derived that
    // reads it to avoid TDZ access.
    let viewSnapshot = $state<{
        entityType: EntityTypeRecord;
        entities: Record<string, unknown>[];
        fields: DynamicFieldDefinition[];
        referencedBy: Record<string, ReferencedByResult>;
        referenceOptions: Record<
            string,
            Array<{ id: string; label: string }>
        >;
        totalRows: number;
        totalPages: number;
    } | null>(null);
    $effect(() => {
        if (resource.loading) return;
        viewSnapshot = {
            entityType,
            entities,
            fields,
            referencedBy,
            referenceOptions,
            totalRows,
            totalPages,
        };
    });
    const isStale = $derived(resource.loading && viewSnapshot !== null);
    const effectiveEntities = $derived(
        isStale ? (viewSnapshot?.entities ?? []) : entities,
    );
    const effectiveFields = $derived(
        isStale ? (viewSnapshot?.fields ?? []) : fields,
    );
    const effectiveReferencedBy = $derived(
        isStale ? (viewSnapshot?.referencedBy ?? {}) : referencedBy,
    );
    const effectiveReferenceOptions = $derived(
        isStale ? (viewSnapshot?.referenceOptions ?? {}) : referenceOptions,
    );
    const effectiveTotalRows = $derived(
        isStale ? (viewSnapshot?.totalRows ?? 0) : totalRows,
    );
    const effectiveTotalPages = $derived(
        isStale ? (viewSnapshot?.totalPages ?? 1) : totalPages,
    );
    const effectiveEntityType = $derived(
        isStale ? (viewSnapshot?.entityType ?? entityType) : entityType,
    );
    let displayEntities = $derived(effectiveEntities);
    let referenceLabels = $derived.by(() => {
        const labels: Record<string, Record<string, string>> = {};
        for (const [fieldName, options] of Object.entries(
            effectiveReferenceOptions,
        )) {
            labels[fieldName] = Object.fromEntries(
                options.map((option) => [String(option.id), option.label]),
            );
        }
        return labels;
    });
    // Stable callbacks: read live reactive values lazily at render time via
    // untracked peeks, so creating them never subscribes the column
    // derivation below. Only the field signature drives rebuilds.
    const entityCallbacks = {
        getReferencedBy: (id: string) =>
            untrack(() => effectiveReferencedBy)[id] ?? null,
        getReferenceLabel: (fieldName: string, value: unknown) =>
            untrack(() => referenceLabels)[fieldName]?.[
                String(value ?? "")
            ] ?? null,
        entityHref,
        onEdit: (row: Record<string, unknown>) => startEdit(row),
        onDelete: (id: string) => void handleDelete(id),
    };
    // Memoize column defs by field signature. `fields` gets a fresh array
    // identity on every loader run (map/JSON.parse) even when the schema is
    // unchanged; rebuilding columns then makes TanStack tear down and remount
    // every header/cell — the white flash on sort. Cache lives in plain
    // (non-reactive) variables assigned inside $derived.by so re-reads stay
    // cheap and never feed back into the reactive graph.
    let cachedColumns: DataTableEntityColumn[] | null = null;
    let cachedFieldsKey = "";
    function entityFieldsKey(
        fieldList: DynamicFieldDefinition[],
    ): string {
        return fieldList
            .map((field) =>
                [
                    field.name,
                    field.type,
                    field.required ? "req" : "",
                    field.referenceTo ?? "",
                    field.enum?.join(",") ?? "",
                ].join(":"),
            )
            .join("\n");
    }
    let tableColumns = $derived.by(() => {
        const key = entityFieldsKey(effectiveFields);
        if (cachedColumns && key === cachedFieldsKey) {
            return cachedColumns;
        }
        cachedFieldsKey = key;
        cachedColumns = toEntityTableColumns(
            effectiveFields,
            entityCallbacks,
        );
        return cachedColumns;
    });
    let tableSorting = $derived(sortState);
    let tablePagination = $derived({
        pageIndex: currentPage - 1,
        pageSize,
        rowCount: effectiveTotalRows,
        pageCount: effectiveTotalPages,
    });
    const ENTITY_PAGE_SIZES = [10, 20, 50, 100] as const;
    let showingStart = $derived(
        effectiveTotalRows === 0
            ? 0
            : (currentPage - 1) * pageSize + 1,
    );
    let showingEnd = $derived(
        Math.min(currentPage * pageSize, effectiveTotalRows),
    );

    // Sync local UI state from the confirmed loader data. sortState is set
    // synchronously in selectSorting (user intent), so only overwrite it when
    // the loader actually confirms a *different* sort — never unconditionally,
    // or the header resets to unsorted for a frame (white flash).
    $effect(() => {
        if (resource.loading) return;
        const nextStateKey = JSON.stringify({
            search: data.search ?? "",
            sortField: data.sortField ?? null,
            sortDirection: data.sortDirection ?? "asc",
            currentPage: data.currentPage ?? 1,
            pageSize: data.pageSize ?? 20,
        });
        if (nextStateKey === lastDataStateKey) return;
        lastDataStateKey = nextStateKey;
        searchQuery = (data.search ?? "") as string;
        const confirmedSort = (data.sortField ?? null) as string | null;
        const confirmedDesc = (data.sortDirection ?? "asc") === "desc";
        // Loader-confirmed params are authoritative on navigation (back/forward,
        // cross-links); keep confirmed + intent in sync instead of comparing
        // against the intent-lagged snapshot key.
        const confirmedKey = JSON.stringify({
            id: confirmedSort,
            desc: confirmedSort ? confirmedDesc : false,
        });
        if (JSON.stringify(sortState) !== confirmedKey) {
            sortState = { id: confirmedSort, desc: confirmedDesc };
        }
        currentPage = (data.currentPage ?? 1) as number;
        pageSize = (data.pageSize ?? 20) as number;
    });

    $effect(() => {
        if (resource.loading) return;
        const trimmedSearch = searchQuery.trim();
        if (trimmedSearch === ((data.search ?? "") as string)) return;
        const timeout = setTimeout(() => {
            updateRouteQuery({
                search: trimmedSearch || null,
                page: null,
            });
        }, 250);
        return () => clearTimeout(timeout);
    });

    function updateRouteQuery(
        updates: Record<string, string | number | null>,
        replaceState = true,
    ) {
        const nextUrl = new URL(page.url);
        for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === "") {
                nextUrl.searchParams.delete(key);
            } else {
                nextUrl.searchParams.set(key, String(value));
            }
        }
        const nextQuery = nextUrl.searchParams.toString();
        const nextPath = `${nextUrl.pathname}${nextQuery ? `?${nextQuery}` : ""}${nextUrl.hash}`;
        const currentPath = `${page.url.pathname}${page.url.search}${page.url.hash}`;
        if (nextPath === currentPath) return;
        void goto(nextPath, {
            reset: false,
            replaceState,
        });
    }

    function setPage(pageNumber: number) {
        const nextPage = Math.min(
            Math.max(1, pageNumber),
            effectiveTotalPages,
        );
        currentPage = nextPage;
        updateRouteQuery({ page: nextPage <= 1 ? null : nextPage });
    }

    function setPageSize(nextPageSize: number) {
        pageSize = nextPageSize;
        currentPage = 1;
        updateRouteQuery({
            pageSize: nextPageSize === 20 ? null : nextPageSize,
            page: null,
        });
    }

    function selectSorting(sorting: { id: string | null; desc: boolean }) {
        const validColumn = sorting.id !== null &&
            fields.some((field) => field.name === sorting.id);
        sortState = validColumn ? sorting : { id: null, desc: false };
        currentPage = 1;
        updateRouteQuery({
            sort: validColumn ? sorting.id : null,
            direction: validColumn && sorting.desc ? "desc" : null,
            page: null,
        });
    }

    function resetForm() {
        formData = {};
        fields.forEach((f) => {
            if (f.default !== undefined) {
                formData[f.payloadKey] = f.default;
            }
        });
        isCreating = false;
        isEditing = null;
    }

    function startCreate() {
        resetForm();
        isCreating = true;
    }

    function startEdit(entity: Record<string, unknown>) {
        formData = {};
        fields.forEach((f) => {
            formData[f.payloadKey] = entity[f.name];
        });
        isEditing = entity.id as string;
    }

    function getEventPrefix(): string {
        return entityType.name.toUpperCase() + "_";
    }

    async function handleCreate() {
        const prefix = getEventPrefix();
        const entityId = crypto.randomUUID();

        await executeLocalCommand({
            id: crypto.randomUUID(),
            type: `${prefix}ADDED`,
            timestamp: Date.now(),
            payload: {
                id: entityId,
                ...formData,
            },
        } as any);

        await invalidate("app:entities");
        resetForm();
    }

    async function handleUpdate() {
        if (!isEditing) return;

        const prefix = getEventPrefix();

        await executeLocalCommand({
            id: crypto.randomUUID(),
            type: `${prefix}UPDATED`,
            timestamp: Date.now(),
            payload: {
                id: isEditing,
                ...formData,
            },
        } as any);

        await invalidate("app:entities");
        resetForm();
    }

    async function handleDelete(entityId: string) {
        itemToDeleteId = entityId;
        showDeleteConfirm = true;
    }

    async function executeDelete() {
        if (!itemToDeleteId) return;
        const entityId = itemToDeleteId;
        showDeleteConfirm = false;
        itemToDeleteId = null;

        const prefix = getEventPrefix();

        await executeLocalCommand({
            id: crypto.randomUUID(),
            type: `${prefix}REMOVED`,
            timestamp: Date.now(),
            payload: {
                id: entityId,
            },
        } as any);

        await invalidate("app:entities");
    }

    function getInputType(fieldType: string): string {
        switch (fieldType) {
            case "number":
                return "number";
            case "boolean":
                return "checkbox";
            case "datetime":
                return "datetime-local";
            default:
                return "text";
        }
    }

    function formatDatetimeForInput(value: unknown): string {
        if (!value) return "";
        const rawValue = String(value).trim();
        const localDateTime = rawValue.match(
            /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/,
        );
        if (localDateTime) {
            return `${localDateTime[1]}T${localDateTime[2]}`;
        }

        try {
            const date = new Date(value as string);
            if (Number.isNaN(date.getTime())) return "";
            return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
        } catch {
            return "";
        }
    }
</script>

<svelte:head>
    <title>{effectiveEntityType.display_name} | Entities | stor</title>
</svelte:head>

<PageDataStatus {resource} />


<div class="flex h-full flex-col overflow-hidden bg-[var(--stor-bg)]">
    <div class="shrink-0 px-3 pt-4 pb-2">
        <a
            href={contextualHref("/entities")}
            class="inline-flex items-center gap-1 text-xs font-medium text-[var(--stor-muted-text)] transition hover:text-[var(--stor-ink)]"
        >
            <IconChevronLeft class="h-3.5 w-3.5" /> Entity types
        </a>
        {#snippet recordCount()}
            <DataValue>{effectiveTotalRows}</DataValue>
            <DataValue>{effectiveTotalRows === 1 ? " record" : " records"}</DataValue>
        {/snippet}
        <PageHeader title={effectiveEntityType.display_name} context={recordCount} showTitle class="mt-1">
                <label class="relative min-w-0">
                    <span class="sr-only">Search records</span>
                    <IconMagnify class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--stor-muted-text)]" />
                    <Input placeholder="Search records..." bind:value={searchQuery} class="pl-9 md:w-64" />
                </label>

                <CommandOnly>
                    <Button onclick={startCreate}>
                        <IconPlus class="h-4 w-4" />
                        <span class="hidden sm:inline">Add {effectiveEntityType.display_name}</span>
                        <span class="sm:hidden">Add</span>
                    </Button>
                </CommandOnly>
        </PageHeader>
    </div>

    <!-- Data Content -->
    <div class="flex-1 overflow-auto p-3">
        <div class="w-full">
                <div
                    class="stor-panel overflow-hidden"
                >
                    <div
                        class:opacity-60={isStale}
                        class:transition-opacity={isStale}
                        aria-busy={isStale || undefined}
                    >
                    {#snippet emptyAddRecord()}
                        <EmptyState
                            title={searchQuery.trim()
                                ? "No records found"
                                : "No records yet"}
                            description={searchQuery.trim()
                                ? `No ${effectiveEntityType.display_name.toLowerCase()} records match this search.`
                                : `Add the first ${effectiveEntityType.display_name.toLowerCase()} record to this collection.`}
                        >
                            {#if !searchQuery.trim()}
                                <CommandOnly>
                                    <button
                                        onclick={startCreate}
                                        class="rounded-lg bg-[var(--stor-action)] px-4 py-2.5 text-sm font-semibold text-[var(--stor-action-text)] transition hover:bg-[var(--stor-action-hover)]"
                                    >
                                        Add {effectiveEntityType.display_name}
                                    </button>
                                </CommandOnly>
                            {/if}
                        </EmptyState>
                    {/snippet}
                    <DataTable
                        columns={tableColumns}
                        data={displayEntities}
                        pagination={tablePagination}
                        sorting={tableSorting}
                        onSortingChange={selectSorting}
                        isLoading={resource.loading && !isStale}
                        emptyContent={emptyAddRecord}
                        testId="entity-table"
                        scrollTestId="entity-table-scroll"
                    />
                    </div>

                    <DataTablePagination
                        currentPage={currentPage}
                        totalPages={effectiveTotalPages}
                        totalRows={effectiveTotalRows}
                        pageSize={pageSize}
                        pageSizes={ENTITY_PAGE_SIZES}
                        showingStart={showingStart}
                        showingEnd={showingEnd}
                        onSelectPage={setPage}
                        onSelectPageSize={setPageSize}
                    />
                </div>
        </div>
    </div>
</div>

<CommandDrawer
    show={!!(isCreating || isEditing)}
    title={isEditing ? "Edit record" : `Add ${effectiveEntityType.display_name}`}
    description={isEditing
        ? "Update this record without leaving the collection."
        : `Create a new ${effectiveEntityType.display_name.toLowerCase()} record.`}
    onClose={resetForm}
>
    <div class="space-y-5">
        <div class="grid grid-cols-1 gap-4">
            {#each effectiveFields as field}
                {@const fieldId = `entity-field-${field.payloadKey}`}
                <Field
                    label={field.name}
                    htmlFor={fieldId}
                    required={field.required}
                >
                    {#if field.type === "boolean"}
                        <div
                            class="flex items-center rounded-lg border border-[var(--stor-border)] bg-[var(--stor-surface)] p-3"
                        >
                            <Checkbox
                                id={fieldId}
                                checked={Boolean(formData[field.payloadKey])}
                                onCheckedChange={(checked) =>
                                    (formData[field.payloadKey] = checked)}
                            />
                            <span
                                class="ml-3 text-sm text-[var(--stor-muted-text)]"
                                >Active / Enabled</span
                            >
                        </div>
                    {:else if field.type === "reference" && effectiveReferenceOptions[field.name]}
                        <Select
                            id={fieldId}
                            name={fieldId}
                            value={String(formData[field.payloadKey] ?? "")}
                            onValueChange={(value: string) =>
                                (formData[field.payloadKey] = value)}
                            placeholder={`Select ${field.referenceTo}...`}
                            options={[
                                {
                                    value: "",
                                    label: `Select ${field.referenceTo}...`,
                                },
                                ...effectiveReferenceOptions[field.name].map((opt) => ({
                                    value: String(opt.id),
                                    label: opt.label,
                                })),
                            ]}
                        />
                    {:else if field.enum && field.enum.length > 0}
                        <Select
                            id={fieldId}
                            name={fieldId}
                            value={String(formData[field.payloadKey] ?? "")}
                            onValueChange={(value: string) =>
                                (formData[field.payloadKey] = value)}
                            placeholder="Select option..."
                            options={[
                                { value: "", label: "Select option..." },
                                ...field.enum.map((option) => ({
                                    value: option,
                                    label: option,
                                })),
                            ]}
                        />
                    {:else if field.type === "datetime"}
                        <DateTimePicker
                            id={fieldId}
                            value={formatDatetimeForInput(
                                formData[field.payloadKey],
                            )}
                            onValueChange={(value: string) =>
                                (formData[field.payloadKey] = value)}
                            placeholder={`Choose ${field.name.toLowerCase()}...`}
                        />
                    {:else}
                        <Input
                            id={fieldId}
                            type={getInputType(field.type)}
                            bind:value={formData[field.payloadKey]}
                            placeholder={`Enter ${field.name.toLowerCase()}...`}
                        />
                    {/if}
                </Field>
            {/each}
        </div>


    </div>
{#snippet footer()}
            <Button
                onclick={resetForm}
                variant="secondary"
                size="sm"
            >
                Cancel
            </Button>
            <Button
                onclick={isEditing ? handleUpdate : handleCreate}
            >
                {isEditing ? "Save changes" : "Add record"}
            </Button>
        {/snippet}
</CommandDrawer>

<CommandConfirmDialog
    show={showDeleteConfirm}
    title="Delete Item"
    message="Are you sure you want to delete this item? This action cannot be undone."
    onConfirm={executeDelete}
    onCancel={() => (showDeleteConfirm = false)}
/>

<style>
    /* Custom scrollbar */
    ::-webkit-scrollbar {
        width: 8px;
    }
    ::-webkit-scrollbar-track {
        background: transparent;
    }
    ::-webkit-scrollbar-thumb {
        background: #e7e5e4;
        border-radius: 10px;
    }
</style>
