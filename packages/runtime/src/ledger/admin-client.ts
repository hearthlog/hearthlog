import type { StoredEvent } from "./types.js";
import type { AdminConnectionsResponse } from "@hearthlog/contracts/ledger/admin";
export type {
    AdminConnection,
    AdminConnectionsResponse,
    AdminRecentConnection,
} from "@hearthlog/contracts/ledger/admin";
import {
    clearAccessReauthenticationAttempts,
    isAccessSessionExpiredResponse,
    requestAccessReauthentication,
    withCloudflareAccessAjaxHeader,
} from "../access/session.js";

const DEFAULT_ADMIN_BASE_URL = "/api/ledger/admin/v1";

export interface AdminSession {
    email: string;
}

export interface AdminAppSummary {
    id: string;
    name: string;
    createdAt: string;
    revokedAt: string | null;
    activeTokenCreatedAt: string | null;
}

export interface AdminAppListResponse {
    apps: AdminAppSummary[];
}

export interface AdminAppTokenResponse {
    app: AdminAppSummary;
    token: string;
}

export interface AdminLogSummary {
    id: string;
    name: string;
    headVersion: number;
    createdAt: string;
    lastUpdatedAt: string | null;
}

export interface AdminLogListResponse {
    logs: AdminLogSummary[];
}

export interface AdminMetrics {
    sampledAt: string;
    logCount: number;
    eventCount: number;
    entityCount: number;
    databaseBytes: number;
    connectedClients: number;
    lastUpdatedAt: string | null;
}

export interface AdminEventPage {
    events: StoredEvent[];
    headVersion: number;
    nextBeforeVersion: number | null;
}

export interface AdminExportedLog extends AdminLogSummary {
    events: StoredEvent[];
}

export interface AdminApplicationExport {
    format: "ledger-application-export";
    version: 1;
    exportedAt: string;
    application: AdminAppSummary;
    logs: AdminExportedLog[];
}

export interface AdminErrorResponse {
    error: string;
    code: string;
    message?: string | null;
}

export class LedgerAdminError extends Error {
    constructor(
        message: string,
        public readonly status: number | null,
        public readonly code: string,
        public readonly outcomeUnknown = false,
    ) {
        super(message);
        this.name = "LedgerAdminError";
    }
}

export class LedgerAdminUnauthorizedError extends LedgerAdminError {
    constructor() {
        super(
            "You do not have Ledger administrator access.",
            403,
            "ledger_admin_forbidden",
        );
        this.name = "LedgerAdminUnauthorizedError";
    }
}

export class LedgerAdminClient {
    private readonly baseUrl: string;

