import {
    authorizeLedgerAdminRequest,
    LedgerAdminAuthorizationError,
    LedgerAdminConfigurationError,
    type LedgerAdminIdentity,
} from "./access-auth";

const LEDGER_PREFIX = "/api/ledger";
const LEDGER_ADMIN_PREFIX = `${LEDGER_PREFIX}/admin/v1`;

type LedgerAdminGatewayEnv = {
    CF_ACCESS_ADMIN_AUD: Env["CF_ACCESS_ADMIN_AUD"];
    CF_ACCESS_TEAM_DOMAIN: Env["CF_ACCESS_TEAM_DOMAIN"];
    LEDGER: { fetch(request: Request): Promise<Response> };
    LEDGER_ADMIN_EMAIL: Env["LEDGER_ADMIN_EMAIL"];
    LEDGER_ADMIN_TOKEN: Env["LEDGER_ADMIN_TOKEN"];
    STOR_ADMIN_ENABLED: Env["STOR_ADMIN_ENABLED"];
};
type LedgerAdminAuthorizer = (
    request: Request,
    env: LedgerAdminGatewayEnv,
) => Promise<LedgerAdminIdentity>;

interface LedgerAdminRoute {
    kind: "proxy" | "session";
}

export async function proxyLedgerAdminRequest(
    request: Request,
    env: LedgerAdminGatewayEnv,
    authorize: LedgerAdminAuthorizer = authorizeLedgerAdminRequest,
): Promise<Response> {
    const publicUrl = new URL(request.url);
    const route = ledgerAdminRoute(request.method, publicUrl.pathname);
    if (!route) {
        return ledgerAdminError(
            404,
            "ledger_admin_route_not_found",
            "Ledger administrator route not found",
        );
    }
    if (env.STOR_ADMIN_ENABLED !== "true") {
        return ledgerAdminError(
            404,
            "ledger_admin_route_not_found",
            "Ledger administrator route not found",
        );
    }
    if (!env.LEDGER_ADMIN_TOKEN) {
        return ledgerAdminError(
            503,
            "ledger_admin_gateway_unconfigured",
            "Ledger administrator gateway is not configured",
        );
    }

    const browserOrigin = request.headers.get("Origin");
    if (browserOrigin !== null && browserOrigin !== publicUrl.origin) {
        return ledgerAdminError(
            403,
            "origin_not_allowed",
            "Cross-origin Ledger administrator requests are not allowed",
        );
    }

    let identity: LedgerAdminIdentity;
    try {
        identity = await authorize(request, env);
    } catch (error) {
        if (error instanceof LedgerAdminConfigurationError) {
            return ledgerAdminError(
                503,
                "ledger_admin_gateway_unconfigured",
                "Ledger administrator gateway is not configured",
            );
        }
        if (error instanceof LedgerAdminAuthorizationError) {
            return ledgerAdminError(
                403,
                "ledger_admin_forbidden",
                "Ledger administrator access is required",
            );
        }
        return ledgerAdminError(
            403,
            "ledger_admin_forbidden",
            "Ledger administrator access is required",
        );
    }

    if (route.kind === "session") {
        return noStore(Response.json({ email: identity.email }));
    }

    const upstreamUrl = new URL(request.url);
    upstreamUrl.protocol = "https:";
    upstreamUrl.host = "ledger.internal";
    upstreamUrl.pathname = publicUrl.pathname.slice(LEDGER_PREFIX.length);

    const upstreamRequest = new Request(upstreamUrl, request);
    upstreamRequest.headers.set(
        "Authorization",
        `Bearer ${env.LEDGER_ADMIN_TOKEN}`,
    );
    upstreamRequest.headers.delete("Cookie");
    upstreamRequest.headers.delete("Cf-Access-Jwt-Assertion");
    upstreamRequest.headers.delete("Cf-Access-Authenticated-User-Email");
    upstreamRequest.headers.delete("Cf-Access-Client-Id");
    upstreamRequest.headers.delete("Cf-Access-Client-Secret");
    upstreamRequest.headers.delete("Proxy-Authorization");
    upstreamRequest.headers.delete("Origin");

    const response = await env.LEDGER.fetch(upstreamRequest);
    if (response.status === 401) {
        return ledgerAdminError(
            502,
            "ledger_admin_credential_rejected",
            "Ledger rejected the server administrator credential",
        );
    }
    return noStore(response);
}

function ledgerAdminRoute(
    method: string,
    pathname: string,
): LedgerAdminRoute | null {
    if (method === "GET" && pathname === `${LEDGER_ADMIN_PREFIX}/session`) {
        return { kind: "session" };
    }
    if (
        (method === "GET" || method === "POST") &&
        pathname === `${LEDGER_ADMIN_PREFIX}/apps`
    ) {
        return { kind: "proxy" };
    }
    if (
        method === "POST" &&
        new RegExp(
            `^${LEDGER_ADMIN_PREFIX}/apps/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/(?:rotate-token|revoke)$`,
        ).test(pathname)
    ) {
        return { kind: "proxy" };
    }
    if (
        method === "GET" &&
        new RegExp(
            `^${LEDGER_ADMIN_PREFIX}/apps/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/(?:logs|export|export/sqlite|metrics|connections)$`,
        ).test(pathname)
    ) {
        return { kind: "proxy" };
    }
    if (
        method === "GET" &&
        pathname === `${LEDGER_ADMIN_PREFIX}/registry/export/sqlite`
    )
        return { kind: "proxy" };
    const uuid =
        "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
    if (
        method === "GET" &&
        new RegExp(
            `^${LEDGER_ADMIN_PREFIX}/apps/${uuid}/logs/${uuid}/events$`,
        ).test(pathname)
    ) {
        return { kind: "proxy" };
    }
    return null;
}

function ledgerAdminError(
    status: number,
    code: string,
    error: string,
): Response {
    return noStore(Response.json({ error, code }, { status }));
}

function noStore(response: Response): Response {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
    });
}
