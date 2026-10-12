/**
 * What the public feed Worker and the site Workers agree on: how a feed token
 * is addressed, hashed and found, and what a rendered feed looks like when it
 * crosses the service binding. No Svelte, no `$app/*`, no Worker globals beyond
 * Web Crypto.
 */

/** Every feed is served at `/feed/<token>.ics` on the feed Worker's origin. */
export const FEED_PUBLIC_PREFIX = '/feed';
export const FEED_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
export const FEED_ROUTE = /^\/feed\/([A-Za-z0-9_-]{40,64})\.ics$/;

export function feedUrl(origin: string, token: string): string {
    return `${origin.replace(/\/+$/, '')}${FEED_PUBLIC_PREFIX}/${token}.ics`;
}

export async function hashFeedToken(token: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** R2 key of the pointer that maps a token hash to its feed. */
export function feedTokenKey(tokenHash: string): string {
    return `v1/tokens/${tokenHash}.json`;
}

/** Pointer object stored under `feedTokenKey`; `siteId` names the Worker that renders the feed. */
export interface FeedPointer {
    feedId: string;
    appId: string;
    logId: string;
    siteId: string;
}

export function parseFeedPointer(text: string): FeedPointer | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (value === null || typeof value !== 'object') return null;
    const { feedId, appId, logId, siteId } = value as Record<string, unknown>;
    if (
        typeof feedId !== 'string' || typeof appId !== 'string' || typeof logId !== 'string' ||
        typeof siteId !== 'string' || !SITE_ID.test(siteId)
    ) {
        return null;
    }
    return { feedId, appId, logId, siteId };
}

const SITE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Name of the service binding to one site's renderer; derived, never taken from a request. */
export function siteBindingName(siteId: string): string {
    return `SITE_${siteId.toUpperCase().replace(/-/g, '_')}`;
}

/** A feed as it crosses the service binding: plain data, ready to become a Response. */
export interface RenderedFeed {
    status: number;
    headers: Record<string, string>;
    body: string | null;
}

/** The entrypoint every site Worker exposes to the feed Worker. */
export interface FeedRenderer {
    renderFeed(token: string, headOnly: boolean): Promise<RenderedFeed>;
}
