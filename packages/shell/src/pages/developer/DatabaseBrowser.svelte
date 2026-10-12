<script lang="ts">
    import { refreshPageData } from "@hearthlog/runtime/runtime/refresh.js";
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import EmptyState from "@hearthlog/ui/components/EmptyState.svelte";
    import DataTable from "@hearthlog/ui/components/data-table/DataTable.svelte";
    import DataTablePagination from "@hearthlog/ui/components/data-table/DataTablePagination.svelte";
    import { toSqliteTableColumns } from "@hearthlog/shell/components/data-table/sqlite-columns.js";
    import {
        DEFAULT_RAW_SQLITE_PAGE_SIZE,
        parseRawSqlitePage,
        parseRawSqlitePageSize,
        parseRawSqliteSortDirection,
        parseRawSqliteSortField,
        RAW_SQLITE_PAGE_SIZES,
        type RawSqliteTablePage,
    } from "@hearthlog/runtime/db/raw-browser.js";
    import IconDatabaseOutline from "~icons/mdi/database-outline";
    import IconRefresh from "~icons/mdi/refresh";

    let { databasePage = null, isLoading = false }: { databasePage?: RawSqliteTablePage | null; isLoading?: boolean } = $props();
    // Stale-while-revalidate: keep the last loaded page on screen while the
    // next table/sort/page loads, so switching tables or sorting never
    // flashes a blank spinner. `viewPage` lags one load behind by design.
    let viewPage = $state<RawSqliteTablePage | null>(null);
    $effect(() => {
        if (databasePage) viewPage = databasePage;
    });
    const effectivePage = $derived(viewPage ?? databasePage);
    const isStale = $derived(
        isLoading && viewPage !== null && viewPage !== databasePage,
    );
    const tableColumns = $derived(
        effectivePage ? toSqliteTableColumns(effectivePage.columns) : [],
    );
    const tableSorting = $derived(
        effectivePage?.sortField
            ? {
                id: effectivePage.sortField,
                desc: effectivePage.sortDirection === "desc",
            }
            : { id: null, desc: false },
    );
    const tablePagination = $derived(
        effectivePage
            ? {
                pageIndex: effectivePage.currentPage - 1,
                pageSize: effectivePage.pageSize,
                rowCount: effectivePage.totalRows,
                pageCount: effectivePage.totalPages,
            }
            : { pageIndex: 0, pageSize: DEFAULT_RAW_SQLITE_PAGE_SIZE, rowCount: 0, pageCount: 1 },
    );
    const showingStart = $derived(
        effectivePage && effectivePage.totalRows > 0
            ? (effectivePage.currentPage - 1) * effectivePage.pageSize + 1
            : 0,
    );
    const showingEnd = $derived(
        effectivePage
            ? Math.min(
                effectivePage.currentPage * effectivePage.pageSize,
                effectivePage.totalRows,
            )
            : 0,
    );

    $effect(() => {
        if (!databasePage || isLoading) return;
        const url = page.url.searchParams;
        if (databasePage.tableName !== url.get('table') ||
            databasePage.currentPage !== parseRawSqlitePage(url.get('page')) ||
            databasePage.pageSize !== parseRawSqlitePageSize(url.get('pageSize')) ||
            (databasePage.sortField ?? null) !== parseRawSqliteSortField(url.get('sort')) ||
            databasePage.sortDirection !== parseRawSqliteSortDirection(url.get('direction'))) {
            void updateDatabaseUrl({
                table: databasePage.tableName,
                page: databasePage.currentPage > 1 ? databasePage.currentPage : null,
                pageSize: databasePage.pageSize === DEFAULT_RAW_SQLITE_PAGE_SIZE ? null : databasePage.pageSize,
                sort: databasePage.sortField,
                direction: databasePage.sortField && databasePage.sortDirection === 'desc' ? 'desc' : null,
            }, true);
        }
    });

    function selectTable(tableName: string): void {
        void updateDatabaseUrl({
            table: tableName,
            page: null,
            sort: null,
            direction: null,
        });
    }

    function selectPage(pageNumber: number): void {
        if (!effectivePage) return;
        const nextPage = Math.min(
            Math.max(1, pageNumber),
            effectivePage.totalPages,
        );
        void updateDatabaseUrl({
            page: nextPage > 1 ? nextPage : null,
        });
    }

    function selectPageSize(pageSize: number): void {
        void updateDatabaseUrl({
            page: null,
            pageSize:
                pageSize === DEFAULT_RAW_SQLITE_PAGE_SIZE ? null : pageSize,
        });
    }

    function selectSorting(sorting: { id: string | null; desc: boolean }): void {
        if (!effectivePage) return;
        // TanStack already validated the id against live column defs; only
        // accept it when it still exists on the visible page.
        const validColumn = sorting.id !== null
            && effectivePage.columns.some((column) => column.name === sorting.id);
        void updateDatabaseUrl({
            sort: validColumn ? sorting.id : null,
            direction: validColumn && sorting.desc ? "desc" : null,
            page: null,
        });
    }

    function refresh(): void {
        if (isLoading) return;
        void refreshPageData("app:developer").catch(error => console.warn("[Database] Refresh failed", error));
    }

    async function updateDatabaseUrl(
        updates: {
            table?: string | null;
            page?: string | number | null;
            pageSize?: string | number | null;
            sort?: string | null;
            direction?: string | null;
        },
        replaceState = false,
    ): Promise<void> {
        const nextUrl = new URL(page.url);
        nextUrl.searchParams.set("tab", "database");

        for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === "") {
                nextUrl.searchParams.delete(key);
            } else if (value !== undefined) {
                nextUrl.searchParams.set(key, String(value));
            }
        }

        const nextPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
        const currentPath = `${page.url.pathname}${page.url.search}${page.url.hash}`;
        if (nextPath === currentPath) return;

        await goto(nextPath, {
            reset: false,
            replaceState,
        });
    }
