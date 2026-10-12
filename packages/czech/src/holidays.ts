/**
 * Czech public holidays and the working-time rules built on them (a month's working days and hours,
 * the quarter and year totals). Dates are local 'YYYY-MM-DD' strings; months are 0-indexed like
 * JavaScript's `Date`.
 */

export interface DateInfo {
    date: Date;
    isWorkingDay: boolean;
    isHoliday: boolean;
    isWeekend: boolean;
    /** Public holiday name, or null on an ordinary day. */
    holidayName: string | null;
    /** 1-based position among the month's working days, or null on a day off. */
    workingDayNumber: number | null;
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

export function toLocalDateString(date = new Date()): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Calculate Easter Sunday for a given year.
 * Uses the Anonymous Gregorian algorithm.
 */
export function getEaster(year: number): Date {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;

    // Month is 1-indexed in algorithm, Date uses 0-indexed months
    return new Date(year, month - 1, day);
}

const CZECH_FIXED_HOLIDAYS: ReadonlyArray<readonly [string, string]> = [
    ["01-01", "New Year's Day"],
    ["05-01", "Labour Day"],
    ["05-08", "Victory in Europe Day"],
    ["07-05", "Saints Cyril and Methodius Day"],
    ["07-06", "Jan Hus Day"],
    ["09-28", "Czech Statehood Day"],
    ["10-28", "Independent Czechoslovak State Day"],
    ["11-17", "Struggle for Freedom and Democracy Day"],
    ["12-24", "Christmas Eve"],
    ["12-25", "Christmas Day"],
    ["12-26", "St. Stephen's Day"],
];

/**
 * Get all Czech public holidays for a given year, keyed by 'YYYY-MM-DD'.
 */
export function getCzechHolidayNames(year: number): Map<string, string> {
    const holidays = new Map<string, string>();
    for (const [monthDay, name] of CZECH_FIXED_HOLIDAYS) {
        holidays.set(`${year}-${monthDay}`, name);
    }

    const easter = getEaster(year);

    // Good Friday (2 days before Easter)
    const goodFriday = new Date(easter);
    goodFriday.setDate(easter.getDate() - 2);

    // Easter Monday (1 day after Easter)
    const easterMonday = new Date(easter);
    easterMonday.setDate(easter.getDate() + 1);

    holidays.set(toLocalDateString(goodFriday), "Good Friday");
    holidays.set(toLocalDateString(easterMonday), "Easter Monday");

    return holidays;
}

/**
 * Get all Czech public holidays for a given year.
 * Returns a set of date strings in 'YYYY-MM-DD' format.
 */
export function getCzechHolidays(year: number): Set<string> {
    return new Set(getCzechHolidayNames(year).keys());
}

/**
 * Get all days in a month with working day information.
 * Month is 0-indexed (0 = January) to match JS Date.
 */
export function getWorkingDays(year: number, month: number): DateInfo[] {
    const holidays = getCzechHolidayNames(year);

    // Get number of days in month
    // Day 0 of next month is the last day of current month
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const result: DateInfo[] = [];
    let workingDayCount = 0;

    for (let day = 1; day <= daysInMonth; day++) {
        const currentDate = new Date(year, month, day);
        const dateStr = toLocalDateString(currentDate);

        const dayOfWeek = currentDate.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6; // 0 = Sunday, 6 = Saturday
        const holidayName = holidays.get(dateStr) ?? null;
        const isHoliday = holidayName !== null;
        const isWorkingDay = !isWeekend && !isHoliday;
        if (isWorkingDay) workingDayCount += 1;

        result.push({
            date: currentDate,
            isWorkingDay,
            isHoliday,
            isWeekend,
            holidayName,
            workingDayNumber: isWorkingDay ? workingDayCount : null,
        });
    }

    return result;
}

export function countWorkingDays(year: number, month: number): number {
    const days = getWorkingDays(year, month);
    return days.filter((d) => d.isWorkingDay).length;
}

/** Full-time working hours per working day, as in a Czech working-time fund. */
export const WORKING_HOURS_PER_DAY = 8;

export interface MonthHoliday {
    date: string;
    name: string;
    /** A weekend holiday does not cost a working day. */
    isWeekend: boolean;
}

export interface WorkingMonthSummary {
    workingDays: number;
    workingHours: number;
    /** Calendar days that are not working days: weekends plus weekday holidays. */
    daysOff: number;
    weekendDays: number;
    /** Holidays that fall on a weekday. */
    weekdayHolidays: number;
    holidays: MonthHoliday[];
    /**
     * Working days before and from `today`, only for the month containing it.
     * Today counts as left so a working day in progress is still available.
     */
    progress: { passed: number; left: number } | null;
    /** Working days in the previous month, for a month-over-month comparison. */
    previousWorkingDays: number;
    quarter: { number: number; workingDays: number };
    yearWorkingDays: number;
}

/**
 * Working-time statistics for one month from the weekend and Czech public
 * holiday rules. Month is 0-indexed; `today` is a local 'YYYY-MM-DD' date.
 */
export function summarizeWorkingMonth(
    year: number,
    month: number,
    today: string,
): WorkingMonthSummary {
    const days = getWorkingDays(year, month);
    let workingDays = 0;
    let weekendDays = 0;
    let weekdayHolidays = 0;
    let passed = 0;
    const holidays: MonthHoliday[] = [];
    for (const day of days) {
        const key = toLocalDateString(day.date);
        if (day.isWorkingDay) {
            workingDays += 1;
            if (key < today) passed += 1;
        }
        if (day.isWeekend) weekendDays += 1;
        if (day.holidayName !== null) {
            holidays.push({ date: key, name: day.holidayName, isWeekend: day.isWeekend });
            if (!day.isWeekend) weekdayHolidays += 1;
        }
    }

    const monthKey = `${pad(year)}-${pad(month + 1)}`;
    const quarterStart = Math.floor(month / 3) * 3;
    let quarterWorkingDays = 0;
    let yearWorkingDays = 0;
    for (let index = 0; index < 12; index++) {
        const count = index === month ? workingDays : countWorkingDays(year, index);
        yearWorkingDays += count;
        if (index >= quarterStart && index < quarterStart + 3) quarterWorkingDays += count;
    }
    const previous = new Date(year, month - 1, 1);

    return {
        workingDays,
        workingHours: workingDays * WORKING_HOURS_PER_DAY,
        daysOff: days.length - workingDays,
        weekendDays,
        weekdayHolidays,
        holidays,
        progress: today.slice(0, 7) === monthKey
            ? { passed, left: workingDays - passed }
            : null,
        previousWorkingDays: countWorkingDays(previous.getFullYear(), previous.getMonth()),
        quarter: { number: quarterStart / 3 + 1, workingDays: quarterWorkingDays },
        yearWorkingDays,
    };
}
