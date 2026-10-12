/**
 * RFC 5545 (iCalendar) serializer for calendar exports and the published feed.
 *
 * Pure module with no browser dependencies: the frontend Worker reuses it for
 * server-computed feeds. Times are emitted as floating local times to match the
 * UI, which stores `YYYY-MM-DD` dates plus `HH:mm` times with no timezone.
 */

export interface IcsCalendarOptions {
    /** `X-WR-CALNAME`; shown as the calendar name in clients. */
    name: string;
    /** Domain appended to event UIDs, normally the tenant hostname. */
    uidDomain: string;
    /** Generation timestamp; injectable for deterministic tests. */
    stamp?: Date;
    /** Refresh hint for clients, e.g. `PT1H`. */
    refreshInterval?: string;
    /** Fallback duration for timed events without an end time. */
    defaultDurationMinutes?: number;
}

export interface IcsEventInput {
    /** Stable identity: `<source-key>-<entity-id>`. */
    uid: string;
    title: string;
    description?: string;
    /** Absolute URL of the owning record. */
    url?: string;
    /** Human source label; written as `CATEGORIES`. */
    category?: string;
    /** Start day, `YYYY-MM-DD`. */
    startDate: string;
    /** Inclusive end day for multi-day items. */
    endDate?: string;
    /** Start time, `HH:mm`; absent means all-day. */
    startTime?: string;
    endTime?: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const DEFAULT_REFRESH_INTERVAL = 'PT1H';
const DEFAULT_DURATION_MINUTES = 60;

export function serializeIcs(
    events: readonly IcsEventInput[],
    options: IcsCalendarOptions,
): string {
    const stamp = formatUtcStamp(options.stamp ?? new Date());
    const refreshInterval = options.refreshInterval ?? DEFAULT_REFRESH_INTERVAL;
    const lines: string[] = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//stor//Calendar//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${escapeText(options.name)}`,
        `REFRESH-INTERVAL;VALUE=DURATION:${refreshInterval}`,
        `X-PUBLISHED-TTL:${refreshInterval}`,
    ];

    for (const event of events) {
        const block = eventBlock(
            event,
            options.uidDomain,
            stamp,
            options.defaultDurationMinutes ?? DEFAULT_DURATION_MINUTES,
        );
        if (block) lines.push(...block);
    }

    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
}

function eventBlock(
    event: IcsEventInput,
    uidDomain: string,
    stamp: string,
    durationMinutes: number,
): string[] | null {
    if (!DATE_PATTERN.test(event.startDate)) return null;
    const lines = ['BEGIN:VEVENT', `UID:${escapeText(event.uid)}@${uidDomain}`, `DTSTAMP:${stamp}`];

    const multiDay = Boolean(event.endDate && event.endDate !== event.startDate);
    const timed = !multiDay && Boolean(event.startTime && TIME_PATTERN.test(event.startTime));

    if (timed) {
        const start = `${compactDate(event.startDate)}T${compactTime(event.startTime!)}00`;
        const endTime = event.endTime && TIME_PATTERN.test(event.endTime)
            ? event.endTime
            : addMinutes(event.startTime!, durationMinutes);
        const end = `${compactDate(event.startDate)}T${compactTime(endTime)}00`;
        lines.push(`DTSTART:${start}`, `DTEND:${end}`);
    } else {
        const lastDay = multiDay ? event.endDate! : event.startDate;
        lines.push(
            `DTSTART;VALUE=DATE:${compactDate(event.startDate)}`,
            `DTEND;VALUE=DATE:${compactDate(addDays(lastDay, 1))}`,
        );
    }

    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.category) lines.push(`CATEGORIES:${escapeText(event.category)}`);
    if (event.url) lines.push(`URL:${escapeText(event.url)}`);
    lines.push('SEQUENCE:0', 'STATUS:CONFIRMED', 'END:VEVENT');
    return lines;
}

/** Escape a text value for an iCalendar content line. */
export function escapeText(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a content line to 75 octets per RFC 5545, never splitting a UTF-8
 * character. Continuation lines start with a single space.
 */
export function foldLine(line: string): string {
    // 74 content octets keeps a continuation line (leading space included) at
    // the 75-octet limit.
    const maxOctets = 74;
    const encoder = new TextEncoder();
    if (encoder.encode(line).length <= 75) return line;

    const parts: string[] = [];
    let current = '';
    let currentBytes = 0;

    for (const character of line) {
        const bytes = encoder.encode(character).length;
        if (currentBytes + bytes > maxOctets) {
            parts.push(current);
            current = character;
            currentBytes = bytes;
        } else {
            current += character;
            currentBytes += bytes;
        }
    }
    if (current) parts.push(current);
    return parts.join('\r\n ');
}

function compactDate(date: string): string {
    return date.replace(/-/g, '');
}

function compactTime(time: string): string {
    return time.replace(':', '');
}

function formatUtcStamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return (
        `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
    );
}

function addDays(date: string, amount: number): string {
    const [year, month, day] = date.split('-').map(Number);
    const value = new Date(Date.UTC(year, month - 1, day + amount));
    return value.toISOString().slice(0, 10);
}

function addMinutes(time: string, minutes: number): string {
    const [hour, minute] = time.split(':').map(Number);
    const total = Math.min(hour * 60 + minute + minutes, 24 * 60 - 1);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}