</script>

<section
    class="mt-4 min-w-0 lg:mt-6"
    aria-labelledby="raw-database-heading"
    data-testid="database-browser"
>
    <div class="stor-panel overflow-hidden">
        <header class="flex flex-col gap-3 border-b border-[var(--stor-border)] px-[var(--stor-panel-padding)] py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
                <div class="flex items-center gap-2">
                    <IconDatabaseOutline class="h-5 w-5 text-[var(--stor-muted-text)]" />
                    <h2
                        id="raw-database-heading"
                        class="text-base font-semibold text-stone-900"
                    >
                        Local SQLite
                    </h2>
                </div>
                <p class="mt-1 text-sm text-[var(--stor-muted-text)]">
                    Read-only access to this tenant's projected tables in this browser.
                </p>
            </div>
            <button
                type="button"
                class="inline-flex items-center justify-center gap-2 self-start rounded-lg bg-[var(--stor-surface-muted)] px-3 py-2 text-sm font-semibold text-stone-700 transition hover:bg-[var(--stor-surface-hover)] disabled:opacity-50 sm:self-auto"
                onclick={refresh}
                disabled={isLoading && !databasePage}
                aria-disabled={isLoading}
            >
                <IconRefresh class="h-4 w-4 {isLoading ? 'animate-spin' : ''}" />
                Refresh
            </button>
        </header>

        {#if isLoading && !effectivePage}
            <div class="flex min-h-64 items-center justify-center p-8">
                <div class="text-center text-sm text-[var(--stor-muted-text)]">
                    <IconRefresh class="mx-auto h-6 w-6 animate-spin" />
                    <p class="mt-2">Reading local SQLite…</p>
                </div>
            </div>
        {:else if effectivePage && effectivePage.tables.length === 0}
            <div class="p-[var(--stor-panel-padding)]">
                <EmptyState
                    title="No local tables"
                    description="The local SQLite database does not contain any application tables."
                />
            </div>
        {:else if effectivePage}
            <div class="border-b border-[var(--stor-border)] px-[var(--stor-panel-padding)] py-3 md:hidden">
                <label
                    for="raw-sqlite-table-select"
                    class="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]"
                >
                    Table
                </label>
                <select
                    id="raw-sqlite-table-select"
                    value={effectivePage.tableName ?? ""}
                    onchange={(event) =>
                        selectTable(
                            (event.currentTarget as HTMLSelectElement).value,
                        )}
                    class="mt-1.5 block w-full rounded-lg border border-[var(--stor-field-border)] bg-white px-3 py-2.5 font-mono text-sm text-stone-900 outline-none focus:border-[var(--stor-focus)] focus:ring-2 focus:ring-[var(--stor-selected)]"
                >
                    {#each effectivePage.tables as table}
                        <option value={table.name}>{table.name}</option>
                    {/each}
                </select>
            </div>

            <div class="grid min-w-0 md:grid-cols-[15rem_minmax(0,1fr)]">
                <aside
                    class="hidden border-r border-[var(--stor-border)] bg-[var(--stor-surface-muted)]/60 p-3 md:block"
                    aria-label="SQLite tables"
                >
                    <div class="px-2 pb-2 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">
                        Tables
                    </div>
                    <nav class="max-h-[calc(100vh-16rem)] space-y-1 overflow-y-auto">
                        {#each effectivePage.tables as table}
                            <button
                                type="button"
                                class="block w-full truncate rounded-lg px-2 py-2 text-left font-mono text-sm transition {table.name ===
                                effectivePage.tableName
                                    ? 'bg-[var(--stor-accent-soft)] font-semibold text-[var(--stor-accent-strong)]'
                                    : 'text-stone-600 hover:bg-white hover:text-stone-950'}"
                                aria-current={table.name ===
                                effectivePage.tableName
                                    ? "page"
                                    : undefined}
                                title={table.name}
                                onclick={() => selectTable(table.name)}
                            >
                                {table.name}
                            </button>
                        {/each}
                    </nav>
                </aside>

                <div class="min-w-0">
                    <div class="flex flex-col gap-3 border-b border-[var(--stor-border)] px-[var(--stor-panel-padding)] py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div class="min-w-0">
                            <h3 class="truncate font-mono text-sm font-semibold text-stone-950">
                                {effectivePage.tableName}
                            </h3>
                            <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
                                {effectivePage.totalRows}
                                {effectivePage.totalRows === 1 ? " row" : " rows"}
                                · {effectivePage.columns.length}
                                {effectivePage.columns.length === 1
                                    ? " column"
                                    : " columns"}
                            </p>
                        </div>
                        {#if isLoading}
                            <div class="flex items-center gap-2 text-xs font-medium text-[var(--stor-muted-text)]">
                                <IconRefresh class="h-3.5 w-3.5 animate-spin" />
                                Updating
                            </div>
                        {/if}
                    </div>

                    <div class:opacity-60={isStale} class:transition-opacity={isStale} aria-busy={isStale || undefined}>
                    {#if effectivePage.rows.length === 0 && !isStale}
                        <div class="p-[var(--stor-panel-padding)]">
                            <EmptyState
                                title="Table is empty"
                                description={`${effectivePage.tableName} has no rows.`}
                            />
                        </div>
                    {:else}
                        <DataTable
                            columns={tableColumns}
                            data={effectivePage.rows}
                            pagination={tablePagination}
                            sorting={tableSorting}
                            onSortingChange={selectSorting}
                            isLoading={isLoading && !isStale}
                            emptyTitle="Table is empty"
                            emptyDescription={`${effectivePage.tableName} has no rows.`}
                            testId="raw-sqlite-table"
                            scrollTestId="raw-sqlite-table-scroll"
                        />
                    {/if}
                    </div>

                    <DataTablePagination
                        currentPage={effectivePage.currentPage}
                        totalPages={effectivePage.totalPages}
                        totalRows={effectivePage.totalRows}
                        pageSize={effectivePage.pageSize}
                        pageSizes={RAW_SQLITE_PAGE_SIZES}
                        showingStart={showingStart}
                        showingEnd={showingEnd}
                        onSelectPage={selectPage}
                        onSelectPageSize={selectPageSize}
                    />
                </div>
            </div>
        {/if}
    </div>
</section>
