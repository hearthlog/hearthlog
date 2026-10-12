import { proxyLedgerAdminRequest } from "./ledger-admin";
export { proxyLedgerAdminRequest } from "./ledger-admin";

import {
    authorizeAccessRequest,
    authorizeStorRequest,
    LedgerAdminConfigurationError,
    type LedgerAdminIdentity,
    type StorAuthEnv,
} from "./access-auth";
import type { ServerModule } from '@hearthlog/contracts';
import { handleAiDecisionsRequest } from "./ai-decisions";
import { fencedWrite, readFence } from './fence';
import { handleForkPreparation } from './log-forks';
import { handleIntegrationRequest, isIntegrationRequest } from './integrations';
import { handleCalendarFeedManagementRequest } from './calendar-feeds';

const LEDGER_PREFIX = "/api/ledger";
const LEDGER_ADMIN_NAMESPACE = `${LEDGER_PREFIX}/admin`;
const AI_PREFIX = "/api/ai/v1";
const USER_SESSION_PATH = "/api/session";
const CALENDAR_FEEDS_PREFIX = "/api/calendar-feeds/v1";
const LOG_FORK_PREFIX = '/api/log-forks/v1';
const APP_SHELL_PATH = "/index.html";
const IMMUTABLE_ASSET_PREFIX = "/_app/immutable/";

type LedgerGatewayEnv = StorAuthEnv & {
    LEDGER: { fetch(request: Request): Promise<Response> };
    LEDGER_AUTH_TOKEN: Env["LEDGER_AUTH_TOKEN"];
};
type StorAuthorizer = (
    request: Request,
    env: StorAuthEnv,
) => Promise<LedgerAdminIdentity>;
type AccessSessionEnv = Pick<
    Env,
    "CF_ACCESS_APP_AUD" | "CF_ACCESS_TEAM_DOMAIN"
>;
type AssetEnv = Pick<Env, "ASSETS">;
type AccessSessionAuthorizer = (
    request: Request,
    env: AccessSessionEnv,
) => Promise<LedgerAdminIdentity>;

/**
 * Parses the request URL. Fetch guarantees an absolute URL, but a malformed
 * value must not throw inside the router: `null` lets each caller fail closed.
 */
function parseRequestUrl(request: Request): URL | null {
    try {
        return new URL(request.url);
    } catch {
        return null;
    }
}

function invalidRequestUrl(): Response {
    return Response.json(
        { error: "The request URL is invalid", code: "invalid_request_url" },
        { status: 400 },
    );
}

/**
 * The gateway Worker's handler for a site: its routes, the Ledger and admin proxies, and the static
 * assets, plus the routes and daily jobs of the server modules the site enables. The host's entry
 * passes the site's table in; nothing here names a module.
 */
export function createGateway(modules: ReadonlyArray<ServerModule<Env>>) {
    return {
        async fetch(request: Request, env: Env): Promise<Response> {
            const url = parseRequestUrl(request);
            if (!url) return invalidRequestUrl();
            // While the application is being moved, the gateway's own writes (files, publications, feeds,
            // integrations, fork preparation) pause with the Ledger's. The Ledger proxy answers for itself.
            if (url.pathname.startsWith("/api/") && !url.pathname.startsWith(`${LEDGER_PREFIX}/`) && url.pathname !== LEDGER_PREFIX) {
                const fenced = await fencedWrite(request, env);
                if (fenced) return fenced;
            }
            if (url.pathname.startsWith(`${LOG_FORK_PREFIX}/`)) {
                return handleForkPreparation(request, env,
                    modules.flatMap((module) => module.forkFiles ? [module.forkFiles] : []));
            }
            // Routes the site's modules declare; a module the site does not enable is not bundled.
            for (const module of modules) {
                for (const route of module.routes) {
                    if (url.pathname === route.prefix || url.pathname.startsWith(`${route.prefix}/`)) {
                        return route.handle(request, env);
                    }
                }
            }
            if (url.pathname === AI_PREFIX || url.pathname.startsWith(`${AI_PREFIX}/`)) {
                return handleAiDecisionsRequest(request, env, modules);
            }
            if (
                url.pathname === CALENDAR_FEEDS_PREFIX ||
                url.pathname.startsWith(`${CALENDAR_FEEDS_PREFIX}/`)
            ) {
                return handleCalendarFeedManagementRequest(request, env);
            }
            if (isIntegrationRequest(url.pathname)) {
                return handleIntegrationRequest(request, env, modules);
            }
            if (url.pathname === USER_SESSION_PATH) {
                return proxyAccessSession(request, env);
            }
            if (
                url.pathname === LEDGER_ADMIN_NAMESPACE ||
                url.pathname.startsWith(`${LEDGER_ADMIN_NAMESPACE}/`)
            ) {
                return proxyLedgerAdminRequest(request, env);
            }
            if (
                url.pathname === LEDGER_PREFIX ||
                url.pathname.startsWith(`${LEDGER_PREFIX}/`)
            ) {
                return proxyLedgerRequest(request, env);
            }
            return serveAssetOrAppShell(request, env);
        },
        /** Daily jobs of the site's modules (Gallery sweeps its public copies); see the `triggers` in `wrangler.jsonc`. */
        async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
            // A fenced workspace is being copied or has moved: jobs that write must not run against it.
            if (await readFence(env)) return;
            for (const module of modules) await module.scheduled?.(env);
        },
    } satisfies ExportedHandler<Env>;
}

