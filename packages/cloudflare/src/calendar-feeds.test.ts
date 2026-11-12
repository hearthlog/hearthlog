import { describe, expect, it } from 'vitest';
import { feedTokenKey, hashFeedToken, parseFeedPointer } from '@hearthlog/contracts/calendar/feed-contract';
import {
    buildCheckpointEvents,
    checkpointDigest,
    type CheckpointChunk,
    type CheckpointEvent,
    type CheckpointManifest,
} from '@hearthlog/contracts/history/checkpoint';
import {
    handleCalendarFeedManagementRequest,
    renderCalendarFeed,
    type CalendarFeedEnv,
    type CalendarFeedRenderEnv,
} from './calendar-feeds';

const APP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FEED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TOKEN = 'T'.repeat(43);
const SITE_ORIGIN = 'https://alpha.example.workers.dev';
const FEED_ORIGIN = 'https://st-calendar-public.example.workers.dev';

/** R2 as a map; enough of the surface the feed code uses. */
function bucket() {
    const objects = new Map<string, string>();
    return {
        objects,
        get: async (key: string) => (objects.has(key) ? { text: async () => objects.get(key)! } : null),
        put: async (key: string, value: string) => { objects.set(key, value); },
        delete: async (key: string) => { objects.delete(key); },
        list: async ({ prefix }: { prefix: string }) => ({
            objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        }),
    };
}

const today = new Date().toISOString().slice(0, 10);

function ledger() {
    return {
        fetch: async (request: Request) => {
            const { pathname } = new URL(request.url);
            if (pathname === '/session') return Response.json({ appId: APP });
            if (pathname === `/logs/${LOG}`) return Response.json({ id: LOG, name: 'Home', headVersion: 1 });
            if (pathname === `/logs/${LOG}/events`) {
                return Response.json({
                    events: [{
                        id: 'e1', version: 1, type: 'CALENDAR_EVENT_ADDED', entityId: 'calendar_event:11111111-1111-4111-8111-111111111111',
                        entityVersion: 1, timestamp: 1,
                        payload: { id: '11111111-1111-4111-8111-111111111111', title: 'Dentist', eventDate: today, startTime: '09:30', notes: '' },
                    }],
                });
            }
            return new Response('{}', { status: 404 });
        },
    };
}

function seed(store: ReturnType<typeof bucket>, overrides: { siteId?: string; expiresAt?: string | null } = {}) {
    store.objects.set(
        `v1/feeds/${APP}/${LOG}/${FEED}.json`,
        JSON.stringify({
            feedId: FEED, appId: APP, logId: LOG, tokenHash: 'x', label: 'Phone', sources: null,
            windowDays: { pastDays: 30, futureDays: 30 }, createdBy: 'a@example.com', createdAt: '2026-10-01T00:00:00.000Z',
            lastAccessedAt: null, expiresAt: overrides.expiresAt ?? null,
        }),
    );
    return hashFeedToken(TOKEN).then((hash) => {
        store.objects.set(feedTokenKey(hash), JSON.stringify({ feedId: FEED, appId: APP, logId: LOG, siteId: overrides.siteId ?? 'alpha' }));
    });
}

function renderEnv(store = bucket(), overrides: Partial<CalendarFeedRenderEnv> = {}): CalendarFeedRenderEnv {
    return {
        CALENDAR_FEEDS: store,
        LEDGER: ledger(),
        LEDGER_AUTH_TOKEN: 'token',
        SITE_ID: 'alpha',
        SITE_ORIGIN,
        ...overrides,
    } as unknown as CalendarFeedRenderEnv;
}

