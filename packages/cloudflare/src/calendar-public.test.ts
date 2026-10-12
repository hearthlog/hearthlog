import { describe, expect, it, vi } from 'vitest';
import { feedTokenKey, hashFeedToken, type RenderedFeed } from '@hearthlog/contracts/calendar/feed-contract';
import { handleCalendarPublicRequest, type CalendarPublicEnv } from './calendar-public';

const ORIGIN = 'https://feeds.example.workers.dev';
const TOKEN = 'T'.repeat(43);
const RENDERED: RenderedFeed = {
    status: 200,
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', ETag: '"v3"' },
    body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
};

async function env(overrides: Record<string, unknown> = {}, pointer: Record<string, unknown> | null = { feedId: 'f', appId: 'a', logId: 'l', siteId: 'alpha' }) {
    const key = feedTokenKey(await hashFeedToken(TOKEN));
    const renderFeed = vi.fn(async (_token: string, _head: boolean) => RENDERED);
    const config = {
        PUBLIC_ORIGIN: ORIGIN,
        CALENDAR_FEEDS: { get: async (requested: string) => (pointer && requested === key ? { text: async () => JSON.stringify(pointer) } : null) },
        SITE_ALPHA: { renderFeed },
        ...overrides,
    } as CalendarPublicEnv;
    return { config, renderFeed };
}

const get = (path: string, init: RequestInit = {}, origin = ORIGIN) => new Request(`${origin}${path}`, init);
const feedPath = `/feed/${TOKEN}.ics`;

describe('the public calendar Worker', () => {
    it('serves the feed its site renders, marked noindex', async () => {
        const { config, renderFeed } = await env();
        const response = await handleCalendarPublicRequest(get(feedPath), config);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(RENDERED.body);
        expect(response.headers.get('Content-Type')).toBe('text/calendar; charset=utf-8');
        expect(response.headers.get('ETag')).toBe('"v3"');
        expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
        expect(renderFeed).toHaveBeenCalledWith(TOKEN, false);
    });

    it('asks for headers only on HEAD', async () => {
        const { config, renderFeed } = await env();
        await handleCalendarPublicRequest(get(feedPath, { method: 'HEAD' }), config);
        expect(renderFeed).toHaveBeenCalledWith(TOKEN, true);
    });

    it('answers 404 without calling a site for an unknown token, a malformed pointer or an unbound site', async () => {
        const unknown = await env({}, null);
        expect((await handleCalendarPublicRequest(get(feedPath), unknown.config)).status).toBe(404);
        const malformed = await env({}, { feedId: 'f' });
        expect((await handleCalendarPublicRequest(get(feedPath), malformed.config)).status).toBe(404);
        const unbound = await env({}, { feedId: 'f', appId: 'a', logId: 'l', siteId: 'elsewhere' });
        expect((await handleCalendarPublicRequest(get(feedPath), unbound.config)).status).toBe(404);
        // A site id that would name another binding, such as the bucket, is not a site.
        const sneaky = await env({}, { feedId: 'f', appId: 'a', logId: 'l', siteId: 'x' });
        expect((await handleCalendarPublicRequest(get(feedPath), { ...sneaky.config, SITE_X: 'not a service' } as never)).status).toBe(404);
        for (const { renderFeed } of [unknown, malformed, unbound]) expect(renderFeed).not.toHaveBeenCalled();
    });

    it('serves only the canonical host, GET and HEAD, and the feed route', async () => {
        const { config } = await env();
        expect((await handleCalendarPublicRequest(get(feedPath, {}, 'https://other.example.workers.dev'), config)).status).toBe(404);
        expect((await handleCalendarPublicRequest(get(feedPath, { method: 'POST' }), config)).status).toBe(405);
        expect((await handleCalendarPublicRequest(get('/api/calendar-feed/' + TOKEN + '.ics'), config)).status).toBe(404);
        expect((await handleCalendarPublicRequest(get('/feed/short.ics'), config)).status).toBe(404);
        const robots = await handleCalendarPublicRequest(get('/robots.txt'), config);
        expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
    });

    it('limits requests per client address before reading anything', async () => {
        const limit = vi.fn(async () => ({ success: false }));
        const { config, renderFeed } = await env({ FEEDS_LIMITER: { limit } });
        const response = await handleCalendarPublicRequest(get(feedPath, { headers: { 'CF-Connecting-IP': '203.0.113.9' } }), config);
        expect(response.status).toBe(429);
        expect(limit).toHaveBeenCalledWith({ key: '203.0.113.9' });
        expect(renderFeed).not.toHaveBeenCalled();
    });

    it('reports a site that cannot answer as temporarily unavailable', async () => {
        const { config } = await env({ SITE_ALPHA: { renderFeed: async () => { throw new Error('boom'); } } });
        const response = await handleCalendarPublicRequest(get(feedPath), config);
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain('boom');
    });
});
