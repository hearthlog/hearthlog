import {
    authorizeStorRequest,
    LedgerAdminAuthorizationError,
    LedgerAdminConfigurationError,
    type LedgerAdminIdentity,
} from "./access-auth";
import { LedgerScopeError, verifyLogAppId } from "./ledger-scope";
import { readBodyCapped } from "./request-body";
import { decide, DecisionModelError, type DecisionModelBinding } from "./ai/decision-model";
import { AiRequestError, type ServerModule } from "@hearthlog/contracts";
import { buildQuestion, parseItems } from "./ai/decision-questions";
import {
    isAiCapability,
    MAX_DECISION_BODY_BYTES,
    parseEnabledCapabilities,
    type DecisionResponse,
} from "@hearthlog/contracts/ai/capabilities";

/**
 * Same-origin gateway for decision capabilities. The browser sends items; the
 * Worker verifies the Access session and Ledger log, checks that the site
 * enables the capability, builds the question and options itself, calls the
 * decision model through its binding (no credential exists to leak), validates
 * the answers and returns one decision per item. Inputs and outputs are never
 * logged and error messages are fixed strings.
 */

const PREFIX = "/api/ai/v1";
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ROUTE = new RegExp(`^${PREFIX}/logs/(${UUID})/decisions/([a-z-]+)$`);

export type AiDecisionsEnv = Pick<Env,
    "CF_ACCESS_APP_AUD" | "CF_ACCESS_TEAM_DOMAIN" | "LEDGER" | "LEDGER_AUTH_TOKEN" | "STOR_AUTHORIZED_EMAILS"
> & { AI?: DecisionModelBinding; AI_CAPABILITIES?: string };
type Authorizer = (request: Request, env: AiDecisionsEnv) => Promise<LedgerAdminIdentity>;

export async function handleAiDecisionsRequest(
    request: Request,
    env: AiDecisionsEnv,
    modules: ReadonlyArray<ServerModule<Env>>,
    authorize: Authorizer = authorizeStorRequest,
): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(ROUTE);
    if (!match || request.method !== "POST" || !isAiCapability(match[2])) {
        return errorResponse(404, "ai_route_not_found", "AI route not found");
    }
    const capability = match[2];
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) {
        return errorResponse(403, "origin_not_allowed", "Cross-origin AI requests are not allowed");
    }
    try {
        await authorize(request, env);
    } catch (error) {
        return errorResponse(
            error instanceof LedgerAdminConfigurationError ? 503 : 403,
            error instanceof LedgerAdminConfigurationError ? "ai_unconfigured" : "ai_forbidden",
            error instanceof LedgerAdminAuthorizationError ? "Hearthlog access is required" : "AI decisions are unavailable",
        );
    }
    try {
        await verifyLogAppId(match[1], env);
    } catch (error) {
        return error instanceof LedgerScopeError
            ? errorResponse(error.status, error.code, error.message)
            : errorResponse(503, "ledger_verification_failed", "The selected log could not be verified");
    }
    if (!env.AI || !parseEnabledCapabilities(env.AI_CAPABILITIES).has(capability)) {
        return errorResponse(503, "ai_unconfigured", "This AI decision is not enabled for this site");
    }

    if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        return errorResponse(415, "unsupported_content_type", "Send JSON");
    }
    const declaredLength = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DECISION_BODY_BYTES) return tooLarge();
    const bytes = request.body ? await readBodyCapped(request.body, MAX_DECISION_BODY_BYTES) : new Uint8Array();
    if (bytes === null) return tooLarge();

    let questions;
    try {
        const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
        questions = parseItems(modules, capability, body).map((item) => buildQuestion(modules, capability, item));
    } catch (error) {
        return errorResponse(400, "invalid_request", error instanceof AiRequestError ? error.message : "Send valid JSON");
    }

    try {
        const result = await decide(env.AI, questions);
        const response: DecisionResponse = result;
        return secureResponse(JSON.stringify(response), {
            headers: { "Content-Type": "application/json; charset=utf-8" },
        });
    } catch (error) {
        if (error instanceof DecisionModelError) {
            return error.code === "timeout"
                ? errorResponse(504, "ai_timeout", "The AI model timed out")
                : errorResponse(502, "ai_failed", "The AI model could not decide");
        }
        throw error;
    }
}

function tooLarge(): Response {
    return errorResponse(413, "body_too_large", "The request is too large");
}

function errorResponse(status: number, code: string, message: string): Response {
    return secureResponse(JSON.stringify({ code, error: message }), {
        status, headers: { "Content-Type": "application/json; charset=utf-8" },
    });
}

function secureResponse(body: BodyInit | null, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(body, { ...init, headers });
}
