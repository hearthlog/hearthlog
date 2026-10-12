import { deferPage } from '@hearthlog/runtime/runtime/page-data.svelte.js';
import {
    calendarMonthBounds,
    parseCalendarMonth,
    toLocalDateString,
} from '@hearthlog/runtime/calendar/logic.js';
import { getCalendarSourcePreference } from '@hearthlog/runtime/calendar/preferences.js';
import type { CalendarSourcePreference } from '@hearthlog/runtime/calendar/groups.js';
import type { CalendarSourceCounts, CalendarSourceInfo } from '@hearthlog/contracts/calendar/types';
import { eventLogFilename } from '@hearthlog/runtime/store/event-log.svelte.js';
import { queryDatabase } from '@hearthlog/runtime/db/read-repositories.js';
import { appClock } from '@hearthlog/runtime/runtime/view.js';
import { tenant } from '@hearthlog/contracts/tenant/config';
import { MODULE_REFRESH_KEYS } from '#generated/modules';
import type { LoadEvent } from '@sveltejs/kit';
type PageLoad = (event: LoadEvent) => unknown;

const loadData = async ({ url }: Parameters<PageLoad>[0]) => {
    const boundaryNow = await appClock.ready();
    // The endless grid reads its weeks as they scroll into view; the page
    // loads what spans them and the counts for the month it opens at.
    const month = parseCalendarMonth(url.searchParams.get('month'), boundaryNow);
    const monthBounds = calendarMonthBounds(month);
    const today = toLocalDateString(boundaryNow);
    await eventLogFilename.ready();
    const sourcePreference = await getCalendarSourcePreference(
        eventLogFilename.value ?? '',
    );

    const [sources, monthCounts, pinnedEvents] = await queryDatabase(async (repositories) => {
        const [sources, monthCounts, pinnedEvents] = await Promise.all([
            repositories.calendar.getCalendarSources(),
            repositories.calendar.getCalendarSourceCounts(
                monthBounds.startDate,
                monthBounds.endDateExclusive,
                sourcePreference,
            ),
            repositories.calendar.getUpcomingPinnedCalendarEvents(today),
        ]);
        return [sources, monthCounts, pinnedEvents] as const;
    });

    return {
        month,
        today,
        sources: sources as CalendarSourceInfo[],
        monthCounts,
        pinnedEvents,
        sourcePreference,
        effectiveNow: boundaryNow.toISOString(),
    };
};

type CalendarPageData = Awaited<ReturnType<typeof loadData>>;

export const load = ((event) => {
    event.depends('app:calendar');
    // Modules feed the calendar through their entity sources, so any of their refreshes re-reads it.
    for (const key of MODULE_REFRESH_KEYS) event.depends(key);
    if (tenant.dynamicEntities) {
        event.depends('app:entity-types');
        event.depends('app:entities');
    }
    return deferPage(
        event,
        {
            month: parseCalendarMonth(event.url.searchParams.get('month')),
            today: toLocalDateString(),
            sources: [] as CalendarSourceInfo[],
            monthCounts: { total: 0, sources: [] } as CalendarSourceCounts,
            pinnedEvents: [],
            sourcePreference: null as CalendarSourcePreference | null,
            effectiveNow: new Date().toISOString(),
        } as CalendarPageData,
        () => loadData(event),
    );
}) satisfies PageLoad;
