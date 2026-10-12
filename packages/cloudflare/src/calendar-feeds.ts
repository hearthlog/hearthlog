/**
 * Calendar feed registry and public feed serving.
 *
 * Feed registration is user-level and Access-protected (`/api/calendar-feeds/v1`).
 * Feeds are served by a separate public Worker (`calendar-public/`) at
 * `/feed/<token>.ics` on its own origin, so this site has no Access bypass. That
 * Worker holds no Ledger credential: it finds the owning site in the token's
 * pointer and asks this Worker's `CalendarFeedRenderer` entrypoint to render.
 * Tokens are random 256-bit values stored only as SHA-256, so validation is a
 * single strongly consistent R2 GET keyed by the hash.
 *
 * Ledger stays read-only here: registration verifies the log scope with
 * `verifyLogAppId`, and rendering folds accepted events fetched over the LEDGER
 * service binding.
 */

import {
    authorizeStorRequest,
    LedgerAdminConfigurationError,
    type LedgerAdminIdentity,
} from "./access-auth";
import {
    foldCalendarItems,
    type AcceptedCalendarEvent,
    type CalendarFeedWindow as FoldedCalendarWindow,
    type FoldedCalendarItem,
} from "@hearthlog/contracts/calendar/fold";
import { serializeIcs, type IcsEventInput } from "@hearthlog/contracts/calendar/ics";
import { calendarItemHref } from "@hearthlog/contracts/calendar/sources";
import {
    feedTokenKey,
    feedUrl,
    hashFeedToken,
    parseFeedPointer,
    type FeedPointer,
    type RenderedFeed,
} from "@hearthlog/contracts/calendar/feed-contract";
import { LedgerScopeError, verifyLogAppId } from "./ledger-scope";
import { readBodyCapped } from "./request-body";

const MANAGEMENT_PREFIX = "/api/calendar-feeds/v1";
const MAX_BODY_BYTES = 4096;
const MAX_FEEDS_PER_LOG = 100;
const MAX_SOURCES = 30;
const MAX_LABEL_LENGTH = 60;
const MAX_PAST_DAYS = 730;
const MAX_FUTURE_DAYS = 1825;
const DEFAULT_PAST_DAYS = 183;
const DEFAULT_FUTURE_DAYS = 548;
const EVENT_PAGE_SIZE = 512;
/** ~10k events; larger logs fall back to "too large" instead of stalling. */
const MAX_EVENT_PAGES = 20;
const FEED_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const UUID_PATTERN =
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID = new RegExp(`^${UUID_PATTERN}$`);
const SOURCE_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MANAGEMENT_ROUTE = new RegExp(`^${MANAGEMENT_PREFIX}/(${UUID_PATTERN})$`);

export interface CalendarFeedWindow {
    pastDays: number;
    futureDays: number;
}

/** Stored feed registration (never returned to clients as-is). */
export interface CalendarFeedRecord {
    feedId: string;
    appId: string;
    logId: string;
    /** SHA-256 hex of the token; the pointer object is keyed by this value. */
    tokenHash: string;
    label: string;
    /** Source keys, or null for "every enabled source". */
    sources: string[] | null;
    windowDays: CalendarFeedWindow;
    createdBy: string;
    createdAt: string;
    lastAccessedAt: string | null;
    expiresAt: string | null;
}

/** Feed shape returned by the management API; never includes the token. */
export type CalendarFeedPublic = Omit<CalendarFeedRecord, "tokenHash">;

/** Pointer object stored under `v1/tokens/<hash>.json`. */
type CalendarFeedPointer = FeedPointer;

/**
 * Structural subset of R2 used here so handlers can be unit-tested with fakes.
 * `R2Bucket` satisfies it.
 */
