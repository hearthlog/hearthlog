<script lang="ts">
    import { format as formatDay } from "date-fns";
    import DataPlaceholder from "@hearthlog/ui/components/data/DataPlaceholder.svelte";
    import { calendarSourcePresentation } from "@hearthlog/contracts/calendar/sources";
    import { summarizeWorkingMonth } from "@hearthlog/czech";
    import type { CalendarSourceCounts } from "@hearthlog/contracts/calendar/types";
    import { calendarSourceIcon } from "./source-icons.js";
    import { formatNumber } from "@hearthlog/ui/utils/number-format.js";
    import { cn } from "@hearthlog/ui/utils/cn.js";

    let {
        year,
        monthIndex,
        today,
        counts,
        sourceLabel,
        loading = false,
        class: className = "",
    }: {
        year: number;
        /** 0-indexed, like `Date#getMonth`. */
        monthIndex: number;
        today: string;
        counts: CalendarSourceCounts;
        sourceLabel: (sourceKey: string) => string;
        loading?: boolean;
        class?: string;
    } = $props();

    const summary = $derived(summarizeWorkingMonth(year, monthIndex, today));
    const previousMonthName = $derived(formatDay(new Date(year, monthIndex - 1, 1), "MMMM"));
    const comparison = $derived.by(() => {
        const difference = summary.workingDays - summary.previousWorkingDays;
        if (difference === 0) return `same as ${previousMonthName}`;
        return `${Math.abs(difference)} ${difference > 0 ? "more" : "fewer"} than ${previousMonthName}`;
    });
    const progressPercent = $derived(
        summary.progress && summary.workingDays > 0
            ? (summary.progress.passed / summary.workingDays) * 100
            : 0,
    );

    function holidayDate(date: string): string {
        return formatDay(new Date(`${date}T12:00:00`), "EEE d MMM");
    }
</script>

<section class={cn("stor-panel p-[var(--stor-panel-padding)]", className)} aria-label="Month summary">
    <div class="stor-metric">
        <p class="stor-metric-label">Working days</p>
        <p class="stor-metric-value tabular-nums" data-testid="calendar-working-days">{formatNumber(summary.workingDays)}</p>
        <p class="stor-metric-support">{formatNumber(summary.workingHours)} hours · {comparison}</p>
    </div>

    {#if summary.progress}
        <div class="mt-4">
            <div
                class="h-1.5 overflow-hidden rounded-full bg-[var(--stor-surface-muted)]"
                role="progressbar"
                aria-label="Working days passed"
                aria-valuemin={0}
                aria-valuemax={summary.workingDays}
                aria-valuenow={summary.progress.passed}
                aria-valuetext={`${summary.progress.passed} of ${summary.workingDays} passed, ${summary.progress.left} left`}
            >
                <div class="h-full rounded-full bg-[var(--stor-action)]" style="width: {progressPercent}%"></div>
            </div>
            <p class="mt-1.5 flex justify-between gap-3 text-xs tabular-nums text-[var(--stor-muted-text)]" aria-hidden="true">
                <span>{formatNumber(summary.progress.passed)} passed</span>
                <span class="font-semibold text-[var(--stor-ink)]">{formatNumber(summary.progress.left)} left</span>
            </p>
        </div>
    {/if}

    <dl class="stor-inset-rows mt-3 text-sm">
        <div class="flex items-baseline justify-between gap-3 py-2">
            <dt class="text-[var(--stor-muted-text)]">Weekends and holidays</dt>
            <dd class="font-semibold tabular-nums text-[var(--stor-ink)]">{formatNumber(summary.daysOff)}</dd>
        </div>
        <div class="flex items-baseline justify-between gap-3 py-2">
            <dt class="text-[var(--stor-muted-text)]">Working days in Q{summary.quarter.number}</dt>
            <dd class="font-semibold tabular-nums text-[var(--stor-ink)]">{formatNumber(summary.quarter.workingDays)}</dd>
        </div>
        <div class="flex items-baseline justify-between gap-3 py-2">
            <dt class="text-[var(--stor-muted-text)]">Working days in {year}</dt>
            <dd class="font-semibold tabular-nums text-[var(--stor-ink)]">{formatNumber(summary.yearWorkingDays)}</dd>
        </div>
    </dl>

    {#if summary.holidays.length > 0}
        <h2 class="mt-4 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">Holidays</h2>
        <ul class="stor-inset-rows mt-1 text-sm">
            {#each summary.holidays as holiday (holiday.date)}
                <li class="flex items-baseline justify-between gap-3 py-2 {holiday.isWeekend ? 'text-[var(--stor-muted-text)]' : 'text-[var(--stor-ink)]'}">
                    <span class="min-w-0">{holiday.name}</span>
                    <span class="shrink-0 tabular-nums text-[var(--stor-muted-text)]">{holidayDate(holiday.date)}{#if holiday.isWeekend}<span class="sr-only">, on a weekend</span>{/if}</span>
                </li>
            {/each}
        </ul>
    {/if}

    <div class="mt-4 flex items-baseline justify-between gap-3">
        <h2 class="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">Scheduled</h2>
        {#if !loading && counts.total > 0}<span class="text-sm font-semibold tabular-nums text-[var(--stor-ink)]">{formatNumber(counts.total)}</span>{/if}
    </div>
    {#if loading}
        <DataPlaceholder rows={2} label="Loading scheduled items" />
    {:else if counts.total === 0}
        <p class="mt-1 text-sm text-[var(--stor-muted-text)]">Nothing scheduled</p>
    {:else}
        <ul class="stor-inset-rows mt-1 text-sm" style="--stor-row-inset: 1.75rem">
            {#each counts.sources as entry (entry.sourceKey)}
                {@const Icon = calendarSourceIcon(calendarSourcePresentation(entry.sourceKey).icon)}
                <li class="flex items-center gap-3 py-2">
                    <Icon class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)]" />
                    <span class="min-w-0 flex-1 truncate text-[var(--stor-ink)]">{sourceLabel(entry.sourceKey)}</span>
                    <span class="font-semibold tabular-nums text-[var(--stor-ink)]">{formatNumber(entry.count)}</span>
                </li>
            {/each}
        </ul>
    {/if}
</section>
