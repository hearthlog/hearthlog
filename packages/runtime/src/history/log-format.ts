import { format, isSameYear, isToday, isYesterday } from 'date-fns';

/** A day in log metadata: today, yesterday, Sep 21, or Sep 21, 2025. */
export function formatLogDay(value: string | number | null | undefined, now = Date.now()): string {
    const time = typeof value === 'number' ? value : value ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(time)) return '';
    if (isToday(time)) return 'today';
    if (isYesterday(time)) return 'yesterday';
    return format(time, isSameYear(time, now) ? 'MMM d' : 'MMM d, yyyy');
}

/** A fork point with its time: Sep 21, 08:12. */
export function formatForkPoint(value: string | number | null | undefined): string {
    const time = typeof value === 'number' ? value : value ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(time)) return '';
    return format(time, isSameYear(time, Date.now()) ? 'MMM d, HH:mm' : 'MMM d, yyyy, HH:mm');
}
