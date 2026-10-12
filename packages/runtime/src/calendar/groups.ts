/**
 * Calendar source groups for the page filter and the feed picker.
 *
 * Dates that static definitions group share a menu row. A source that is not in a built-in group
 * (a runtime-defined entity, or a future static date) is its own row.
 * Preferences remember what the user turned off, so a new source stays visible.
 */

import { ENTITY_DEFINITIONS } from '@hearthlog/contracts/event/entity-definitions';
import { calendarSourceKey, normalizeCalendarSources } from '@hearthlog/contracts/calendar/config';

export interface CalendarSourceRef {
    key: string;
    label: string;
    dynamic: boolean;
}

/** What the user turned off. Absence, or both lists empty, means show everything. */
export interface CalendarSourcePreference {
    hiddenGroups: string[];
    hiddenSources: string[];
}

const EMPTY_CALENDAR_SOURCE_PREFERENCE: CalendarSourcePreference = {
    hiddenGroups: [],
    hiddenSources: [],
};

export interface CalendarMenuEntry {
    id: string;
    label: string;
    kind: 'group' | 'source';
    /** Source keys this row controls. Only keys present in the current log. */
    sourceKeys: string[];
    icon: string;
}

/**
 * The menu rows static definitions declare (`group` on a calendar source), in
 * the order of their first source's rank (Events, Transactions, Invoices).
 */
const GROUPS: ReadonlyArray<{
    id: string;
    label: string;
    keys: readonly string[];
    icon: string;
}> = (() => {
    const groups = new Map<string, { id: string; label: string; keys: string[]; icon: string; rank: number }>();
    for (const definition of ENTITY_DEFINITIONS) {
        for (const source of normalizeCalendarSources(definition.calendar)) {
            if (!source.group) continue;
            const entry = groups.get(source.group.id) ?? { ...source.group, keys: [], rank: Infinity };
            entry.keys.push(calendarSourceKey(definition.name, source));
            entry.rank = Math.min(entry.rank, source.presentation?.rank ?? Infinity);
            groups.set(source.group.id, entry);
        }
    }
    return [...groups.values()].sort((a, b) => a.rank - b.rank);
})();

const GROUP_BY_KEY = new Map<string, (typeof GROUPS)[number]>();
for (const group of GROUPS) {
    for (const key of group.keys) GROUP_BY_KEY.set(key, group);
}

export function sanitizeCalendarSourcePreference(value: unknown): CalendarSourcePreference {
    if (!value || typeof value !== 'object') return EMPTY_CALENDAR_SOURCE_PREFERENCE;
    const record = value as Record<string, unknown>;
    return {
        hiddenGroups: stringList(record.hiddenGroups),
        hiddenSources: stringList(record.hiddenSources),
    };
}

function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item === 'string' && item.length > 0) seen.add(item);
    }
    return [...seen];
}

export function calendarMenuEntries(
    sources: readonly CalendarSourceRef[],
): CalendarMenuEntry[] {
    const present = new Set(sources.map((source) => source.key));
    const entries: CalendarMenuEntry[] = [];
    for (const group of GROUPS) {
        const sourceKeys = group.keys.filter((key) => present.has(key));
        if (sourceKeys.length === 0) continue;
        entries.push({
            id: group.id,
            label: group.label,
            kind: 'group',
            sourceKeys,
            icon: group.icon,
        });
    }
    for (const source of sources) {
        if (GROUP_BY_KEY.has(source.key)) continue;
        entries.push({
            id: source.key,
            label: source.label,
            kind: 'source',
            sourceKeys: [source.key],
            icon: 'calendar-blank-outline',
        });
    }
    return entries;
}

function isEntryHidden(
    entry: CalendarMenuEntry,
    preference: CalendarSourcePreference,
): boolean {
    return entry.kind === 'group'
        ? preference.hiddenGroups.includes(entry.id)
        : preference.hiddenSources.includes(entry.id);
}

export function isCalendarMenuEntryVisible(
    entry: CalendarMenuEntry,
    preference: CalendarSourcePreference,
): boolean {
    return !isEntryHidden(entry, preference);
}

/**
 * Preference the menu and the query should agree on. A saved filter that hides
 * every source currently available is treated as "show all" so the month is
 * never blank because a feature was turned off.
 */
export function effectiveCalendarSourcePreference(
    sources: readonly CalendarSourceRef[],
    preference: CalendarSourcePreference | null,
): CalendarSourcePreference {
    const stored = sanitizeCalendarSourcePreference(preference);
    const entries = calendarMenuEntries(sources);
    if (entries.length === 0) return EMPTY_CALENDAR_SOURCE_PREFERENCE;
    const visible = entries.filter((entry) => !isEntryHidden(entry, stored));
    if (visible.length === 0) return EMPTY_CALENDAR_SOURCE_PREFERENCE;
    return stored;
}

/**
 * Source keys to query. `null` means every source — the repository then omits
 * the filter instead of enumerating keys.
 */
export function visibleCalendarSourceKeys(
    sources: readonly CalendarSourceRef[],
    preference: CalendarSourcePreference | null,
): Set<string> | null {
    const effective = effectiveCalendarSourcePreference(sources, preference);
    if (effective.hiddenGroups.length === 0 && effective.hiddenSources.length === 0) {
        return null;
    }
    const keys = new Set<string>();
    for (const entry of calendarMenuEntries(sources)) {
        if (isEntryHidden(entry, effective)) continue;
        for (const key of entry.sourceKeys) keys.add(key);
    }
    if (keys.size === 0 || keys.size === sources.length) return null;
    return keys;
}

/**
 * Toggle one menu row. Returns null when the click would hide the last visible
 * row or the id is unknown. Operates on the preference the menu is showing.
 */
export function toggleCalendarMenuEntry(
    sources: readonly CalendarSourceRef[],
    preference: CalendarSourcePreference | null,
    entryId: string,
): CalendarSourcePreference | null {
    const current = effectiveCalendarSourcePreference(sources, preference);
    const entries = calendarMenuEntries(sources);
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) return null;
    const visibleCount = entries.filter((item) => !isEntryHidden(item, current)).length;
    const hidden = isEntryHidden(entry, current);
    if (!hidden && visibleCount <= 1) return null;

    if (entry.kind === 'group') {
        return {
            hiddenGroups: hidden
                ? current.hiddenGroups.filter((id) => id !== entry.id)
                : [...new Set([...current.hiddenGroups, entry.id])],
            hiddenSources: [...current.hiddenSources],
        };
    }
    return {
        hiddenGroups: [...current.hiddenGroups],
        hiddenSources: hidden
            ? current.hiddenSources.filter((id) => id !== entry.id)
            : [...new Set([...current.hiddenSources, entry.id])],
    };
}