export interface CalendarFeedBucket {
    get(key: string): Promise<{ text(): Promise<string> } | null>;
    put(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<void>;
    list(options: {
        prefix: string;
        limit?: number;
    }): Promise<{ objects: Array<{ key: string }> }>;
}

export type CalendarFeedEnv = Pick<
    Env,
    | "CF_ACCESS_APP_AUD"
    | "CF_ACCESS_TEAM_DOMAIN"
    | "STOR_AUTHORIZED_EMAILS"
    | "LEDGER"
    | "LEDGER_AUTH_TOKEN"
    | "CALENDAR_FEEDS"
    | "SITE_ID"
    | "SITE_ORIGIN"
    | "CALENDAR_FEED_ORIGIN"
>;

/** What rendering a feed needs; the public Worker reaches it through `CalendarFeedRenderer`. */
export type CalendarFeedRenderEnv = Pick<
    CalendarFeedEnv,
    "LEDGER" | "LEDGER_AUTH_TOKEN" | "CALENDAR_FEEDS" | "SITE_ID" | "SITE_ORIGIN"
>;

type StorAuthorizer = (
    request: Request,
    env: CalendarFeedEnv,
) => Promise<LedgerAdminIdentity>;

interface ManagementRoute {
    kind: "collection" | "feed";
    feedId?: string;
}

export async function handleCalendarFeedManagementRequest(
    request: Request,
    env: CalendarFeedEnv,
    authorize: StorAuthorizer = authorizeStorRequest,
): Promise<Response> {
    const url = parseRequestUrl(request);
    if (!url) return feedError(400, "invalid_request_url", "The request URL is invalid");
    const route = parseManagementRoute(url.pathname);
    if (!route) {
        return feedError(404, "calendar_feed_route_not_found", "Calendar feed route not found");
    }
    if (!env.LEDGER_AUTH_TOKEN || !env.CALENDAR_FEEDS || !env.CALENDAR_FEED_ORIGIN || !env.SITE_ID) {
        return feedError(503, "calendar_feeds_unconfigured", "Calendar feeds are not configured");
    }
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) {
        return feedError(403, "origin_not_allowed", "Cross-origin calendar feed requests are not allowed");
    }

    let identity: LedgerAdminIdentity;
    try {
        identity = await authorize(request, env);
    } catch (error) {
        if (error instanceof LedgerAdminConfigurationError) {
            return feedError(503, "calendar_feeds_unconfigured", "Calendar feeds are not configured");
        }
        return feedError(403, "calendar_feeds_forbidden", "Hearthlog access is required");
    }

    if (route.kind === "collection") {
        if (request.method === "POST") {
            return createFeed(request, env, identity);
        }
        if (request.method === "GET") {
            return listFeeds(url, env);
        }
        return methodNotAllowed("GET, POST");
    }
    if (request.method === "DELETE") {
        return deleteFeed(url, env, route.feedId!);
    }
    return methodNotAllowed("DELETE");
}

/**
 * Structural subset of R2 for the feed registry. Production binds an R2Bucket;
 * the runtime only ever GETs whole objects (R2ObjectBody carries `text()`), and
 * the subset keeps handlers unit-testable with fakes.
 */
function feedBucket(env: CalendarFeedEnv): CalendarFeedBucket {
    // SAFETY: the production binding is an R2Bucket, which provides every method
    // used here; the narrower type is a deliberate seam for unit tests.
    return env.CALENDAR_FEEDS as unknown as CalendarFeedBucket;
}

