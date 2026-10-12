/**
 * Per-log calendar source filter, stored in the existing IndexedDB key-value
 * store. This is a view preference, not log data, so it is not an event and
 * does not sync.
 */

import { del, get, set } from '../db/kv.js';
import { tenant } from '@hearthlog/contracts/tenant/config';
import {
    sanitizeCalendarSourcePreference,
    type CalendarSourcePreference,
} from './groups.js';

export function calendarSourcePreferenceKey(tenantId: string, logId: string): string {
    return `calendar-sources:${tenantId}:${logId}`;
}

export async function getCalendarSourcePreference(
    logId: string,
): Promise<CalendarSourcePreference | null> {
    if (!logId) return null;
    const stored = await get<unknown>(calendarSourcePreferenceKey(tenant.id, logId));
    if (stored == null) return null;
    return sanitizeCalendarSourcePreference(stored);
}

export async function setCalendarSourcePreference(
    logId: string,
    preference: CalendarSourcePreference,
): Promise<void> {
    const key = calendarSourcePreferenceKey(tenant.id, logId);
    if (preference.hiddenGroups.length === 0 && preference.hiddenSources.length === 0) {
        await del(key);
        return;
    }
    await set(key, {
        hiddenGroups: preference.hiddenGroups,
        hiddenSources: preference.hiddenSources,
    } satisfies CalendarSourcePreference);
}
