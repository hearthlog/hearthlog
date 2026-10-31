<script lang="ts">
    import { timeTravel } from '../../utils/time-travel.js';
    import { registerTimeNavigation } from '../../state/time-navigation.js';
    import { Dialog, Popover } from 'bits-ui';
    import IconArrowLeft from '~icons/mdi/arrow-left';
    import IconArrowRight from '~icons/mdi/arrow-right';
    import IconChevronDown from '~icons/mdi/chevron-down';
    import IconClose from '~icons/mdi/close';

    let {
        year,
        month,
        currentYear,
        currentMonth,
        subtitle = '',
        compact = false,
        phoneArrows = true,
        slide = true,
        hrefForMonth,
        onNavigate,
        class: className = '',
    }: {
        year: number;
        month: number;
        currentYear: number;
        currentMonth: number;
        subtitle?: string;
        compact?: boolean;
        /** Off where a list already scrolls through the months: phones then keep only the month picker. */
        phoneArrows?: boolean;
        /** Off where the page scrolls to the month itself: the sideways page slide would fight that scroll. */
        slide?: boolean;
        hrefForMonth?: (year: number, month: number) => string;
        onNavigate: (year: number, month: number) => void | Promise<void>;
        class?: string;
    } = $props();

    const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
    ];
    let desktopOpen = $state(false);
    let mobileOpen = $state(false);
    let pickerYear = $state(0);
    let choosingYear = $state(false);
    const monthLabel = $derived(`${monthNames[month - 1]} ${year}`);
    const isCurrentMonth = $derived(year === currentYear && month === currentMonth);
    const previous = $derived(shiftMonth(-1));
    const next = $derived(shiftMonth(1));
    const firstYear = $derived(Math.floor(pickerYear / 12) * 12);
    // Phones have no room for Today in the month row and a second row would push the page down, so it
    // stays off there: the lists below float their own Today, and the month picker offers the current month.
    const todayActionClass = 'max-sm:hidden col-span-3 col-start-1 row-start-2 flex h-11 items-center justify-center justify-self-end rounded-xl px-3 text-sm font-semibold text-[var(--stor-accent-strong)] hover:bg-[var(--stor-accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] sm:col-span-1 sm:row-start-1 sm:w-20 sm:justify-self-stretch sm:bg-[var(--stor-surface-raised)] sm:shadow-[var(--stor-shadow-sm)]';

    function shiftMonth(amount: number): { year: number; month: number } {
        const date = new Date(year, month - 1 + amount, 1);
        return { year: date.getFullYear(), month: date.getMonth() + 1 };
    }

    function setOpen(kind: 'desktop' | 'mobile', open: boolean): void {
        if (kind === 'desktop') desktopOpen = open;
        else mobileOpen = open;
        if (open) {
            pickerYear = year;
            choosingYear = false;
        }
    }

    // The keyboard: ← and → step the month, T returns to the current one (see state/time-navigation).
    $effect(() => registerTimeNavigation({
        previous: () => navigateTo(previous.year, previous.month),
        next: () => navigateTo(next.year, next.month),
        today: () => { if (!isCurrentMonth) navigateTo(currentYear, currentMonth); },
    }));

    function navigateTo(targetYear: number, targetMonth: number): void {
        desktopOpen = false;
        mobileOpen = false;
        const direction = targetYear * 12 + targetMonth >= year * 12 + month ? 1 : -1;
        if (!slide) {
            void onNavigate(targetYear, targetMonth);
            return;
        }
        void timeTravel(direction, () => onNavigate(targetYear, targetMonth));
    }
</script>

