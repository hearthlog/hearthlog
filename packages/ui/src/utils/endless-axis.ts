/**
 * Keys and indexes for endless lists. An axis lists keys that sort in order
 * (`yyyy-MM` months, for example) and maps each one to its place in the list,
 * so a virtualized list can span a century without building it.
 */

/** The keys an endless list holds, in order. */
export interface EndlessAxis {
    /** How many keys the list holds. */
    readonly count: number;
    /** The key at an index. */
    keyAt(index: number): string;
    /** The index of a key, clamped into the list. */
    indexOf(key: string): number;
}

/**
 * Keys a whole number of steps from `base`, from step `first` to step `last`.
 * `shift` moves a key by steps and `steps` counts them from the base.
 */
export function stepAxis(
    base: string,
    first: number,
    last: number,
    shift: (key: string, steps: number) => string,
    steps: (key: string, base: string) => number,
): EndlessAxis {
    const count = last - first + 1;
    return {
        count,
        keyAt: (index) => shift(base, index + first),
        indexOf: (key) => Math.max(0, Math.min(count - 1, steps(key, base) - first)),
    };
}

/** How a list axis orders its keys. */
export interface ListAxisOptions {
    /** Keys read newest first, so the top of the list is the latest key. */
    descending?: boolean;
    /**
     * Orders keys when plain string order is not list order, as with the
     * Gallery's months that split into parts. Takes precedence over
     * `descending`.
     */
    compare?: (left: string, right: string) => number;
}

function compareStrings(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

/**
 * Keys read from data (months that hold photos, for example), in list order.
 * A key it does not list finds the listed key that would follow it, or the
 * last one.
 */
export function listAxis(keys: readonly string[], { descending = false, compare }: ListAxisOptions = {}): EndlessAxis {
    const order = compare ?? (descending ? (left: string, right: string) => compareStrings(right, left) : compareStrings);
    return {
        count: keys.length,
        keyAt: (index) => keys[index],
        indexOf: (key) => {
            let low = 0;
            let high = keys.length;
            while (low < high) {
                const middle = (low + high) >> 1;
                if (order(keys[middle], key) < 0) low = middle + 1;
                else high = middle;
            }
            return Math.max(0, Math.min(keys.length - 1, low));
        },
    };
}

/** The nearest key an axis lists. */
export function nearestKey(axis: EndlessAxis, key: string): string {
    return axis.keyAt(axis.indexOf(key));
}

// ---------------------------------------------------------------- months

export function monthKeyOf(day: string): string {
    return day.slice(0, 7);
}

export function shiftMonthKey(key: string, offset: number): string {
    const total = Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1 + offset;
    return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12 + 12) % 12 + 1).padStart(2, '0')}`;
}

/** Whole months from `base` to `key`. */
export function monthOffset(key: string, base: string): number {
    return (Number(key.slice(0, 4)) - Number(base.slice(0, 4))) * 12 + Number(key.slice(5, 7)) - Number(base.slice(5, 7));
}

/**
 * Months around `base`, from `first` to `last`. An open end (null) runs
 * `span` months from the base, and no end runs further than that.
 */
export function monthAxis(base: string, range: { first: string | null; last: string | null; span: number }): EndlessAxis {
    const first = range.first ? Math.max(-range.span, monthOffset(range.first, base)) : -range.span;
    const last = range.last ? Math.min(range.span, monthOffset(range.last, base)) : range.span;
    return stepAxis(base, first, last, shiftMonthKey, monthOffset);
}

// ---------------------------------------------------------------- days and weeks

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 for a `yyyy-MM-dd` key, free of time zones. */
function dayNumber(day: string): number {
    return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;
}

function dayKey(number: number): string {
    return new Date(number * DAY_MS).toISOString().slice(0, 10);
}

export function shiftDay(day: string, offset: number): string {
    return dayKey(dayNumber(day) + offset);
}

/** Whole days from `base` to `day`. */
export function dayOffset(day: string, base: string): number {
    return dayNumber(day) - dayNumber(base);
}

/** Days keyed `yyyy-MM-dd`, from `first` days before `base` to `last` days after it. */
export function dayAxis(base: string, first: number, last: number): EndlessAxis {
    return stepAxis(base, -first, last, shiftDay, dayOffset);
}

/** The Monday starting the week that holds `day`. */
export function weekStartOf(day: string): string {
    const number = dayNumber(day);
    // 1970-01-01 was a Thursday, three days after a Monday.
    return dayKey(number - ((number + 3) % 7 + 7) % 7);
}

export function shiftWeek(key: string, offset: number): string {
    return shiftDay(key, offset * 7);
}

/** Whole weeks from the week starting `base` to the week holding `day`. */
export function weekOffset(day: string, base: string): number {
    return Math.round((dayNumber(weekStartOf(day)) - dayNumber(base)) / 7);
}

/** Weeks keyed by their Monday, `span` weeks either side of the week starting `base`. */
export function weekAxis(base: string, span: number): EndlessAxis {
    return stepAxis(base, -span, span, shiftWeek, weekOffset);
}