async function createFeed(
    request: Request,
    env: CalendarFeedEnv,
    identity: LedgerAdminIdentity,
): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body) {
        return feedError(400, "invalid_feed_request", "A JSON request body is required");
    }
    const logId = typeof body.logId === "string" ? body.logId.toLowerCase() : "";
    if (!UUID.test(logId)) {
        return feedError(400, "invalid_feed_request", "A valid logId is required");
    }
    const sources = normalizeSources(body.sources);
    if (sources === undefined) {
        return feedError(400, "invalid_feed_request", "sources must be a list of source keys");
    }
    const windowDays = normalizeWindow(body.windowDays);
    if (!windowDays) {
        return feedError(
            400,
            "invalid_feed_request",
            `windowDays.pastDays must be 0-${MAX_PAST_DAYS} and futureDays 1-${MAX_FUTURE_DAYS}`,
        );
    }
    const label = normalizeLabel(body.label);
    if (label === undefined) {
        return feedError(400, "invalid_feed_request", `label must be 1-${MAX_LABEL_LENGTH} characters`);
    }

    let appId: string;
    try {
        appId = await verifyLogAppId(logId, env);
    } catch (error) {
        return scopeError(error);
    }

    const token = randomToken();
    const tokenHash = await hashFeedToken(token);
    const feedId = crypto.randomUUID();
    const now = new Date().toISOString();
    const record: CalendarFeedRecord = {
        feedId,
        appId,
        logId,
        tokenHash,
        label,
        sources,
        windowDays,
        createdBy: identity.email,
        createdAt: now,
        lastAccessedAt: null,
        expiresAt: null,
    };

    const bucket = feedBucket(env);
    const pointer: CalendarFeedPointer = { feedId, appId, logId, siteId: env.SITE_ID };
    await bucket.put(feedKey(appId, logId, feedId), JSON.stringify(record));
    await bucket.put(feedTokenKey(tokenHash), JSON.stringify(pointer));

    return feedJson(
        {
            feed: toPublicFeed(record),
            token,
            url: feedUrl(env.CALENDAR_FEED_ORIGIN, token),
        },
        201,
    );
}

async function listFeeds(url: URL, env: CalendarFeedEnv): Promise<Response> {
    const logId = (url.searchParams.get("logId") ?? "").toLowerCase();
    if (!UUID.test(logId)) {
        return feedError(400, "invalid_feed_request", "A valid logId is required");
    }
    let appId: string;
    try {
        appId = await verifyLogAppId(logId, env);
    } catch (error) {
        return scopeError(error);
    }

    const bucket = feedBucket(env);
    const listing = await bucket.list({
        prefix: feedPrefix(appId, logId),
        limit: MAX_FEEDS_PER_LOG,
    });
    const feeds: CalendarFeedPublic[] = [];
    for (const object of listing.objects) {
        const record = await readFeedRecord(bucket, object.key);
        if (record) feeds.push(toPublicFeed(record));
    }
    feeds.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return feedJson({ feeds });
}

async function deleteFeed(
    url: URL,
    env: CalendarFeedEnv,
    feedId: string,
): Promise<Response> {
    const logId = (url.searchParams.get("logId") ?? "").toLowerCase();
    if (!UUID.test(logId)) {
        return feedError(400, "invalid_feed_request", "A valid logId is required");
    }
    let appId: string;
    try {
        appId = await verifyLogAppId(logId, env);
    } catch (error) {
        return scopeError(error);
    }

    const bucket = feedBucket(env);
    const key = feedKey(appId, logId, feedId);
    const record = await readFeedRecord(bucket, key);
    if (record) {
        await bucket.delete(feedTokenKey(record.tokenHash));
        await bucket.delete(key);
    }
    return new Response(null, { status: 204, headers: securityHeaders() });
}

/**
 * Render one feed for the public Worker. Tokens are looked up by hash; content
 * is rebuilt from Ledger events and cached by head version. The feed carries
 * this site's own origin in its UIDs and item links, wherever it is served from,
 * so a subscribed calendar sees the same events whichever host answers.
 */