    constructor(
        baseUrl = DEFAULT_ADMIN_BASE_URL,
        private readonly fetchRequest: typeof fetch = (...args) =>
            globalThis.fetch(...args),
    ) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
    }

    getSession(): Promise<AdminSession> {
        return this.request("GET", "/session", undefined, parseAdminSession);
    }

    async listApps(): Promise<AdminAppSummary[]> {
        const response = await this.request(
            "GET",
            "/apps",
            undefined,
            parseAppList,
        );
        return response.apps;
    }

    async listAppLogs(appId: string): Promise<AdminLogSummary[]> {
        const response = await this.request(
            "GET",
            `/apps/${encodeURIComponent(appId)}/logs`,
            undefined,
            parseLogList,
        );
        return response.logs;
    }

    getAppExport(appId: string): Promise<AdminApplicationExport> {
        return this.request(
            "GET",
            `/apps/${encodeURIComponent(appId)}/export`,
            undefined,
            parseApplicationExport,
        );
    }

    getAppMetrics(appId: string): Promise<AdminMetrics> {
        return this.request(
            "GET",
            `/apps/${encodeURIComponent(appId)}/metrics`,
            undefined,
            parseMetrics,
        );
    }

    listConnections(
        appId: string,
        afterId?: string,
    ): Promise<AdminConnectionsResponse> {
        const query = afterId ? `?${new URLSearchParams({ afterId })}` : "";
        return this.request(
            "GET",
            `/apps/${encodeURIComponent(appId)}/connections${query}`,
            undefined,
            parseConnections,
        );
    }

    async getSqliteExport(
        appId: string | null,
        signal?: AbortSignal,
    ): Promise<Response> {
        const path =
            appId === null
                ? "/registry/export/sqlite"
                : `/apps/${encodeURIComponent(appId)}/export/sqlite`;
        const response = await this.fetchResponse(
            "GET",
            path,
            undefined,
            signal,
        );
        if (
            !response.ok ||
            !response.body ||
            !response.headers.get("Content-Type")?.startsWith("application/sql")
        ) {
            throw new LedgerAdminError(
                `Database export could not be started (${response.status}).`,
                response.status,
                "ledger_export_failed",
            );
        }
        return response;
    }

    listLogEvents(
        appId: string,
        logId: string,
        options: { beforeVersion?: number; search?: string } = {},
    ): Promise<AdminEventPage> {
        const query = new URLSearchParams({ limit: "50" });
        if (options.beforeVersion !== undefined)
            query.set("beforeVersion", String(options.beforeVersion));
        if (options.search) query.set("search", options.search);
        return this.request(
            "GET",
            `/apps/${encodeURIComponent(appId)}/logs/${encodeURIComponent(logId)}/events?${query}`,
            undefined,
            parseEventPage,
        );
    }

    createApp(name: string): Promise<AdminAppTokenResponse> {
        return this.request("POST", "/apps", { name }, parseAppTokenResponse);
    }

    rotateAppToken(appId: string): Promise<AdminAppTokenResponse> {
        return this.request(
            "POST",
            `/apps/${encodeURIComponent(appId)}/rotate-token`,
            undefined,
            parseAppTokenResponse,
        );
    }

    revokeApp(appId: string): Promise<AdminAppSummary> {
        return this.request(
            "POST",
            `/apps/${encodeURIComponent(appId)}/revoke`,
            undefined,
            parseAppSummary,
        );
    }

    private async request<T>(
        method: "GET" | "POST",
        path: string,
        body: unknown,
        parse: (value: unknown) => T,
    ): Promise<T> {
        const mutation = method !== "GET";
        const response = await this.fetchResponse(method, path, body);
        const contentType = response.headers.get("Content-Type") ?? "";
        const isJson = contentType.toLowerCase().includes("application/json");
        let payload: unknown = null;
        if (isJson) {
            try {
                payload = await response.json();
            } catch {
                payload = null;
            }
        }
        if (!response.ok) {
            const error = parseAdminError(payload);
            throw new LedgerAdminError(
                error?.message ??
                    error?.error ??
                    `Ledger administrator request failed (${response.status})`,
                response.status,
                error?.code ?? "ledger_admin_request_failed",
            );
        }
        try {
            return parse(payload);
        } catch {
            throw new LedgerAdminError(
                mutation
                    ? "The Ledger response could not be verified. Refresh the application list before trying another administrator action."
                    : "The Ledger administrator response was invalid.",
                response.status,
                "ledger_admin_invalid_response",
                mutation,
            );
        }
    }

    private async fetchResponse(
        method: "GET" | "POST",
        path: string,
        body: unknown,
        signal?: AbortSignal,
    ): Promise<Response> {
        const mutation = method !== "GET";
        let response: Response;
        try {
            response = await this.fetchRequest(`${this.baseUrl}${path}`, {
                method,
                cache: "no-store",
                credentials: "same-origin",
                redirect: "manual",
                signal,
                headers: withCloudflareAccessAjaxHeader({
                    Accept: "application/json",
                    ...(body === undefined
                        ? {}
                        : { "Content-Type": "application/json" }),
                }),
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch {
            throw new LedgerAdminError(
                mutation
                    ? "The request outcome is unknown. Refresh the application list before trying another administrator action."
                    : "Ledger administrator access could not be reached.",
                null,
                "ledger_admin_network_error",
                mutation,
            );
        }

        if (isAccessSessionExpiredResponse(response)) {
            requestAccessReauthentication();
            throw new LedgerAdminUnauthorizedError();
        }

        clearAccessReauthenticationAttempts();

        if (response.status === 403) {
            throw new LedgerAdminUnauthorizedError();
        }

        return response;
    }
}

function parseConnections(value: unknown): AdminConnectionsResponse {
    const record = objectValue(value);
    // Ledger releases before session history omit `recent`.
    const recent = record.recent ?? [];
    if (!Array.isArray(recent)) throw new TypeError();
    for (const item of recent) {
        const session = objectValue(item);
        for (const field of ["id", "logId", "principalId", "connectedAt"])
            if (typeof session[field] !== "string") throw new TypeError();
        for (const field of ["disconnectedAt", "lastSentAt", "logName"])
            if (!nullableString(session[field])) throw new TypeError();
        if (
            !positiveSafeInteger(session.generation) ||
            !Number.isSafeInteger(session.cursor) ||
            (session.cursor as number) < 0 ||
            !(
                session.closeCode === null ||
                (Number.isSafeInteger(session.closeCode) &&
                    (session.closeCode as number) >= 0)
            )
        )
            throw new TypeError();
        const client = objectValue(session.client);
        for (const field of ["ip", "userAgent", "country", "colo"])
            if (!nullableString(client[field])) throw new TypeError();
    }
    if (
        typeof record.sampledAt !== "string" ||
        !Number.isSafeInteger(record.total) ||
        (record.total as number) < 0 ||
        !Number.isSafeInteger(record.unavailable) ||
        (record.unavailable as number) < 0 ||
        !nullableString(record.nextAfterId) ||
        !Array.isArray(record.connections) ||
        record.connections.length > 100
    )
        throw new TypeError();
    for (const item of record.connections) {
        const connection = objectValue(item);
        for (const field of ["id", "logId", "principalId"])
            if (typeof connection[field] !== "string") throw new TypeError();
        for (const field of ["connectedAt", "lastSentAt", "logName"])
            if (!nullableString(connection[field])) throw new TypeError();
        if (
            !positiveSafeInteger(connection.generation) ||
            !Number.isSafeInteger(connection.cursor) ||
            (connection.cursor as number) < 0 ||
            !(
                connection.headVersion === null ||
                (Number.isSafeInteger(connection.headVersion) &&
                    (connection.headVersion as number) >= 0)
            ) ||
            !["connecting", "open", "closing", "closed"].includes(
                String(connection.state),
            )
        )
            throw new TypeError();
        const client = objectValue(connection.client);
        for (const field of ["ip", "userAgent", "country", "colo"])
            if (!nullableString(client[field])) throw new TypeError();
    }
    if (
        record.nextAfterId !== null &&
        record.nextAfterId !== record.connections.at(-1)?.id
    )
        throw new TypeError();
    return { ...(value as AdminConnectionsResponse), recent };
}

function parseAdminSession(value: unknown): AdminSession {
    const record = objectValue(value);
    if (typeof record.email !== "string" || !record.email)
        throw new TypeError();
    return { email: record.email };
}

function parseMetrics(value: unknown): AdminMetrics {
    const record = objectValue(value);
    for (const key of [
        "logCount",
        "eventCount",
        "entityCount",
        "databaseBytes",
        "connectedClients",
    ]) {
        if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0)
            throw new TypeError();
    }
    if (
        typeof record.sampledAt !== "string" ||
        !nullableString(record.lastUpdatedAt)
    )
        throw new TypeError();
    return {
        sampledAt: record.sampledAt,
        lastUpdatedAt: record.lastUpdatedAt,
        logCount: record.logCount as number,
        eventCount: record.eventCount as number,
        entityCount: record.entityCount as number,
        databaseBytes: record.databaseBytes as number,
        connectedClients: record.connectedClients as number,
    };
}

function parseEventPage(value: unknown): AdminEventPage {
    const record = objectValue(value);
    if (
        !Array.isArray(record.events) ||
        record.events.length > 50 ||
        !Number.isSafeInteger(record.headVersion) ||
        (record.headVersion as number) < 0 ||
        !(
            record.nextBeforeVersion === null ||
            positiveSafeInteger(record.nextBeforeVersion)
        )
    )
        throw new TypeError();
    const events = record.events.map(parseStoredEvent);
    if (
        events.some(
            (event, index) =>
                event.version > (record.headVersion as number) ||
                (index > 0 && event.version >= events[index - 1].version),
        )
    )
        throw new TypeError();
    if (
        record.nextBeforeVersion !== null &&
        record.nextBeforeVersion !== events.at(-1)?.version
    )
        throw new TypeError();
    return {
        events,
        headVersion: record.headVersion as number,
        nextBeforeVersion: record.nextBeforeVersion,
    };
}

function parseAppList(value: unknown): AdminAppListResponse {
    const record = objectValue(value);
    if (!Array.isArray(record.apps)) throw new TypeError();
    return { apps: record.apps.map(parseAppSummary) };
}

function parseAppTokenResponse(value: unknown): AdminAppTokenResponse {
    const record = objectValue(value);
    if (typeof record.token !== "string" || !record.token)
        throw new TypeError();
    return {
        app: parseAppSummary(record.app),
        token: record.token,
    };
}

function parseLogList(value: unknown): AdminLogListResponse {
    const record = objectValue(value);
    if (!Array.isArray(record.logs)) throw new TypeError();
    return { logs: record.logs.map(parseLogSummary) };
}

function parseApplicationExport(value: unknown): AdminApplicationExport {
    const record = objectValue(value);
    if (
        record.format !== "ledger-application-export" ||
        record.version !== 1 ||
        typeof record.exportedAt !== "string" ||
        !Array.isArray(record.logs)
    ) {
        throw new TypeError();
    }
    return {
        format: record.format,
        version: record.version,
        exportedAt: record.exportedAt,
        application: parseAppSummary(record.application),
        logs: record.logs.map(parseExportedLog),
    };
}

function parseExportedLog(value: unknown): AdminExportedLog {
    const record = objectValue(value);
    if (!Array.isArray(record.events)) throw new TypeError();
    return {
        ...parseLogSummary(record),
        events: record.events.map(parseStoredEvent),
    };
}

function parseStoredEvent(value: unknown): StoredEvent {
    const record = objectValue(value);
    if (
        !positiveSafeInteger(record.version) ||
        typeof record.id !== "string" ||
        typeof record.type !== "string" ||
        typeof record.entityId !== "string" ||
        !positiveSafeInteger(record.entityVersion) ||
        !Number.isSafeInteger(record.timestamp) ||
        !record.payload ||
        typeof record.payload !== "object" ||
        Array.isArray(record.payload)
    ) {
        throw new TypeError();
    }
    return {
        version: record.version,
        id: record.id,
        type: record.type,
        entityId: record.entityId,
        entityVersion: record.entityVersion,
        timestamp: record.timestamp as number,
        payload: record.payload as Record<string, unknown>,
    };
}

function parseLogSummary(value: unknown): AdminLogSummary {
    const record = objectValue(value);
    if (
        typeof record.id !== "string" ||
        typeof record.name !== "string" ||
        !Number.isSafeInteger(record.headVersion) ||
        (record.headVersion as number) < 0 ||
        typeof record.createdAt !== "string" ||
        !nullableString(record.lastUpdatedAt)
    ) {
        throw new TypeError();
    }
    return {
        id: record.id,
        name: record.name,
        headVersion: record.headVersion as number,
        createdAt: record.createdAt,
        lastUpdatedAt: record.lastUpdatedAt,
    };
}

function parseAppSummary(value: unknown): AdminAppSummary {
    const record = objectValue(value);
    if (
        typeof record.id !== "string" ||
        typeof record.name !== "string" ||
        typeof record.createdAt !== "string" ||
        !nullableString(record.revokedAt) ||
        !nullableString(record.activeTokenCreatedAt)
    ) {
        throw new TypeError();
    }
    return {
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        revokedAt: record.revokedAt,
        activeTokenCreatedAt: record.activeTokenCreatedAt,
    };
}

function parseAdminError(value: unknown): AdminErrorResponse | null {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const record = value as Record<string, unknown>;
    if (typeof record.error !== "string" || typeof record.code !== "string") {
        return null;
    }
    return {
        error: record.error,
        code: record.code,
        message:
            typeof record.message === "string" || record.message === null
                ? record.message
                : undefined,
    };
}

function objectValue(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError();
    }
    return value as Record<string, unknown>;
}

function nullableString(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}

function positiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}
