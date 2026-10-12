/**
 * Client for the Worker calendar-feed registry.
 *
 * Every call is same-origin and Access-authenticated. The feed token is only
 * ever returned by `createCalendarFeed`; the listing never includes it.
 */

export interface CalendarFeedWindow {
    pastDays: number;
    futureDays: number;
}

export interface CalendarFeedSummary {
    feedId: string;
    appId: string;
    logId: string;
    label: string;
    /** Source keys, or null for "all sources". */
    sources: string[] | null;
    windowDays: CalendarFeedWindow;
    createdBy: string;
    createdAt: string;
    lastAccessedAt: string | null;
    expiresAt: string | null;
}

export interface CreatedCalendarFeed {
    feed: CalendarFeedSummary;
    token: string;
    url: string;
}

export interface CalendarFeedDraft {
    label: string;
    sources: string[] | null;
    windowDays: CalendarFeedWindow;
}

const ENDPOINT = '/api/calendar-feeds/v1';

export function createCalendarFeed(
    logId: string,
    draft: CalendarFeedDraft,
): Promise<CreatedCalendarFeed> {
    return request<CreatedCalendarFeed>(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logId, ...draft }),
    });
}

export async function listCalendarFeeds(logId: string): Promise<CalendarFeedSummary[]> {
    const body = await request<{ feeds: CalendarFeedSummary[] }>(
        `${ENDPOINT}?logId=${encodeURIComponent(logId)}`,
    );
    return body.feeds;
}

export function revokeCalendarFeed(logId: string, feedId: string): Promise<void> {
    return request<void>(
        `${ENDPOINT}/${encodeURIComponent(feedId)}?logId=${encodeURIComponent(logId)}`,
        { method: 'DELETE' },
    );
}

/** Convert the https feed URL into a `webcal://` URL for one-click subscribe. */
export function webcalUrl(url: string): string {
    return url.replace(/^https?:/, 'webcal:');
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, { credentials: 'same-origin', ...init });
    if (!response.ok) {
        let message = `Calendar feed request failed (${response.status})`;
        try {
            const body: unknown = await response.json();
            if (
                body &&
                typeof body === 'object' &&
                typeof (body as { error?: unknown }).error === 'string'
            ) {
                message = (body as { error: string }).error;
            }
        } catch {
            // Keep the status-based message.
        }
        throw new Error(message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
}
