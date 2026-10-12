<script lang="ts">
    import Select from "../ui/Select.svelte";
    import IconChevronDoubleLeft from "~icons/mdi/chevron-double-left";
    import IconChevronDoubleRight from "~icons/mdi/chevron-double-right";
    import IconChevronLeft from "~icons/mdi/chevron-left";
    import IconChevronRight from "~icons/mdi/chevron-right";

    let {
        currentPage,
        totalPages,
        totalRows,
        pageSize,
        pageSizes,
        showingStart,
        showingEnd,
        onSelectPage,
        onSelectPageSize,
    }: {
        currentPage: number;
        totalPages: number;
        totalRows: number;
        pageSize: number;
        pageSizes: readonly number[];
        showingStart: number;
        showingEnd: number;
        onSelectPage: (page: number) => void;
        onSelectPageSize: (pageSize: number) => void;
    } = $props();
</script>

<footer
    class="flex flex-col gap-3 border-t border-[var(--stor-border)] bg-[var(--stor-surface-muted)]/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
>
    <div class="flex flex-wrap items-center gap-3 text-xs text-[var(--stor-muted-text)]">
        <span>
            Showing {showingStart}–{showingEnd} of
            {totalRows}
        </span>
        <label class="flex items-center gap-1.5">
            <span>Rows</span>
            <Select ariaLabel="Rows per page" value={String(pageSize)} options={pageSizes.map((size) => ({ value: String(size), label: String(size) }))} onValueChange={(value) => onSelectPageSize(Number(value))} class="w-20" />
        </label>
    </div>

    <div class="flex items-center gap-1">
        <button
            type="button"
            class="rounded-lg p-1.5 text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-surface)] hover:text-[var(--stor-ink)] disabled:opacity-30"
            aria-label="First page"
            title="First page"
            disabled={currentPage === 1}
            onclick={() => onSelectPage(1)}
        >
            <IconChevronDoubleLeft class="h-4 w-4" />
        </button>
        <button
            type="button"
            class="rounded-lg p-1.5 text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-surface)] hover:text-[var(--stor-ink)] disabled:opacity-30"
            aria-label="Previous page"
            title="Previous page"
            disabled={currentPage === 1}
            onclick={() => onSelectPage(currentPage - 1)}
        >
            <IconChevronLeft class="h-4 w-4" />
        </button>
        <span class="min-w-24 text-center text-xs font-medium text-[var(--stor-muted-text)]">
            Page {currentPage} of
            {totalPages}
        </span>
        <button
            type="button"
            class="rounded-lg p-1.5 text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-surface)] hover:text-[var(--stor-ink)] disabled:opacity-30"
            aria-label="Next page"
            title="Next page"
            disabled={currentPage === totalPages}
            onclick={() => onSelectPage(currentPage + 1)}
        >
            <IconChevronRight class="h-4 w-4" />
        </button>
        <button
            type="button"
            class="rounded-lg p-1.5 text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-surface)] hover:text-[var(--stor-ink)] disabled:opacity-30"
            aria-label="Last page"
            title="Last page"
            disabled={currentPage === totalPages}
            onclick={() => onSelectPage(totalPages)}
        >
            <IconChevronDoubleRight class="h-4 w-4" />
        </button>
    </div>
</footer>