/** A Ledger serving `history`, optionally with a verified snapshot through `through`; records each events read. */
async function snapshotLedger(history: CheckpointEvent[], through: number | null) {
    const reads: number[] = [];
    const head = history.length;
    let manifest: CheckpointManifest | null = null;
    let chunk: CheckpointChunk | null = null;
    if (through !== null) {
        chunk = { events: buildCheckpointEvents(history.filter((event) => event.version <= through), through), claims: [] };
        const text = JSON.stringify(chunk);
        const pages = [{ key: 'p0', sha256: await checkpointDigest(text), count: chunk.events.length, bytes: text.length }];
        manifest = { format: 1, appId: APP, logId: LOG, id: 'checkpoint', throughVersion: through, createdAt: '2026-11-01T00:00:00Z',
            pages, eventCount: chunk.events.length, sourceEventCount: through, sha256: await checkpointDigest(JSON.stringify(pages)) };
    }
    return {
        reads,
        fetch: async (request: Request) => {
            const url = new URL(request.url);
            if (url.pathname === '/session') return Response.json({ appId: APP, capabilities: manifest ? ['snapshot-baseline-v1'] : [] });
            if (url.pathname === `/logs/${LOG}`) return Response.json({ id: LOG, name: 'Home', headVersion: head });
            if (url.pathname === `/logs/${LOG}/maintenance`) return Response.json({ checkpoint: manifest });
            if (url.pathname === `/logs/${LOG}/checkpoint`) return Response.json(chunk);
            if (url.pathname === `/logs/${LOG}/events`) {
                const after = Number(url.searchParams.get('afterVersion'));
                reads.push(after);
                return Response.json({ events: history.filter((event) => event.version > after) });
            }
            return new Response('{}', { status: 404 });
        },
    };
}

function calendarHistory(): CheckpointEvent[] {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    const facts: Array<[number, string, Record<string, unknown>]> = [
        [0, 'CALENDAR_EVENT_ADDED', { title: 'Dentist', eventDate: today, startTime: '09:30', notes: '' }],
        [1, 'CALENDAR_EVENT_ADDED', { title: 'Gym', eventDate: today, startTime: '18:00', notes: '' }],
        [0, 'CALENDAR_EVENT_UPDATED', { title: 'Dentist (moved)', startTime: '10:00' }],
        [2, 'CALENDAR_EVENT_ADDED', { title: 'Dinner', eventDate: today, startTime: '20:00', notes: '' }],
        [1, 'CALENDAR_EVENT_REMOVED', {}],
        [2, 'CALENDAR_EVENT_UPDATED', { title: 'Dinner with Ana' }],
        [0, 'CALENDAR_EVENT_UPDATED', { notes: 'bring card' }],
        [2, 'CALENDAR_EVENT_UPDATED', { startTime: '19:30' }],
    ];
    const versions = new Map<string, number>();
    const records = new Map<string, Record<string, unknown>>();
    return facts.map(([index, type, fields], position) => {
        const id = ids[index]!;
        const entityVersion = (versions.get(id) ?? 0) + 1;
        versions.set(id, entityVersion);
        // Saves carry the whole record, as the app sends them.
        const payload = type.endsWith('_REMOVED') ? { id } : { ...records.get(id), id, ...fields };
        records.set(id, payload);
        return { id: `e${position + 1}`, version: position + 1, type, entityId: `calendar_event:${id}`, entityVersion,
            timestamp: position + 1, payload };
    });
}

async function renderWith(fetcher: { fetch: (request: Request) => Promise<Response> }) {
    const store = bucket();
    await seed(store);
    return (await renderCalendarFeed(TOKEN, false, renderEnv(store, { LEDGER: fetcher as never }))).body;
}

describe('rendering a feed from a snapshot', () => {
    it('folds the snapshot plus the events after it into the same calendar as the whole log', async () => {
        const history = calendarHistory();
        const full = await snapshotLedger(history, null);
        const expected = await renderWith(full);
        expect(expected).toContain('Dinner with Ana');
        expect(full.reads).toEqual([0]);
        const snapshot = await snapshotLedger(history, 5);
        expect(await renderWith(snapshot)).toBe(expected);
        expect(snapshot.reads).toEqual([5]);
    });

    it('reads the whole log when an undo after the snapshot reaches back into it', async () => {
        const history = calendarHistory();
        history.push({ id: 'e9', version: 9, type: 'EVENT_TOMBSTONED', entityId: 'calendar_event:11111111-1111-4111-8111-111111111111',
            entityVersion: 5, timestamp: 9, payload: { eventId: 'e3' } });
        const expected = await renderWith(await snapshotLedger(history, null));
        const snapshot = await snapshotLedger(history, 5);
        expect(await renderWith(snapshot)).toBe(expected);
        expect(snapshot.reads).toEqual([5, 0]);
    });
});

