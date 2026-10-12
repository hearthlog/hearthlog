import { env } from "cloudflare:workers";
import { Elysia } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";

import {
    authorizeAdmin,
    bearerToken,
    originAllowed,
    requestOrigin,
    verifyAccess,
} from "./auth";
import { INTERNAL_SOCKET_ACCESS_HEADER, type AccessClaims } from "./contracts";
import {
    errorResponse,
    jsonError,
    LedgerError,
    normalizeError,
    validationError,
} from "./errors";
import { RETRY_AFTER_SECONDS } from "./fence";
import type { LedgerApp } from "./ledger-app";
import type { RpcResult } from "./rpc";
import {
    apiModels,
    appendEventsBody,
    applicationParams,
    createApplicationBody,
    createLogBody,
    eventPolicyBody,
    fenceBody,
    importBeginBody,
    importFinishBody,
    importRecordsBody,
    forkLogBody,
    logVisibilityBody,
    galleryPhotoReferenceParams,
    logLineageBody,
    eventsQuery,
    logParams,
    socketQuery,
    adminEventParams,
    adminEventsQuery,
    adminConnectionsQuery,
} from "./schemas";

const registry = () => env.APP_REGISTRY.getByName("registry-v1");

const app = new Elysia({
    adapter: CloudflareAdapter,
    normalize: false,
})
    .model(apiModels)
    .onRequest(({ request }) => {
        const origin = requestOrigin(request);
        if (!originAllowed(env, origin)) {
            return withCors(
                jsonError("origin_not_allowed", "origin is not allowed", 403),
                origin,
            );
        }
        if (request.method === "OPTIONS") return preflight(origin);
    })
    .onError(({ code, error, request }) => {
        const origin = requestOrigin(request);
        if (error instanceof LedgerError) {
            return withCors(errorResponse(error), origin);
        }
        if (code === "PARSE") {
            return withCors(
                errorResponse(
                    validationError("request body must be valid JSON"),
                ),
                origin,
            );
        }
        if (code === "VALIDATION") {
            return withCors(
                errorResponse(validationError(error.message)),
                origin,
            );
        }
        if (code === "NOT_FOUND") {
            return withCors(
                jsonError("not_found", "resource not found", 404),
                origin,
            );
        }
        console.error(
            JSON.stringify({
                message: "Ledger Worker request failed",
                path: new URL(request.url).pathname,
                error: normalizeError(error).message,
            }),
        );
        return withCors(
            jsonError("internal_error", "internal error", 500),
            origin,
        );
    })
    .get(
        "/health",
        async ({ request }) =>
            rpcResponse(await registry().health(), requestOrigin(request)),
        { response: { 204: "HealthResponse" } },
    )
    .all("/health", ({ request }) => notFound(request))
    .all("/_internal/*", ({ request }) => notFound(request))
    .group("/admin/v1", (admin) =>
        admin
            .resolve(async ({ request }) => {
                await administrator(request);
                return { administrator: true as const };
            })
            .get(
                "/apps",
                async ({ request }) =>
                    rpcResponse(
                        await registry().listApplications(),
                        requestOrigin(request),
                    ),
                { response: { 200: "ApplicationListResponse" } },
            )
            .get(
                "/apps/:appId/logs",
                async ({ params, request }) => {
                    const application = await administratorApplication(
                        params.appId,
                    );
                    return rpcResponse(
                        await env.LEDGER_APP.getByName(
                            application.id,
                        ).administratorListLogs(application.id),
                        requestOrigin(request),
                    );
                },
                {
                    params: applicationParams,
                    response: { 200: "LogListResponse" },
                },
            )
            .post(
                "/apps/:appId/logs/:logId/lineage",
                async ({ params, body, request }) => {
                    const application = await administratorApplication(params.appId);
                    return rpcResponse(
                        await env.LEDGER_APP.getByName(application.id)
                            .administratorSetLogLineage(application.id, params.logId, body),
                        requestOrigin(request),
                    );
                },
                { params: adminEventParams, body: logLineageBody, response: { 200: "LogResponse" } },
            )
            .get("/registry/export/sqlite", async ({ request }) =>
                withCors(
                    await registry().administratorExportSqlite(),
                    requestOrigin(request),
                ),
            )
            .get(
                "/apps/:appId/export/sqlite",
                async ({ params, request }) => {
                    const application = await administratorApplication(
                        params.appId,
                    );
                    return withCors(
                        await env.LEDGER_APP.getByName(
                            application.id,
                        ).administratorExportSqlite(application.id),
                        requestOrigin(request),
                    );
                },
                { params: applicationParams },
            )
            .get(
                "/apps/:appId/connections",
                async ({ params, query, request }) => {
                    const application = await administratorApplication(
                        params.appId,
                    );
                    return rpcResponse(
                        await env.LEDGER_APP.getByName(
                            application.id,
                        ).administratorConnections(
                            application.id,
                            query.afterId ? { afterId: query.afterId } : {},
                        ),
                        requestOrigin(request),
                    );
                },
                {
                    params: applicationParams,
                    query: adminConnectionsQuery,
                    response: { 200: "AdminConnectionsResponse" },
                },
            )
            .get(
                "/apps/:appId/export",
                async ({ params, request }) => {
                    const application = await administratorApplication(
                        params.appId,
                    );
                    return withCors(
                        await env.LEDGER_APP.getByName(
                            application.id,
                        ).administratorExportApplication(application),
                        requestOrigin(request),
                    );
                },
                { params: applicationParams },
            )
            .get(
                "/apps/:appId/metrics",
                async ({ params, request }) => {
                    const application = await administratorApplication(
                        params.appId,
                    );
                    return rpcResponse(
                        await env.LEDGER_APP.getByName(
                            application.id,
                        ).administratorMetrics(application.id),
                        requestOrigin(request),
                    );
                },
                {
                    params: applicationParams,
                    response: { 200: "AdminMetricsResponse" },
                },
            )
            .get(
                "/apps/:appId/logs/:logId/events",
                async ({ params, query, request }) => {
                    const application = await administratorApplication(
                        params.appId,
                    );
                    return rpcResponse(
                        await env.LEDGER_APP.getByName(
                            application.id,
                        ).administratorListEvents(
                            application.id,
                            params.logId,
                            query,
                        ),
                        requestOrigin(request),
                    );
                },
                {
                    params: adminEventParams,
                    query: adminEventsQuery,
                    response: { 200: "AdminEventsResponse" },
                },
            )
            .post(
                "/apps",
                async ({ body, request }) =>
                    rpcResponse(
                        await registry().createApplication(body),
                        requestOrigin(request),
                    ),
                {
                    body: createApplicationBody,
                    response: { 201: "ApplicationTokenResponse" },
                },
            )
            .get(
                "/apps/:appId/transfer",
                async ({ params, request }) => {
                    const application = await administratorApplication(params.appId);
                    return withCors(
                        await env.LEDGER_APP.getByName(application.id).administratorTransferExport(application.id),
                        requestOrigin(request),
                    );
                },
                { params: applicationParams },
            )
            .get(
                "/apps/:appId/checksums",
                async ({ params, request }) => {
                    const application = await administratorApplication(params.appId);
                    return rpcResponse(
                        await env.LEDGER_APP.getByName(application.id).administratorChecksums(application.id),
                        requestOrigin(request),
                    );
                },
                { params: applicationParams },
            )
            .post(
                "/import",
                async ({ body, request }) =>
                    rpcResponse(
                        await registry().beginImport({
                            id: body.id,
                            name: body.name,
                            createdAt: body.createdAt,
                            policy: body.policy ? JSON.stringify(body.policy) : null,
                        }),
                        requestOrigin(request),
                    ),
                { body: importBeginBody },
            )
            .post(
                "/apps/:appId/import",
                async ({ params, body, request }) => {
                    const importing = await registry().importingApplication(params.appId);
                    if (!importing.ok) return rpcResponse(importing, requestOrigin(request));
                    return rpcResponse(
                        await env.LEDGER_APP.getByName(importing.body.id).importRecords(importing.body.id, body.records),
                        requestOrigin(request),
                    );
                },
                { params: applicationParams, body: importRecordsBody },
            )
            .post(
                "/apps/:appId/import/abort",
                async ({ params, request }) =>
                    rpcResponse(await registry().abortImport(params.appId), requestOrigin(request)),
                { params: applicationParams },
            )
            .post(
                "/apps/:appId/import/finish",
                async ({ params, body, request }) =>
                    rpcResponse(await registry().finishImport(params.appId, body), requestOrigin(request)),
                { params: applicationParams, body: importFinishBody },
            )
            .get(
                "/apps/:appId/fence",
                async ({ params, request }) =>
                    rpcResponse(await registry().getApplicationFence(params.appId), requestOrigin(request)),
                { params: applicationParams },
            )
            .put(
                "/apps/:appId/fence",
                async ({ params, body, request }) =>
                    rpcResponse(await registry().setApplicationFence(params.appId, body), requestOrigin(request)),
                { params: applicationParams, body: fenceBody },
            )
            .get(
                "/apps/:appId/policy",
                async ({ params, request }) =>
                    rpcResponse(
                        await registry().getApplicationPolicy(params.appId),
                        requestOrigin(request),
                    ),
                { params: applicationParams },
            )
            .put(
                "/apps/:appId/policy",
                async ({ params, body, request }) =>
                    rpcResponse(
                        await registry().setApplicationPolicy(params.appId, body),
                        requestOrigin(request),
                    ),
                { params: applicationParams, body: eventPolicyBody },
            )
            .post(
                "/apps/:appId/rotate-token",
                async ({ params, request }) =>
                    rpcResponse(
                        await registry().rotateApplicationToken(params.appId),
                        requestOrigin(request),
                    ),
                {
                    params: applicationParams,
                    response: { 200: "ApplicationTokenResponse" },
                },
            )
            .post(
                "/apps/:appId/revoke",
                async ({ params, request }) =>
                    rpcResponse(
                        await registry().revokeApplication(params.appId),
                        requestOrigin(request),
                    ),
                {
                    params: applicationParams,
                    response: { 200: "ApplicationResponse" },
                },
            )
            .all("/*", ({ request }) => notFound(request))
            .all("", ({ request }) => notFound(request)),
    )
    .group("", (authenticated) =>
        authenticated
            .resolve(async ({ request }) => ({
                access: await accessClaims(request),
            }))
            .get(
                "/logs/:logId/events/socket",
                async ({ access, params, query, request }) => {
                    const origin = requestOrigin(request);
                    const response = await ledger(access).fetch(
                        socketUpgradeRequest(
                            request,
                            access,
                            params.logId,
                            query.afterVersion ?? 0,
                            query.replayVersion ?? 0,
                        ),
                    );
                    return response.status === 101
                        ? response
                        : withCors(response, origin);
                },
                { params: logParams, query: socketQuery },
            )
            .get(
                "/session",
                async ({ access, request }) =>
                    rpcResponse(
                        await ledger(access).getSession(access),
                        requestOrigin(request),
                    ),
                { response: { 200: "SessionResponse" } },
            )
            .get(
                "/logs",
                async ({ access, request }) =>
                    rpcResponse(
                        await ledger(access).listLogs(access),
                        requestOrigin(request),
                    ),
                { response: { 200: "LogListResponse" } },
            )
            .post(
                "/logs",
                async ({ access, body, request }) =>
                    rpcResponse(
                        await ledger(access).createLog(access, body),
                        requestOrigin(request),
                    ),
                {
                    body: createLogBody,
                    response: { 201: "CreateLogResponse" },
                },
            )
            .get(
                "/logs/:logId",
                async ({ access, params, request }) =>
                    rpcResponse(
                        await ledger(access).getLog(access, params.logId),
                        requestOrigin(request),
                    ),
                {
                    params: logParams,
                    response: { 200: "LogResponse" },
                },
            )
            .get(
                "/logs/:logId/gallery-photos/:photoId/files/:fileVersionId/reference",
                async ({ access, params, request }) =>
                    rpcResponse(
                        await ledger(access).getGalleryPhotoReference(
                            access, params.logId, params.photoId, params.fileVersionId,
                        ),
                        requestOrigin(request),
                    ),
                {
                    params: galleryPhotoReferenceParams,
                    response: { 200: 'GalleryPhotoReferenceResponse' },
                },
            )
            .post(
                "/logs/:logId/forks",
                async ({ access, params, body, request }) =>
                    rpcResponse(
                        await ledger(access).forkLog(access, params.logId, body),
                        requestOrigin(request),
                    ),
                { params: logParams, body: forkLogBody, response: { 201: "ForkLogResponse" } },
            )
            .post(
                "/logs/:logId/visibility",
                async ({ access, params, body, request }) =>
                    rpcResponse(
                        await ledger(access).setLogVisibility(access, params.logId, body),
                        requestOrigin(request),
                    ),
                { params: logParams, body: logVisibilityBody, response: { 200: "LogResponse" } },
            )
            .post(
                "/logs/:logId/finalize-fork",
                async ({ access, params, request }) =>
                    rpcResponse(
                        await ledger(access).finalizeFork(access, params.logId),
                        requestOrigin(request),
                    ),
                { params: logParams, response: { 200: "ForkLogResponse" } },
            )
            .delete(
                "/logs/:logId",
                async ({ access, params, request }) =>
                    rpcResponse(
                        await ledger(access).deleteLog(access, params.logId),
                        requestOrigin(request),
                    ),
                {
                    params: logParams,
                    response: { 204: "EmptyResponse" },
                },
            )
            .get(
                "/logs/:logId/events",
                async ({ access, params, query, request }) =>
                    rpcResponse(
                        await ledger(access).listEvents(
                            access,
                            params.logId,
                            query.afterVersion,
                            query.limit,
                            Number(request.headers.get("X-Ledger-Replay-Version") ?? 0),
                        ),
                        requestOrigin(request),
                    ),
                {
                    params: logParams,
                    query: eventsQuery,
                    response: { 200: "EventBatchResponse" },
                },
            )
            .post(
                "/logs/:logId/events",
                async ({ access, body, params, request }) =>
                    rpcResponse(
                        await ledger(access).appendEvents(
                            access,
                            params.logId,
                            body,
                            Number(request.headers.get("X-Ledger-Replay-Version") ?? 0),
                            request.headers.get("X-Ledger-Actor"),
                        ),
                        requestOrigin(request),
                    ),
                {
                    body: appendEventsBody,
                    params: logParams,
                    response: { 200: "AppendEventsResponse" },
                },
            ),
    )
    .all("/*", async ({ request }) => authenticatedNotFound(request))
    .all("/", async ({ request }) => authenticatedNotFound(request))
    .compile();

