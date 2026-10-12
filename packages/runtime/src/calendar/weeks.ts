import { monthKeyOf, shiftDay, shiftWeek, weekOffset, weekStartOf } from '@hearthlog/ui/utils/endless-axis.js';

/** Weeks read together, so scrolling reads a block at a time instead of a week. */
export const CHUNK_WEEKS = 6;

/** Weeks listed either side of today's week; a hundred years each way feels endless. */
export const WEEK_SPAN = 5218;

/** A Monday that chunks count from, so every visit reads the same blocks. */
const CHUNK_EPOCH = '2000-01-03';

/** The given weeks widened to whole chunks, sorted. */
export function weekChunks(weekStarts: readonly string[]): string[] {
    const weeks = new Set<string>();
    for (const week of weekStarts) {
        const first = shiftWeek(CHUNK_EPOCH, Math.floor(weekOffset(week, CHUNK_EPOCH) / CHUNK_WEEKS) * CHUNK_WEEKS);
        for (let index = 0; index < CHUNK_WEEKS; index += 1) weeks.add(shiftWeek(first, index));
    }
    return [...weeks].sort();
}

/** The month with the most days in the given weeks; the earlier month wins a tie. */
export function monthInView(weekStarts: readonly string[]): string {
    const days = new Map<string, number>();
    for (const week of weekStarts) {
        for (let offset = 0; offset < 7; offset += 1) {
            const month = monthKeyOf(shiftDay(week, offset));
            days.set(month, (days.get(month) ?? 0) + 1);
        }
    }
    let best = '';
    let most = 0;
    for (const [month, count] of days) {
        if (count > most) {
            best = month;
            most = count;
        }
    }
    return best;
}

/**
 * Where a month boundary runs along a day's cell: above each of a month's
 * first seven days, whose cell above belongs to the month before, and
 * before its first day unless that is a Monday. Together they draw one
 * stepped line between months.
 */
export function monthEdges(day: string): { top: boolean; start: boolean } {
    const date = Number(day.slice(8, 10));
    return { top: date <= 7, start: date === 1 && dayColumn(day) > 0 };
}

/** A day's column in its week, 0 for Monday. */
export function dayColumn(day: string): number {
    return Math.round((Date.parse(day) - Date.parse(weekStartOf(day))) / 86_400_000);
}
