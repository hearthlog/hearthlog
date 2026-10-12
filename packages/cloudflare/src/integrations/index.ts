/**
 * Service ingest: narrow, typed writes from non-browser sources.
 *
 * Every request carries a Cloudflare Access service token and reaches this
 * Worker through its own path-scoped Access application, so Access itself
 * keeps the token away from every other route. The Worker verifies the token
 * again, maps its client id to one configured integration, and builds the
 * events itself: a caller sends a value, never an event. The only credential it
 * ever uses against Ledger is the app token it already holds; the author of the
 * events is recorded as `service:<integration id>`.
 */

import {
    authorizeServiceRequest,
    LedgerAdminConfigurationError,
    type ServiceAuthEnv,
    type ServiceIdentity,
} from "../access-auth";
import { readBodyCapped } from "../request-body";
import { upsertEntity, type AppendEnv } from "./append";
import { parseActiveIntegrations, type ActiveIntegration } from "@hearthlog/contracts/integrations/kinds";
import { IntegrationRequestError } from "@hearthlog/contracts/integrations/service";
import type { IntegrationHandler, ServerModule } from "@hearthlog/contracts";

const PREFIX = "/api/integrations/v1";
const ROUTE = /^\/api\/integrations\/v1\/([a-z0-9][a-z0-9-]{0,39})\/([a-z]+)\/([^/]+)$/;
const MAX_BODY_BYTES = 1024;

export type IntegrationsEnv = ServiceAuthEnv & AppendEnv & Pick<Env, "INTEGRATIONS"> & {
    /** Optional Workers rate-limit binding; absent in tests and local runs. */
    INTEGRATIONS_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
};
type ServiceAuthorizer = (request: Request, env: IntegrationsEnv) => Promise<ServiceIdentity>;

export function isIntegrationRequest(pathname: string): boolean {
    return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

export async function handleIntegrationRequest(
    request: Request,
    env: IntegrationsEnv,
    modules: ReadonlyArray<ServerModule<Env>>,
    authorize: ServiceAuthorizer = authorizeServiceRequest,
    now: () => number = Date.now,
): Promise<Response> {
    let url: URL;
    try {
        url = new URL(request.url);
    } catch {
        return errorResponse(400, "invalid_request_url", "The request URL is invalid");
    }
    // A browser has no business here; the check also refuses cross-site posts.
    if (request.headers.get("Origin") !== null) {
        return errorResponse(403, "origin_not_allowed", "Browsers cannot call this endpoint");
    }

    let identity: ServiceIdentity;
    try {
        identity = await authorize(request, env);
    } catch (error) {
        if (error instanceof LedgerAdminConfigurationError) {
            return errorResponse(503, "integrations_unconfigured", "Integrations are not configured");
        }
        return errorResponse(403, "integrations_forbidden", "A service token is required");
    }

    const integrations = parseActiveIntegrations(env.INTEGRATIONS);
    const integration = integrations.find((candidate) => candidate.clientId === identity.clientId);
    if (!env.LEDGER_AUTH_TOKEN) {
        return errorResponse(503, "integrations_unconfigured", "Integrations are not configured");
    }
    const match = ROUTE.exec(url.pathname);
    // The token names one integration; it may only address that one.
    if (!integration || !match || match[1] !== integration.id || match[2] !== integration.kind) {
        return errorResponse(404, "integration_not_found", "Integration not found");
    }
    if (request.method !== "PUT") {
        return errorResponse(405, "method_not_allowed", "Use PUT", { Allow: "PUT" });
    }

    if (env.INTEGRATIONS_LIMITER) {
        const { success } = await env.INTEGRATIONS_LIMITER.limit({ key: identity.clientId });
        if (!success) return errorResponse(429, "rate_limited", "Too many requests", { "Retry-After": "60" });
    }

    try {
        const body = await readJsonBody(request);
        return await runKind(modules, env, integration, match[3]!, body, now());
    } catch (error) {
        if (error instanceof IntegrationRequestError) {
            return errorResponse(error.status, error.code, error.message);
        }
        throw error;
    }
}

/** The handler a module the site enables contributes for a kind; none means the kind is not installed. */
function handlerFor(modules: ReadonlyArray<ServerModule<Env>>, kind: string): IntegrationHandler<Env> | undefined {
    for (const module of modules) {
        const handler = module.integrations?.[kind];
        if (handler) return handler;
    }
    return undefined;
}

async function runKind(
    modules: ReadonlyArray<ServerModule<Env>>,
    env: IntegrationsEnv,
    integration: ActiveIntegration,
    segment: string,
    body: unknown,
    now: number,
): Promise<Response> {
    const handler = handlerFor(modules, integration.kind);
    if (!handler) throw new IntegrationRequestError(404, "integration_not_found", "Integration not found");
    const result = await handler({
        env: env as unknown as Env,
        integration: { id: integration.id, logId: integration.logId },
        segment,
        body,
        now,
        upsertEntity: (build) => upsertEntity(env, { logId: integration.logId, actor: `service:${integration.id}`, build }),
    });
    return jsonResponse(result);
}

async function readJsonBody(request: Request): Promise<unknown> {
    if (request.headers.get("Content-Type")?.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") {
        throw new IntegrationRequestError(415, "unsupported_content_type", "Send JSON");
    }
    const declared = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
    const bytes = request.body ? await readBodyCapped(request.body, MAX_BODY_BYTES) : new Uint8Array();
    if (bytes === null) throw tooLarge();
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new IntegrationRequestError(400, "invalid_request", "Send valid JSON");
    }
}

function tooLarge(): IntegrationRequestError {
    return new IntegrationRequestError(413, "body_too_large", "The request is too large");
}

function jsonResponse(value: unknown): Response {
    return secureResponse(JSON.stringify(value), 200);
}

function errorResponse(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
    return secureResponse(JSON.stringify({ code, error: message }), status, headers);
}

function secureResponse(body: string, status: number, extra: Record<string, string> = {}): Response {
    return new Response(body, {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            ...extra,
        },
    });
}
