import { BucketStore } from '@hearthlog/ui/components/endless/bucket-store.svelte.js';
import { queryDatabase } from '@hearthlog/runtime/db/read-repositories.js';
import type { CalendarSourcePreference } from '@hearthlog/runtime/calendar/groups.js';
import type { CalendarWeek } from '@hearthlog/contracts/calendar/types';
import { weekChunks } from '@hearthlog/runtime/calendar/weeks.js';

/**
 * Loaded weeks of the endless calendar. Weeks are read in whole chunks, each
 * batch one SQL session under the source preference in force when it starts.
 */
export class CalendarWeeks extends BucketStore<CalendarWeek> {
    constructor(preference: () => CalendarSourcePreference | null) {
        super(async (keys) => {
            const current = preference();
            const weeks = await queryDatabase((repositories) => repositories.calendar.getCalendarWeeks(keys, current));
            return new Map(weeks.map((week) => [week.start, week]));
        }, '[Calendar] Could not load weeks');
    }

    ensure(keys: string[]): void {
        super.ensure(weekChunks(keys));
    }

    refresh(keysInView: string[]): void {
        super.refresh(weekChunks(keysInView));
    }
}
