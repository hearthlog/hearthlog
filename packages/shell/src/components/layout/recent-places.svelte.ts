import { HISTORY_PARAMS } from '@hearthlog/runtime/history/url.js';

/** A place worth returning to: a month, a sub-page, a record. */
export interface RecentPlace {
    href: string;
    title: string;
    /** The navigation destination it belongs to. */
    section: string;
    at: number;
}

const LIMIT = 12;

function storageKey(siteId: string, logId: string): string {
    return `stor:recent-places:${siteId}:${logId}`;
}

function isPlace(value: unknown): value is RecentPlace {
    const place = value as RecentPlace;
    return typeof place?.href === 'string' && typeof place.title === 'string' && typeof place.section === 'string' && typeof place.at === 'number';
}

function read(key: string): RecentPlace[] {
    try {
        const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
        return Array.isArray(stored) ? stored.filter(isPlace).slice(0, LIMIT) : [];
    } catch {
        return [];
    }
}

/**
 * The places this device opened in the current log, newest first. They stay on the device (browser storage, never
 * synced) and per log, so switching logs shows that log's places. Advisory: unreadable storage means an empty list.
 */
class RecentPlaces {
    places = $state<RecentPlace[]>([]);
    #key: string | null = null;

    /** Loads the list of a log; a no-op while it is already open. */
    open(siteId: string, logId: string): void {
        const key = storageKey(siteId, logId);
        if (key === this.#key) return;
        this.#key = key;
        this.places = read(key);
    }

    /** Moves a place to the front; one entry per title within a section, so a month or a record appears once. */
    record(place: Omit<RecentPlace, 'at'>): void {
        if (!this.#key) return;
        if (this.places[0]?.href === place.href && this.places[0].title === place.title) return;
        const next = [
            { ...place, at: Date.now() },
            ...this.places.filter((entry) => entry.title !== place.title || entry.section !== place.section),
        ].slice(0, LIMIT);
        this.places = next;
        try {
            localStorage.setItem(this.#key, JSON.stringify(next));
        } catch {
            // Storage full or blocked: the list still holds for this tab.
        }
    }
}

export const recentPlaces = new RecentPlaces();

/** The address to return to, without one-shot editor params (`new…`) or the log panel's state. */
export function placeHref(url: URL): string {
    const clean = new URL(url);
    for (const name of [...clean.searchParams.keys()]) {
        if (name.startsWith('new') || (HISTORY_PARAMS as readonly string[]).includes(name)) clean.searchParams.delete(name);
    }
    return clean.pathname + clean.search;
}

/**
 * The place's name from the document title ("October 2026 | Finance | Household" names "October 2026"), or null for
 * a page named only by its section or the site, which the navigation already lists.
 */
export function placeTitle(documentTitle: string, sectionLabel: string, siteTitle: string): string | null {
    const title = documentTitle.split(' | ')[0]?.trim() ?? '';
    if (!title || title === sectionLabel || title === siteTitle) return null;
    return title;
}
