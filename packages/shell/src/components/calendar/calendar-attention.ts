import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import type { AttentionContribution } from '@hearthlog/contracts';
import { queryDatabase } from '@hearthlog/runtime/db/read-repositories.js';

/** The calendar's own figure in the sidebar: the next pinned date, the one its page counts down to. */
export const calendarAttention: AttentionContribution = {
    async figures({ today }) {
        const [next] = await queryDatabase((repositories) => repositories.calendar.getUpcomingPinnedCalendarEvents(today, 1));
        if (!next) return [];
        const date = parseISO(next.event_date);
        const days = differenceInCalendarDays(date, parseISO(today));
        const text = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : format(date, days < 7 ? 'EEE d' : 'd MMM');
        return [{ id: 'calendar', text, label: `next pinned: ${next.title}, ${format(date, 'EEEE d MMMM')}` }];
    },
};
