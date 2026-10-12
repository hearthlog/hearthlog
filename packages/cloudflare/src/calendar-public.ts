/**
 * The public calendar feed Worker.
 *
 * Calendar apps subscribe to a plain URL and cannot sign in, so feeds live here,
 * on their own origin, and the sites keep no Access bypass. This Worker holds no
 * Ledger credential and no Access token. It checks the token against its pointer
 * in R2, then asks the owning site's `CalendarFeedRenderer` entrypoint, reachable
 * only through a service binding, to render the feed. The site picked is the one
 * written into the pointer and mapped to a binding name by a fixed rule, never a
 * value the caller supplies.
 *
 * It never logs a request path (the token is the secret): observability is off
 * in its config and nothing here writes to the console.
 */

import {
    FEED_ROUTE,
    feedTokenKey,
    hashFeedToken,
    parseFeedPointer,
    siteBindingName,
    type FeedRenderer,
    type RenderedFeed,
} from '@hearthlog/contracts/calendar/feed-contract';

export interface CalendarPublicEnv {
    CALENDAR_FEEDS: {
        get(key: string): Promise<{ text(): Promise<string> } | null>;
    };
    /** The canonical origin; any other host answers 404. */
    PUBLIC_ORIGIN: string;
    /** Optional Workers rate-limit binding, keyed by client address. */
    FEEDS_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    /** `SITE_<ID>` service bindings to each site's `CalendarFeedRenderer`. */
    [binding: string]: unknown;
}

const ROBOTS = 'User-agent: *\nDisallow: /\n';

function respond(body: BodyInit | null, status: number, headers: Record<string, string> = {}): Response {
    return new Response(body, {
        status,
        headers: {
            'Cache-Control': 'no-store',
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'X-Robots-Tag': 'noindex, nofollow, noarchive',
            'Referrer-Policy': 'no-referrer',
            ...headers,
        },
    });
}

const notFound = () => respond('Not found', 404);

export async function handleCalendarPublicRequest(request: Request, env: CalendarPublicEnv): Promise<Response> {
    let url: URL;
    try {
        url = new URL(request.url);
    } catch {
        return notFound();
    }
    if (url.origin !== env.PUBLIC_ORIGIN) return notFound();
    if (url.pathname === '/robots.txt') return respond(ROBOTS, 200);

    const match = FEED_ROUTE.exec(url.pathname);
    if (!match) return notFound();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return respond('Method not allowed', 405, { Allow: 'GET, HEAD' });
    }

    if (env.FEEDS_LIMITER) {
        const { success } = await env.FEEDS_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
        if (!success) return respond('Too many requests', 429, { 'Retry-After': '60' });
    }

    const token = match[1]!;
    const pointerObject = await env.CALENDAR_FEEDS.get(feedTokenKey(await hashFeedToken(token)));
    if (!pointerObject) return notFound();
    const pointer = parseFeedPointer(await pointerObject.text());
    if (!pointer) return notFound();
    const renderer = env[siteBindingName(pointer.siteId)] as FeedRenderer | undefined;
    if (!renderer || typeof renderer.renderFeed !== 'function') return notFound();

    let feed: RenderedFeed;
    try {
        feed = await renderer.renderFeed(token, request.method === 'HEAD');
    } catch {
        return respond('The calendar is temporarily unavailable', 503, { 'Retry-After': '60' });
    }
    return new Response(feed.body, {
        status: feed.status,
        headers: {
            ...feed.headers,
            'X-Robots-Tag': 'noindex, nofollow, noarchive',
            'Referrer-Policy': 'no-referrer',
        },
    });
}

export default {
    fetch: handleCalendarPublicRequest,
} satisfies ExportedHandler<CalendarPublicEnv>;