{#snippet pickerContent()}
    <div data-month-picker>
        <div class="flex items-center justify-between gap-3">
            <button
                type="button"
                class="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-surface-hover)] hover:text-[var(--stor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
                aria-label={choosingYear ? 'Previous 12 years' : 'Previous year'}
                onclick={() => pickerYear -= choosingYear ? 12 : 1}
            ><IconArrowLeft class="h-5 w-5" /></button>
            <button
                type="button"
                class="flex h-11 items-center gap-1 rounded-xl px-3 text-lg font-semibold tabular-nums text-[var(--stor-ink)] transition hover:bg-[var(--stor-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
                aria-label={`Choose year, ${pickerYear}`}
                aria-expanded={choosingYear}
                onclick={() => choosingYear = !choosingYear}
            >{pickerYear}<IconChevronDown class="h-4 w-4" /></button>
            <button
                type="button"
                class="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-surface-hover)] hover:text-[var(--stor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
                aria-label={choosingYear ? 'Next 12 years' : 'Next year'}
                onclick={() => pickerYear += choosingYear ? 12 : 1}
            ><IconArrowRight class="h-5 w-5" /></button>
        </div>

        <div class="mt-3 grid grid-cols-3 gap-2" aria-label={choosingYear ? 'Years' : 'Months'}>
            {#if choosingYear}
                {#each Array.from({ length: 12 }, (_, index) => firstYear + index) as optionYear}
                    <button
                        type="button"
                        class="flex h-11 items-center justify-center rounded-xl text-sm font-semibold tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] {optionYear === year ? 'bg-[var(--stor-action)] text-[var(--stor-action-text)]' : 'bg-[var(--stor-surface-muted)] text-[var(--stor-ink)] hover:bg-[var(--stor-surface-hover)]'}"
                        aria-pressed={optionYear === year}
                        onclick={() => { pickerYear = optionYear; choosingYear = false; }}
                    >{optionYear}</button>
                {/each}
            {:else}
                {#each monthNames as name, index}
                    {@const optionMonth = index + 1}
                    {@const selected = pickerYear === year && optionMonth === month}
                    {@const current = pickerYear === currentYear && optionMonth === currentMonth}
                    <button
                        type="button"
                        class="relative flex h-11 items-center justify-center rounded-xl text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] {selected ? 'bg-[var(--stor-action)] text-[var(--stor-action-text)]' : 'bg-[var(--stor-surface-muted)] text-[var(--stor-ink)] hover:bg-[var(--stor-surface-hover)]'} {current && !selected ? 'ring-1 ring-inset ring-[var(--stor-accent)]' : ''}"
                        aria-label={`${name} ${pickerYear}${current ? ', current month' : ''}`}
                        aria-pressed={selected}
                        onclick={() => navigateTo(pickerYear, optionMonth)}
                    >{name.slice(0, 3)}</button>
                {/each}
            {/if}
        </div>

        {#if !isCurrentMonth}
            <button
                type="button"
                class="mt-3 flex h-11 w-full items-center justify-center rounded-xl text-sm font-semibold text-[var(--stor-accent-strong)] transition hover:bg-[var(--stor-accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
                onclick={() => navigateTo(currentYear, currentMonth)}
            >Go to current month</button>
        {:else}
            <div class="mt-3 h-11" aria-hidden="true"></div>
        {/if}
    </div>
{/snippet}

<section data-month-navigation class="grid w-full grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-x-2 gap-y-1 {compact ? 'sm:grid-cols-[2.75rem_13rem_2.75rem_5rem] sm:justify-start' : 'sm:grid-cols-[minmax(0,1fr)_2.75rem_5rem_2.75rem]'} {phoneArrows ? '' : 'max-sm:flex max-sm:w-auto'} {className}" aria-label="Month navigation">
    <div class="col-start-2 row-start-1 min-w-0 text-center {phoneArrows ? '' : 'max-sm:text-left'} {compact ? 'sm:col-start-2 sm:text-center' : 'sm:col-start-1 sm:text-left'}">
        <h2 class="stor-serif-title text-lg text-[var(--stor-ink)] sm:text-[22px]">
            <Popover.Root open={desktopOpen} onOpenChange={(open) => setOpen('desktop', open)}>
                <Popover.Trigger
                    class="hidden min-h-11 max-w-full items-center gap-1.5 rounded-xl px-1 text-left transition hover:bg-[var(--stor-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] sm:inline-flex"
                    aria-label={`Choose month, ${monthLabel}`}
                    aria-expanded={desktopOpen}
                ><span class="truncate">{monthLabel}</span><IconChevronDown class="h-4 w-4 shrink-0" /></Popover.Trigger>
                <Popover.Portal>
                    <Popover.Content side="bottom" align="start" sideOffset={8} class="stor-menu z-[var(--stor-layer-sheet)] hidden w-72 p-3 outline-none sm:block">
                        <p class="sr-only">Choose month</p>
                        {@render pickerContent()}
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>

            <Dialog.Root open={mobileOpen} onOpenChange={(open) => setOpen('mobile', open)}>
                <Dialog.Trigger
                    class="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-xl px-1 transition hover:bg-[var(--stor-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] sm:hidden"
                    aria-label={`Choose month, ${monthLabel}`}
                    aria-expanded={mobileOpen}
                ><span class="truncate">{monthLabel}</span><IconChevronDown class="h-4 w-4 shrink-0" /></Dialog.Trigger>
                <Dialog.Portal>
                    <Dialog.Overlay class="fixed inset-0 z-[var(--stor-layer-sheet)] bg-[var(--stor-overlay)] sm:hidden" />
                    <Dialog.Content class="stor-sheet fixed inset-x-0 bottom-0 z-[var(--stor-layer-sheet-content)] max-h-[calc(100dvh-env(safe-area-inset-top))] overflow-y-auto rounded-t-3xl px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] outline-none sm:hidden">
                        <div class="mx-auto mb-4 h-1 w-10 rounded-full bg-[var(--stor-border)]" aria-hidden="true"></div>
                        <div class="mb-2 flex items-center justify-between">
                            <Dialog.Title level={3} class="text-xl font-semibold text-[var(--stor-ink)]">Choose month</Dialog.Title>
                            <Dialog.Close class="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--stor-muted-text)] hover:bg-[var(--stor-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]" aria-label="Close month picker"><IconClose class="h-5 w-5" /></Dialog.Close>
                        </div>
                        {@render pickerContent()}
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </h2>
        <!-- A phone keeps the row to the month alone; the page repeats the figure lower down. -->
        {#if subtitle}<p class="mt-0.5 text-sm leading-5 text-[var(--stor-muted-text)] max-sm:hidden">{subtitle}</p>{/if}
    </div>

    {#if hrefForMonth}
        <a href={hrefForMonth(previous.year, previous.month)} class="{phoneArrows ? '' : 'max-sm:hidden'} col-start-1 row-start-1 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--stor-surface-raised)] text-[var(--stor-muted-text)] shadow-[var(--stor-shadow-sm)] transition hover:bg-[var(--stor-surface-hover)] hover:text-[var(--stor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] {compact ? 'sm:col-start-1' : 'sm:col-start-2'}" aria-label="Previous month" title="Previous month (←)" aria-keyshortcuts="ArrowLeft"><IconArrowLeft class="h-5 w-5" /></a>
    {:else}
        <button type="button" onclick={() => navigateTo(previous.year, previous.month)} class="{phoneArrows ? '' : 'max-sm:hidden'} col-start-1 row-start-1 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--stor-surface-raised)] text-[var(--stor-muted-text)] shadow-[var(--stor-shadow-sm)] transition hover:bg-[var(--stor-surface-hover)] hover:text-[var(--stor-ink)] {compact ? 'sm:col-start-1' : 'sm:col-start-2'} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]" aria-label="Previous month" title="Previous month (←)" aria-keyshortcuts="ArrowLeft"><IconArrowLeft class="h-5 w-5" /></button>
    {/if}

    {#if !isCurrentMonth}
        {#if hrefForMonth}
            <a href={hrefForMonth(currentYear, currentMonth)} class={`${todayActionClass} ${compact ? 'sm:col-start-4' : 'sm:col-start-3'}`} aria-label="Go to current month" title="Today (T)" aria-keyshortcuts="t">Today</a>
        {:else}
            <button type="button" onclick={() => navigateTo(currentYear, currentMonth)} class={`${todayActionClass} ${compact ? 'sm:col-start-4' : 'sm:col-start-3'}`} aria-label="Go to current month" title="Today (T)" aria-keyshortcuts="t">Today</button>
        {/if}
    {:else}
        <span class={`${todayActionClass} ${compact ? 'sm:col-start-4' : 'sm:col-start-3'} invisible`} aria-hidden="true">Today</span>
    {/if}

    {#if hrefForMonth}
        <a href={hrefForMonth(next.year, next.month)} class="{phoneArrows ? '' : 'max-sm:hidden'} col-start-3 row-start-1 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--stor-surface-raised)] text-[var(--stor-muted-text)] shadow-[var(--stor-shadow-sm)] transition hover:bg-[var(--stor-surface-hover)] hover:text-[var(--stor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] {compact ? 'sm:col-start-3' : 'sm:col-start-4'}" aria-label="Next month" title="Next month (→)" aria-keyshortcuts="ArrowRight"><IconArrowRight class="h-5 w-5" /></a>
    {:else}
        <button type="button" onclick={() => navigateTo(next.year, next.month)} class="{phoneArrows ? '' : 'max-sm:hidden'} col-start-3 row-start-1 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--stor-surface-raised)] text-[var(--stor-muted-text)] shadow-[var(--stor-shadow-sm)] transition hover:bg-[var(--stor-surface-hover)] hover:text-[var(--stor-ink)] {compact ? 'sm:col-start-3' : 'sm:col-start-4'} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]" aria-label="Next month" title="Next month (→)" aria-keyshortcuts="ArrowRight"><IconArrowRight class="h-5 w-5" /></button>
    {/if}
</section>