export default app;

function ledger(access: AccessClaims): DurableObjectStub<LedgerApp> {
    return env.LEDGER_APP.getByName(access.appId);
}

async function administratorApplication(appId: string) {
    const result = await registry().getApplication(appId);
    if (!result.ok) throw new LedgerError(result.status, result.body);
    return result.body;
}

async function accessClaims(request: Request): Promise<AccessClaims> {
    try {
        return await verifyAccess(env, bearerToken(request));
    } catch {
        throw new LedgerError(401, {
            error: "invalid bearer token",
            code: "unauthorized",
        });
    }
}

async function administrator(request: Request): Promise<void> {
    try {
        await authorizeAdmin(request, env);
    } catch {
        throw new LedgerError(401, {
            error: "invalid administrator token",
            code: "unauthorized",
        });
    }
}

async function authenticatedNotFound(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/_internal/")) return notFound(request);
    if (path.startsWith("/admin/v1/")) {
        await administrator(request);
    } else {
        await accessClaims(request);
    }
    return notFound(request);
}

function socketUpgradeRequest(
    request: Request,
    access: AccessClaims,
    logId: string,
    afterVersion: number,
    replayVersion: number,
): Request {
    const url = new URL(request.url);
    url.pathname = `/logs/${logId}/events/socket`;
    url.search = "";
    url.searchParams.set("afterVersion", String(afterVersion));
    url.searchParams.set("replayVersion", String(replayVersion));

    const forwarded = new Request(url, request);
    forwarded.headers.delete("authorization");
    forwarded.headers.set(
        INTERNAL_SOCKET_ACCESS_HEADER,
        JSON.stringify(access),
    );
    return forwarded;
}

function notFound(request: Request): Response {
    return withCors(
        jsonError("not_found", "resource not found", 404),
        requestOrigin(request),
    );
}

function rpcResponse<T>(result: RpcResult<T>, origin: string | null): Response {
    const response =
        result.body === null
            ? new Response(null, { status: result.status })
            : Response.json(result.body, { status: result.status });
    // A paused workspace tells clients when to try again; the outbox retries 503 without parking.
    if (result.status === 503 && !result.ok && result.body.code === "tenant_migrating") {
        response.headers.set("Retry-After", String(RETRY_AFTER_SECONDS));
    }
    return withCors(response, origin);
}

function preflight(origin: string | null): Response {
    const headers = corsHeaders(origin);
    headers.set("Access-Control-Max-Age", "86400");
    return new Response(null, { status: 204, headers });
}

function withCors(response: Response, origin: string | null): Response {
    const headers = new Headers(response.headers);
    for (const [name, value] of corsHeaders(origin)) headers.set(name, value);
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function corsHeaders(origin: string | null): Headers {
    const headers = new Headers({
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Ledger-Replay-Version",
        "Cache-Control": "no-store",
    });
    if (origin !== null) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Vary", "Origin");
    }
    return headers;
}