describe('rendering a feed', () => {
    it('names events after the site, never the host that serves the feed', async () => {
        const store = bucket();
        await seed(store);
        const feed = await renderCalendarFeed(TOKEN, false, renderEnv(store));
        expect(feed.status).toBe(200);
        expect(feed.headers['Content-Type']).toBe('text/calendar; charset=utf-8');
        const ics = feed.body ?? '';
        expect(ics).toContain('SUMMARY:Dentist');
        expect(ics).toMatch(/UID:event-11111111-1111-4111-8111-111111111111@alpha\.example\.workers\.dev/);
        expect(ics).not.toContain('st-calendar-public');
    });

    it('answers HEAD without a body and serves the cached copy next time', async () => {
        const store = bucket();
        await seed(store);
        const head = await renderCalendarFeed(TOKEN, true, renderEnv(store));
        expect(head.status).toBe(200);
        expect(head.body).toBeNull();
        const writes = [...store.objects.keys()].filter((key) => key.startsWith('v1/ics/'));
        expect(writes).toHaveLength(1);
        const again = await renderCalendarFeed(TOKEN, false, renderEnv(store, { LEDGER: { fetch: async () => new Response('{}', { status: 500 }) } as never }));
        expect(again.status).toBe(503);
        const cachedEnv = renderEnv(store);
        expect((await renderCalendarFeed(TOKEN, false, cachedEnv)).body).toContain('Dentist');
    });

    it('does not reveal why a token is refused', async () => {
        const store = bucket();
        await seed(store, { siteId: 'bravo' });
        expect((await renderCalendarFeed(TOKEN, false, renderEnv(store))).status).toBe(404);
        expect((await renderCalendarFeed('U'.repeat(43), false, renderEnv(store))).status).toBe(404);
        const expired = bucket();
        await seed(expired, { expiresAt: '2020-01-01T00:00:00.000Z' });
        expect((await renderCalendarFeed(TOKEN, false, renderEnv(expired))).status).toBe(404);
    });

    it('is unconfigured without a site identity', async () => {
        const feed = await renderCalendarFeed(TOKEN, false, renderEnv(bucket(), { SITE_ID: '' as never }));
        expect(feed.status).toBe(503);
    });
});

describe('creating a feed', () => {
    it('returns a URL on the feed Worker and records which site renders it', async () => {
        const store = bucket();
        const env = {
            ...renderEnv(store),
            CF_ACCESS_APP_AUD: 'aud',
            CF_ACCESS_TEAM_DOMAIN: 'https://team.example',
            STOR_AUTHORIZED_EMAILS: 'a@example.com',
            CALENDAR_FEED_ORIGIN: FEED_ORIGIN,
        } as unknown as CalendarFeedEnv;
        const request = new Request(`${SITE_ORIGIN}/api/calendar-feeds/v1`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ logId: LOG, label: 'Phone' }),
        });
        const response = await handleCalendarFeedManagementRequest(request, env, async () => ({ email: 'a@example.com' }));
        expect(response.status).toBe(201);
        const body = await response.json() as { token: string; url: string };
        expect(body.url).toBe(`${FEED_ORIGIN}/feed/${body.token}.ics`);

        const pointerText = store.objects.get(feedTokenKey(await hashFeedToken(body.token)));
        expect(parseFeedPointer(pointerText ?? '')).toMatchObject({ appId: APP, logId: LOG, siteId: 'alpha' });
    });
});