export async function renderCalendarFeed(
    token: string,
    headOnly: boolean,
    env: CalendarFeedRenderEnv,
): Promise<RenderedFeed> {
    if (!env.LEDGER_AUTH_TOKEN || !env.CALENDAR_FEEDS || !env.SITE_ORIGIN || !env.SITE_ID) {
        return feedFailure(503, "calendar_feeds_unconfigured", "Calendar feeds are not configured");
    }
    const notFound = () => feedFailure(404, "calendar_feed_not_found", "Calendar feed not found");

    const bucket = env.CALENDAR_FEEDS as unknown as CalendarFeedBucket;
    const pointerObject = await bucket.get(feedTokenKey(await hashFeedToken(token)));
    if (!pointerObject) return notFound();
    const pointer = parseFeedPointer(await pointerObject.text());
    // A token of another site's feed is never rendered here.
    if (!pointer || pointer.siteId !== env.SITE_ID) return notFound();
    const record = await readFeedRecord(
        bucket,
        feedKey(pointer.appId, pointer.logId, pointer.feedId),
    );
    if (!record) return notFound();
    if (record.expiresAt && record.expiresAt <= new Date().toISOString()) return notFound();

    const log = await fetchLog(env, record.logId);
    if (!log) return feedFailure(503, "ledger_unavailable", "The calendar is temporarily unavailable");

    const cacheKey = `v1/ics/${record.appId}/${record.logId}/${await configFingerprint(record)}-${log.headVersion}.ics`;
    const cached = await bucket.get(cacheKey);
    if (cached) {
        await touchFeed(bucket, record);
        return icsFeed(await cached.text(), log.headVersion, headOnly);
    }

    const events = await fetchAcceptedEvents(env, record.logId, log.headVersion);
    if (events === null) {
        return feedFailure(503, "ledger_unavailable", "The calendar is temporarily unavailable");
    }
    if (events === "too-large") {
        return feedFailure(
            503,
            "calendar_feed_too_large",
            "This log is too large for an on-demand calendar feed",
        );
    }

    const site = new URL(env.SITE_ORIGIN);
    const items = foldCalendarItems(events, log.headVersion, {
        sources: record.sources,
        window: feedWindow(record),
    });
    const ics = serializeIcs(items.map((item) => icsEvent(item, site.origin)), {
        name: `${log.name} · ${record.label}`,
        uidDomain: site.hostname,
    });
    await bucket.put(cacheKey, ics);
    await touchFeed(bucket, record);
    return icsFeed(ics, log.headVersion, headOnly);
}

interface LedgerLog {
    name: string;
    headVersion: number;
}

async function fetchLog(env: CalendarFeedRenderEnv, logId: string): Promise<LedgerLog | null> {
    try {
        const response = await env.LEDGER.fetch(ledgerRequest(env, `/logs/${logId}`));
        if (!response.ok) return null;
        const body: unknown = await response.json();
        if (!body || typeof body !== "object") return null;
        const record = body as Record<string, unknown>;
        if (typeof record.headVersion !== "number") return null;
        return {
            name: typeof record.name === "string" ? record.name : "Log",
            headVersion: record.headVersion,
        };
    } catch {
        return null;
    }
}

/**
 * Fetch accepted events up to the head version, page by page. Returns
 * `"too-large"` when the log exceeds the page budget, and null on transport
 * failure.
 */
async function fetchAcceptedEvents(
    env: CalendarFeedRenderEnv,
    logId: string,
    headVersion: number,
): Promise<AcceptedCalendarEvent[] | "too-large" | null> {
    const events: AcceptedCalendarEvent[] = [];
    let after = 0;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        let response: Response;
        try {
            response = await env.LEDGER.fetch(
                ledgerRequest(
                    env,
                    `/logs/${logId}/events?afterVersion=${after}&limit=${EVENT_PAGE_SIZE}`,
                ),
            );
        } catch {
            return null;
        }
        if (!response.ok) return null;
        const body: unknown = await response.json();
        const list =
            body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events)
                ? (body as { events: unknown[] }).events
                : [];
        for (const entry of list) {
            const event = normalizeAcceptedEvent(entry);
            if (event) events.push(event);
        }
        if (list.length < EVENT_PAGE_SIZE) return events;
        const last = normalizeAcceptedEvent(list[list.length - 1]);
        if (!last || last.version <= after) return events;
        after = last.version;
        if (after >= headVersion) return events;
    }
    return "too-large";
}