export async function proxyAccessSession(
    request: Request,
    env: AccessSessionEnv,
    authorize: AccessSessionAuthorizer = authorizeAccessRequest,
): Promise<Response> {
    if (request.method !== "GET") {
        return noStore(
            Response.json(
                {
                    error: "Only GET is supported for the user session",
                    code: "method_not_allowed",
                },
                { status: 405, headers: { Allow: "GET" } },
            ),
        );
    }

    const publicUrl = parseRequestUrl(request);
    if (!publicUrl) return noStore(invalidRequestUrl());
    const browserOrigin = request.headers.get("Origin");
    if (browserOrigin !== null && browserOrigin !== publicUrl.origin) {
        return noStore(
            Response.json(
                {
                    error: "Cross-origin user session requests are not allowed",
                    code: "origin_not_allowed",
                },
                { status: 403 },
            ),
        );
    }

    try {
        return noStore(Response.json(await authorize(request, env)));
    } catch (error) {
        if (error instanceof LedgerAdminConfigurationError) {
            return noStore(
                Response.json(
                    {
                        error: "User session is not configured",
                        code: "access_session_unconfigured",
                    },
                    { status: 503 },
                ),
            );
        }
        return noStore(
            Response.json(
                {
                    error: "A valid Cloudflare Access session is required",
                    code: "access_session_forbidden",
                },
                { status: 403 },
            ),
        );
    }
}

export async function serveAssetOrAppShell(
    request: Request,
    env: AssetEnv,
): Promise<Response> {
    const response = await env.ASSETS.fetch(request);
    const pathname = parseRequestUrl(request)?.pathname ?? "";
    if (
        response.status !== 404 ||
        !isNavigationRequest(request) ||
        pathname.startsWith(IMMUTABLE_ASSET_PREFIX) ||
        looksLikeAssetPath(pathname)
    ) {
        return response;
    }

    const shellUrl = new URL(APP_SHELL_PATH, request.url);
    return env.ASSETS.fetch(
        new Request(shellUrl, {
            method: "GET",
            headers: request.headers,
        }),
    );
}

function isNavigationRequest(request: Request): boolean {
    if (request.method !== "GET") return false;
    return (
        request.headers
            .get("Accept")
            ?.split(",")
            .some((value) => value.trim().startsWith("text/html")) ?? false
    );
}

function looksLikeAssetPath(pathname: string): boolean {
    return /\/[^/]+\.[^/]+$/.test(pathname);
}

export async function proxyLedgerRequest(
    request: Request,
    env: LedgerGatewayEnv,
    authorize: StorAuthorizer = authorizeStorRequest,
): Promise<Response> {
    if (!env.LEDGER_AUTH_TOKEN) {
        return Response.json(
            {
                error: "Ledger gateway is not configured",
                code: "ledger_gateway_unconfigured",
            },
            { status: 503 },
        );
    }

    const publicUrl = parseRequestUrl(request);
    if (!publicUrl) return invalidRequestUrl();
    if (/^\/api\/ledger\/logs\/[^/]+\/finalize-fork$/.test(publicUrl.pathname)) {
        return Response.json({ error: 'Fork preparation is server managed', code: 'forbidden' }, { status: 403 });
    }
    const browserOrigin = request.headers.get("Origin");
    if (browserOrigin !== null && browserOrigin !== publicUrl.origin) {
        return Response.json(
            {
                error: "Cross-origin Ledger gateway requests are not allowed",
                code: "origin_not_allowed",
            },
            { status: 403 },
        );
    }
    // The edge Access application is not the only gate: the server token is
    // attached only for a verified, allowlisted Access identity.
    let identity: LedgerAdminIdentity;
    try {
        identity = await authorize(request, env);
    } catch (error) {
        if (error instanceof LedgerAdminConfigurationError) {
            return Response.json(
                {
                    error: "Ledger gateway is not configured",
                    code: "ledger_gateway_unconfigured",
                },
                { status: 503 },
            );
        }
        return Response.json(
            {
                error: "Hearthlog access is required",
                code: "ledger_gateway_forbidden",
            },
            { status: 403 },
        );
    }
    // Once the browser origin is validated the same URL becomes the internal
    // upstream target; this avoids parsing the request URL twice.
    publicUrl.protocol = "https:";
    publicUrl.host = "ledger.internal";
    publicUrl.pathname =
        publicUrl.pathname === LEDGER_PREFIX
            ? "/"
            : publicUrl.pathname.slice(LEDGER_PREFIX.length);

    const upstreamRequest = new Request(publicUrl, request);
    upstreamRequest.headers.set(
        "Authorization",
        `Bearer ${env.LEDGER_AUTH_TOKEN}`,
    );
    // The public gateway already enforces same-origin access. Ledger therefore
    // treats the service binding as the browser's authenticated socket entry.
    upstreamRequest.headers.delete("Origin");
    // Ledger authenticates the server token only; browser credentials stay here.
    upstreamRequest.headers.delete("Cookie");
    upstreamRequest.headers.delete("Cf-Access-Jwt-Assertion");
    // The author of appended events is the verified identity, never a value the
    // browser supplied: any incoming copy is replaced.
    upstreamRequest.headers.set("X-Ledger-Actor", identity.email);
    const response = await env.LEDGER.fetch(upstreamRequest);
    // Response reconstruction would discard a WebSocket upgrade. Those are
    // never cacheable, so only ordinary HTTP Ledger responses need no-store.
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        return response;
    }
    return noStore(response);
}

function noStore(response: Response): Response {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
    });
}
