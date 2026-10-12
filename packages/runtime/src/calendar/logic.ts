import { differenceInCalendarDays } from "date-fns";

export interface CalendarEventDraft {
    title: string;
    eventDate: string;
    startTime: string;
    notes: string;
    pinned: boolean;
}

export interface CalendarMonth {
    year: number;
    monthIndex: number;
    key: string;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

export function toLocalDateString(date = new Date()): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isValidLocalDate(value: string): boolean {
    const match = value.match(DATE_PATTERN);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(year, month - 1, day, 12);
    return parsed.getFullYear() === year &&
        parsed.getMonth() === month - 1 &&
        parsed.getDate() === day;
}

export function isValidStartTime(value: string): boolean {
    if (value === "") return true;
    const match = value.match(TIME_PATTERN);
    return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
}

export function validateCalendarEventDraft(
    draft: CalendarEventDraft,
): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!draft.title.trim()) errors.title = "Enter an event title.";
    if (!isValidLocalDate(draft.eventDate)) {
        errors.eventDate = "Choose a valid event date.";
    }
    if (!isValidStartTime(draft.startTime)) {
        errors.startTime = "Enter a valid time.";
    }
    return errors;
}

export function parseCalendarMonth(
    value: string | null | undefined,
    fallback = new Date(),
): CalendarMonth {
    const match = value?.match(MONTH_PATTERN);
    const year = match ? Number(match[1]) : fallback.getFullYear();
    const month = match ? Number(match[2]) : fallback.getMonth() + 1;
    const valid = Boolean(match && year >= 1 && month >= 1 && month <= 12);
    const resolvedYear = valid ? year : fallback.getFullYear();
    const resolvedMonth = valid ? month : fallback.getMonth() + 1;
    return {
        year: resolvedYear,
        monthIndex: resolvedMonth - 1,
        key: `${pad(resolvedYear)}-${pad(resolvedMonth)}`,
    };
}

export function calendarMonthBounds(month: CalendarMonth): {
    startDate: string;
    endDateExclusive: string;
} {
    const next = month.monthIndex === 11
        ? { year: month.year + 1, month: 1 }
        : { year: month.year, month: month.monthIndex + 2 };
    return {
        startDate: `${pad(month.year)}-${pad(month.monthIndex + 1)}-01`,
        endDateExclusive: `${pad(next.year)}-${pad(next.month)}-01`,
    };
}

/**
 * Bounds of the visible month grid, Monday-aligned and padded to whole weeks.
 * The calendar renders leading and trailing days, so items must be fetched for
 * the grid span rather than the month.
 */
export function calendarGridBounds(month: CalendarMonth): {
    startDate: string;
    endDateExclusive: string;
} {
    const firstDay = new Date(month.year, month.monthIndex, 1, 12);
    const offset = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(month.year, month.monthIndex + 1, 0).getDate();
    const weeks = Math.ceil((offset + daysInMonth) / 7);
    const start = new Date(month.year, month.monthIndex, 1 - offset, 12);
    const end = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate() + weeks * 7,
        12,
    );
    return {
        startDate: toLocalDateString(start),
        endDateExclusive: toLocalDateString(end),
    };
}

function parseLocalDate(value: string): Date {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day, 12);
}

export function daysUntilCalendarEvent(
    eventDate: string,
    today = new Date(),
): number {
    const localToday = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
        12,
    );
    return differenceInCalendarDays(parseLocalDate(eventDate), localToday);
}

export function describeEventCountdown(daysUntil: number): string {
    if (daysUntil === 0) return "Today";
    if (daysUntil === 1) return "Tomorrow";
    if (daysUntil > 1) return `${daysUntil} days left`;
    if (daysUntil === -1) return "1 day ago";
    return `${Math.abs(daysUntil)} days ago`;
}