function normalizeAcceptedEvent(value: unknown): AcceptedCalendarEvent | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (
        typeof raw.id !== "string" ||
        typeof raw.version !== "number" ||
        typeof raw.type !== "string" ||
        typeof raw.entityId !== "string" ||
        typeof raw.entityVersion !== "number"
    ) {
        return null;
    }
    let payload: Record<string, unknown> = {};
    if (raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)) {
        payload = raw.payload as Record<string, unknown>;
    } else if (typeof raw.payload === "string") {
        try {
            const parsed: unknown = JSON.parse(raw.payload);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                payload = parsed as Record<string, unknown>;
            }
        } catch {
            payload = {};
        }
    }
    return {
        id: raw.id,
        version: raw.version,
        type: raw.type,
        entityId: raw.entityId,
        entityVersion: raw.entityVersion,
        payload,
    };
}

function ledgerRequest(env: CalendarFeedRenderEnv, path: string): Request {
    return new Request(`https://ledger.internal${path}`, {
        headers: { Authorization: `Bearer ${env.LEDGER_AUTH_TOKEN}` },
    });
}

/** Feed window relative to today; the Worker has no tenant clock. */
function feedWindow(
    record: CalendarFeedRecord,
    now = new Date(),
): FoldedCalendarWindow {
    const today = utcDay(now);
    return {
        startDate: shiftDay(today, -record.windowDays.pastDays),
        endDate: shiftDay(today, record.windowDays.futureDays),
    };
}

function utcDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function shiftDay(day: string, amount: number): string {
    const [year, month, date] = day.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, date + amount)).toISOString().slice(0, 10);
}

async function configFingerprint(record: CalendarFeedRecord): Promise<string> {
    const fingerprint = `${record.sources?.join(",") ?? "*"}|${record.windowDays.pastDays}|${record.windowDays.futureDays}`;
    return (await hashFeedToken(fingerprint)).slice(0, 16);
}

function icsEvent(item: FoldedCalendarItem, origin: string): IcsEventInput {
    const href = calendarItemHref({
        sourceKey: item.sourceKey,
        id: item.id,
        date: item.startDate,
        entityName: item.entityName,
        params: item.params,
    });
    let url: string | undefined;
    if (href) {
        try {
            url = new URL(href, origin).href;
        } catch {
            url = undefined;
        }
    }
    return {
        uid: `${item.sourceKey}-${item.id}`,
        title: item.title,
        description: item.subtitle || undefined,
        url,
        category: item.label,
        startDate: item.startDate,
        endDate: item.endDate ?? undefined,
        startTime: item.startTime || undefined,
        endTime: item.endTime || undefined,
    };
}

function icsFeed(ics: string, headVersion: number, headOnly: boolean): RenderedFeed {
    return {
        status: 200,
        headers: {
            ...securityHeaders(),
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": 'inline; filename="calendar.ics"',
            ETag: `"v${headVersion}"`,
        },
        body: headOnly ? null : ics,
    };
}

