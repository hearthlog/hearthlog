/**
 * Normalized shapes returned by the calendar repository and consumed by the
 * Calendar page, the Today widgets, and (later) the ICS serializer.
 *
 * Everything here is plain data so the module can be imported from the
 * frontend Worker without browser dependencies.
 */

/** Extra column values copied for href placeholders (e.g. tripId). */
export type CalendarItemParams = Record<string, string>;

/** A point-in-time item: one entity record on one day. */
export interface CalendarPointItem {
    sourceKey: string;
    /** Entity record id, unique within the source. */
    id: string;
    /** `HH:mm`; empty means all-day. */
    startTime: string;
    endTime: string;
    title: string;
    subtitle: string;
    /** Only calendar events carry a pin today. */
    pinned: boolean;
    params: CalendarItemParams;
}

/** One day of point items, already grouped by SQL. */
export interface CalendarDay {
    day: string;
    items: CalendarPointItem[];
}

/** A multi-day item clipped to the queried window. */
export interface CalendarRangeItem {
    sourceKey: string;
    id: string;
    startDate: string;
    endDate: string;
    startTime: string;
    endTime: string;
    title: string;
    subtitle: string;
    params: CalendarItemParams;
}

/** A multi-day item placed in one week row; columns and lanes come from SQL. */
export interface CalendarBand {
    /** Clipped to the queried weeks. */
    range: CalendarRangeItem;
    /** First and last column it covers, 0 for Monday. */
    startCol: number;
    endCol: number;
    /** Its row among the week's bands, which is also its index in `CalendarWeek.bands`. */
    lane: number;
}

/** One day of a week row. */
export interface CalendarWeekDay {
    day: string;
    items: CalendarPointItem[];
    /** Lanes of the week's bands that cover the day, in order. */
    lanes: number[];
}

/** One Monday-first week of the endless calendar, laid out in SQL. */
export interface CalendarWeek {
    /** The week's Monday. */
    start: string;
    /** Monday to Sunday. */
    days: CalendarWeekDay[];
    /** Ordered by lane. */
    bands: CalendarBand[];
}

/** Metadata about an active calendar source, for the legend and hrefs. */
export interface CalendarSourceInfo {
    key: string;
    entityName: string;
    label: string;
    /** True when the source comes from a runtime-defined entity type. */
    dynamic: boolean;
}

export interface CalendarRangeResult {
    /** Every enabled source, regardless of the active filter. */
    sources: CalendarSourceInfo[];
    /** Point items grouped by day, ordered by day. */
    days: CalendarDay[];
    /** Multi-day items intersecting the window, ordered by start date. */
    ranges: CalendarRangeItem[];
}

/** Items per visible source within one window, counted in SQL. */
export interface CalendarSourceCounts {
    total: number;
    /** Ordered by count, largest first. */
    sources: Array<{ sourceKey: string; count: number }>;
}