function feedFailure(status: number, code: string, error: string): RenderedFeed {
    return {
        status,
        headers: { ...securityHeaders(), "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error, code }),
    };
}

/** Best-effort access bookkeeping, at most hourly. */
async function touchFeed(bucket: CalendarFeedBucket, record: CalendarFeedRecord): Promise<void> {
    const now = Date.now();
    const last = record.lastAccessedAt ? Date.parse(record.lastAccessedAt) : 0;
    if (Number.isFinite(last) && now - last < FEED_TOUCH_INTERVAL_MS) return;
    try {
        await bucket.put(
            feedKey(record.appId, record.logId, record.feedId),
            JSON.stringify({ ...record, lastAccessedAt: new Date(now).toISOString() }),
        );
    } catch {
        // Bookkeeping must never fail the feed.
    }
}

async function readFeedRecord(
    bucket: CalendarFeedBucket,
    key: string,
): Promise<CalendarFeedRecord | null> {
    const object = await bucket.get(key);
    if (!object) return null;
    try {
        return JSON.parse(await object.text()) as CalendarFeedRecord;
    } catch {
        return null;
    }
}

function toPublicFeed(record: CalendarFeedRecord): CalendarFeedPublic {
    const { tokenHash: _tokenHash, ...publicFeed } = record;
    return publicFeed;
}

function parseManagementRoute(pathname: string): ManagementRoute | null {
    if (pathname === MANAGEMENT_PREFIX) return { kind: "collection" };
    const match = pathname.match(MANAGEMENT_ROUTE);
    return match ? { kind: "feed", feedId: match[1].toLowerCase() } : null;
}

function normalizeSources(value: unknown): string[] | null | undefined {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value) || value.length > MAX_SOURCES) return undefined;
    const sources: string[] = [];
    for (const entry of value) {
        if (typeof entry !== "string" || !SOURCE_KEY.test(entry)) return undefined;
        if (!sources.includes(entry)) sources.push(entry);
    }
    return sources.length > 0 ? sources : null;
}

function normalizeWindow(value: unknown): CalendarFeedWindow | null {
    if (value === undefined || value === null) {
        return { pastDays: DEFAULT_PAST_DAYS, futureDays: DEFAULT_FUTURE_DAYS };
    }
    if (typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const pastDays = record.pastDays === undefined ? DEFAULT_PAST_DAYS : record.pastDays;
    const futureDays = record.futureDays === undefined ? DEFAULT_FUTURE_DAYS : record.futureDays;
    if (
        typeof pastDays !== "number" ||
        !Number.isInteger(pastDays) ||
        pastDays < 0 ||
        pastDays > MAX_PAST_DAYS
    ) {
        return null;
    }
    if (
        typeof futureDays !== "number" ||
        !Number.isInteger(futureDays) ||
        futureDays < 1 ||
        futureDays > MAX_FUTURE_DAYS
    ) {
        return null;
    }
    return { pastDays, futureDays };
}

function normalizeLabel(value: unknown): string | undefined {
    if (value === undefined || value === null) return "Calendar feed";
    if (typeof value !== "string") return undefined;
    const label = value.trim();
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return undefined;
    return label;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
    if (!request.body) return null;
    try {
        const bytes = await readBodyCapped(request.body, MAX_BODY_BYTES);
        if (!bytes || bytes.byteLength === 0) return null;
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

export function feedKey(appId: string, logId: string, feedId: string): string {
    return `v1/feeds/${appId}/${logId}/${feedId}.json`;
}

export function feedPrefix(appId: string, logId: string): string {
    return `v1/feeds/${appId}/${logId}/`;
}

function randomToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function scopeError(error: unknown): Response {
    if (error instanceof LedgerScopeError) {
        return feedError(error.status, error.code, error.message);
    }
    return feedError(503, "ledger_verification_failed", "The selected log could not be verified");
}

function parseRequestUrl(request: Request): URL | null {
    try {
        return new URL(request.url);
    } catch {
        return null;
    }
}

function methodNotAllowed(allow: string): Response {
    return feedError(405, "method_not_allowed", "The method is not supported", {
        Allow: allow,
    });
}

function feedJson(
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
): Response {
    return feedResponse(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    });
}

function feedError(
    status: number,
    code: string,
    error: string,
    headers: Record<string, string> = {},
): Response {
    return feedJson({ error, code }, status, headers);
}

function feedResponse(
    body: BodyInit | null,
    init: ResponseInit = {},
): Response {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(securityHeaders())) {
        headers.set(name, value);
    }
    return new Response(body, { ...init, headers });
}

function securityHeaders(): Record<string, string> {
    return {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    };
}
