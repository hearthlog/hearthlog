/**
 * HTTP Client for the Ledger Service API
 *
 * HTTP transport with retry logic, request/response logging, realtime socket
 * construction, and API error handling.
 */

import { EventSocket } from "./socket.js";
import type { LedgerConfig, RetryPolicy } from "./config.js";
import type {
    LogSummary,
    LogListResponse,
    CreateLogRequest,
    CreateLogResponse,
    ForkLogRequest,
    LogMetadata,
    AppendEventsRequest,
    AppendEventsResponse,
    ConflictResponse,
    EventBatch,
    StoredEvent,
    SessionResponse,
    ErrorResponse,
    EntityVersionChainErrorResponse,
} from "./types.js";
import {
    LedgerServiceError,
    VersionConflictError,
    NotFoundError,
    AuthenticationError,
    EntityVersionChainError,
    IdempotencyMismatchError,
    isLedgerServiceError,
    isVersionConflictError,
    isNotFoundError,
    isAuthenticationError,
} from "./errors.js";
import { fetchAccessProtected } from '../access/session.js';

// Re-export errors for convenience
export {
    LedgerServiceError,
    VersionConflictError,
    NotFoundError,
    AuthenticationError,
} from "./errors.js";

/**
 * Options for HTTP requests
 */
interface RequestOptions {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
    queryParams?: Record<string, string | number | undefined>;
}

/**
 * Client for the Ledger Service API.
 */
export class LedgerClient {
    private readonly config: LedgerConfig;
    private readonly baseUrl: string;

    constructor(config: LedgerConfig) {
        this.config = config;
        // Ensure baseUrl doesn't have trailing slash
        this.baseUrl = config.baseUrl.replace(/\/$/, "");
    }

    /**
     * Get the base URL for the client
     */
    getBaseUrl(): string {
        return this.baseUrl;
    }

    /**
     * Get the auth token for the client
     */
    getAuthToken(): string | undefined {
        return this.config.authToken;
    }

    private supportsActionMetadata = false;
    private capabilitiesChecked = false;
    private supportsWorkspaceRestore = false;
    private supportsEventExcision = false;
    private sessionRequest: Promise<SessionResponse> | null = null;

    async getWorkspaceRestoreSupport(): Promise<boolean> {
        if (!this.capabilitiesChecked) await this.getSession();
        return this.supportsWorkspaceRestore;
    }

    async getEventExcisionSupport(): Promise<boolean> {
        if (!this.capabilitiesChecked) await this.getSession();
        return this.supportsEventExcision;
    }

    private replayVersion(): number {
        if (this.supportsEventExcision) return 2;
        if (this.supportsWorkspaceRestore) return 1;
        return 0;
    }

    async getActionMetadataSupport(): Promise<boolean> {
        if (!this.capabilitiesChecked) await this.getSession();
        return this.supportsActionMetadata;
    }

    async getSession(): Promise<SessionResponse> {
        this.sessionRequest ??= this.request<SessionResponse>({ method: "GET", path: "/session" })
            .then((session) => {
                this.supportsActionMetadata = session.capabilities?.includes('action-metadata-v1') ?? false;
                this.supportsWorkspaceRestore = session.capabilities?.includes('workspace-restore-v1') ?? false;
                this.supportsEventExcision = session.capabilities?.includes('event-excision-v1') ?? false;
                this.capabilitiesChecked = true;
                return session;
            })
            .finally(() => { this.sessionRequest = null; });
        return this.sessionRequest;
    }

    /**
     * Makes an HTTP request with retry logic and error handling
     */
    private async request<T>(options: RequestOptions): Promise<T> {
        const { method, path, body, queryParams } = options;

        // Build URL with query parameters
        let url = `${this.baseUrl}${path}`;
        if (queryParams) {
            const params = new URLSearchParams();
            Object.entries(queryParams).forEach(([key, value]) => {
                if (value !== undefined) {
                    params.append(key, String(value));
                }
            });
            const queryString = params.toString();
            if (queryString) {
                url += `?${queryString}`;
            }
        }

        // Build headers
        const headers: Record<string, string> = {
            "Content-Type": "application/json",

        };
        if (this.supportsWorkspaceRestore || this.supportsEventExcision) headers["X-Ledger-Replay-Version"] = String(this.replayVersion());
        if (this.config.authToken) {
            headers["Authorization"] = `Bearer ${this.config.authToken}`;
        }

        // Log request
        this.logRequest(method, url, body);

        // Execute request with retry logic
        return await this.executeWithRetry(async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(
                () => controller.abort(),
                this.config.timeout,
            );

            try {
                const response = await fetchAccessProtected(url, {
                    method,
                    headers,
                    body: body ? JSON.stringify(body) : undefined,
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                // Handle response
                return await this.handleResponse<T>(response);
            } catch (error) {
                clearTimeout(timeoutId);

                // Handle abort/timeout
                if (error instanceof Error && error.name === "AbortError") {
                    throw new LedgerServiceError(
                        `Request timeout after ${this.config.timeout}ms`,
                    );
                }

                // Handle network errors
                if (error instanceof TypeError) {
                    throw new LedgerServiceError(`Network error: ${error.message}`);
                }

                throw error;
            }
        }, this.config.retryPolicy);
    }

    /**
     * Executes a function with exponential backoff retry logic
     */
    private async executeWithRetry<T>(
        fn: () => Promise<T>,
        retryPolicy: RetryPolicy,
    ): Promise<T> {
        let lastError: Error | undefined;
        let delay = retryPolicy.initialDelayMs;

        for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error as Error;

                // Don't retry on certain errors
                if (
                    isVersionConflictError(error) ||
                    isNotFoundError(error) ||
                    isAuthenticationError(error) ||
                    (isLedgerServiceError(error) &&
                        error.statusCode !== undefined &&
                        error.statusCode >= 400 &&
                        error.statusCode < 500)
                ) {
                    throw error;
                }

                // Don't retry if this was the last attempt
                if (attempt === retryPolicy.maxRetries) {
                    break;
                }

                // Log retry attempt
                this.logRetry(
                    attempt + 1,
                    retryPolicy.maxRetries,
                    delay,
                    error as Error,
                );

                // Wait before retrying
                await this.sleep(delay);

                // Calculate next delay with exponential backoff
                delay = Math.min(
                    delay * retryPolicy.backoffMultiplier,
                    retryPolicy.maxDelayMs,
                );
            }
        }

        throw lastError;
    }

    /**
     * Handles HTTP response and converts to typed result or throws appropriate error
     */
    private async handleResponse<T>(response: Response): Promise<T> {
        const contentType = response.headers.get("content-type");
        const isJson = contentType?.includes("application/json");

        // Handle success responses
        if (response.ok) {
            if (response.status === 204) {
                // No content
                return undefined as T;
            }

            const data = isJson ? await response.json() : await response.text();
            this.logResponse(response.status, data);
            return data as T;
        }

        // Handle error responses
        let errorData: unknown;
        try {
            errorData = isJson ? await response.json() : await response.text();
        } catch {
            errorData = null;
        }

        this.logResponse(response.status, errorData);
        const errorResponse = errorData && typeof errorData === "object"
            ? errorData as Partial<ErrorResponse>
            : null;

        // Handle specific error status codes
        switch (response.status) {
            case 401:
            case 403:
                throw new AuthenticationError(
                    `Authentication failed: ${response.statusText}`,
                    response.status,
                    errorResponse?.code ?? "unauthorized",
                );

            case 404:
                throw new NotFoundError(
                    `Resource not found: ${response.statusText}`,
                    errorResponse?.code ?? "not_found",
                );

            case 409:
                if (errorResponse?.code === "entity_conflict") {
                    throw new VersionConflictError(
                        "Version conflict detected",
                        errorData as ConflictResponse,
                    );
                }
                if (errorResponse?.code === "invalid_entity_version_chain") {
                    throw new EntityVersionChainError(
                        errorData as EntityVersionChainErrorResponse,
                    );
                }
                if (errorResponse?.code === "idempotency_mismatch") {
                    throw new IdempotencyMismatchError(errorData);
                }
                throw new LedgerServiceError(
                    `Conflict: ${response.statusText}`,
                    409,
                    errorData,
                    errorResponse?.code,
                );

            case 400:
                throw new LedgerServiceError(
                    `Bad request: ${JSON.stringify(errorData)}`,
                    400,
                    errorData,
                    errorResponse?.code,
                );

            case 422:
                // Ledger names the offending event and key, which is the reason
                // shown for a rejected batch.
                throw new LedgerServiceError(
                    errorResponse?.message ?? `Rejected: ${response.statusText}`,
                    422,
                    errorData,
                    errorResponse?.code,
                );

            case 500:
            case 502:
            case 503:
            case 504:
                throw new LedgerServiceError(
                    `Server error: ${response.statusText}`,
                    response.status,
                    errorData,
                    errorResponse?.code,
                );

            default:
                throw new LedgerServiceError(
                    `HTTP ${response.status}: ${response.statusText}`,
                    response.status,
                    errorData,
                    errorResponse?.code,
                );
        }
    }

    /**
     * Logs an outgoing request
     */
    private logRequest(method: string, url: string, _body?: unknown): void {
        if (typeof console !== "undefined") {
            console.debug(`[LedgerClient] ${method} ${url}`);
        }
    }

    /**
     * Logs a response
     */
    private logResponse(status: number, _data: unknown): void {
        if (typeof console !== "undefined") {
            console.debug(`[LedgerClient] Response ${status}`);
        }
    }

    /**
     * Logs a retry attempt
     */
    private logRetry(
        attempt: number,
        maxRetries: number,
        delayMs: number,
        error: Error,
    ): void {
        if (typeof console !== "undefined") {
            console.warn(
                `[LedgerClient] Retry ${attempt}/${maxRetries} after ${delayMs}ms due to:`,
                error.message,
            );
        }
    }

    /**
     * Sleep utility for retry delays
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ============================================================================
    // Log Management Endpoints
    // ============================================================================

    /**
     * Lists all available logs
     * GET /logs
     */
    async listLogs(): Promise<LogSummary[]> {
        const response = await this.listLogsResponse();
        return response.logs;
    }

    async listLogsResponse(): Promise<LogListResponse> {
        return await this.request<LogListResponse>({
            method: "GET",
            path: "/logs",
        });
    }

    /**
     * Creates a new log
     * POST /logs
     */
    async createLog(request: CreateLogRequest): Promise<CreateLogResponse> {
        return await this.request<CreateLogResponse>({
            method: "POST",
            path: "/logs",
            body: request,
        });
    }

    async forkLog(sourceLogId: string, request: ForkLogRequest): Promise<LogSummary> {
        return await this.request<LogSummary>({
            method: 'POST',
            path: `/logs/${encodeURIComponent(sourceLogId)}/forks`,
            body: request,
        });
    }

    async setLogVisibility(logId: string, hidden: boolean): Promise<LogSummary> {
        return await this.request<LogSummary>({
            method: 'POST',
            path: `/logs/${encodeURIComponent(logId)}/visibility`,
            body: { hidden },
        });
    }

    async finalizeFork(logId: string): Promise<LogSummary> {
        return await this.request<LogSummary>({
            method: 'POST',
            path: `/logs/${encodeURIComponent(logId)}/finalize-fork`,
        });
    }

    /**
     * Gets metadata for a specific log
     * GET /logs/{logId}
     */
    async getLog(logId: string): Promise<LogMetadata> {
        return await this.request<LogMetadata>({
            method: "GET",
            path: `/logs/${encodeURIComponent(logId)}`,
        });
    }

    /**
     * Deletes a log
     * DELETE /logs/{logId}
     */
    async deleteLog(logId: string): Promise<void> {
        await this.request<void>({
            method: "DELETE",
            path: `/logs/${encodeURIComponent(logId)}`,
        });
    }

    // ============================================================================
    // Event Append Endpoint
    // ============================================================================

    /**
     * Appends events to a log
     * POST /logs/{logId}/events
     *
     * @throws {VersionConflictError} when entity version conflict occurs (HTTP 409)
     */
    async appendEvents(
        logId: string,
        request: AppendEventsRequest,
    ): Promise<AppendEventsResponse> {
        await this.getWorkspaceRestoreSupport();
        return await this.request<AppendEventsResponse>({
            method: "POST",
            path: `/logs/${encodeURIComponent(logId)}/events`,
            body: request,
        });
    }

    // ============================================================================
    // Event Query Endpoints
    // ============================================================================

    /**
     * Gets events from a log, optionally after a specific version
     * GET /logs/{logId}/events
     */
    async getEvents(
        logId: string,
        afterVersion?: number,
    ): Promise<StoredEvent[]> {
        const events: StoredEvent[] = [];
        let cursor = afterVersion ?? 0;
        while (true) {
            const page = await this.getEventPage(logId, cursor);
            events.push(...page);
            if (page.length < 512) return events;
            cursor = page[page.length - 1].version;
        }
    }

    async getEventPage(
        logId: string,
        afterVersion = 0,
        limit = 512,
    ): Promise<StoredEvent[]> {
        await this.getWorkspaceRestoreSupport();
        const response = await this.request<EventBatch>({
            method: "GET",
            path: `/logs/${encodeURIComponent(logId)}/events`,
            queryParams: { afterVersion, limit },
        });
        return response.events;
    }

    // ============================================================================
    // WebSocket realtime delivery
    // ============================================================================

    createEventSocket(logId: string, afterVersion = 0): EventSocket {
        return new EventSocket({
            afterVersion,
            urlProvider: (cursor) =>
                buildEventSocketUrl(
                    this.baseUrl,
                    logId,
                    cursor,
                    typeof window === "undefined"
                        ? undefined
                        : window.location.href,
                    this.supportsWorkspaceRestore ? this.replayVersion() : 0,
                ),
            autoReconnect: true,
        });
    }
}

export function buildEventSocketUrl(
    baseUrl: string,
    logId: string,
    afterVersion: number,
    browserUrl?: string,
    replayVersion = 0,
): string {
    const path =
        `${baseUrl.replace(/\/$/, "")}/logs/${encodeURIComponent(logId)}` +
        "/events/socket";
    let socket: URL;
    if (baseUrl.startsWith("/")) {
        if (!browserUrl) {
            throw new Error(
                "A browser URL is required for a relative Ledger service URL",
            );
        }
        socket = new URL(path, new URL(browserUrl).origin);
    } else {
        socket = new URL(path);
    }
    if (socket.protocol === "https:") socket.protocol = "wss:";
    else if (socket.protocol === "http:") socket.protocol = "ws:";
    else throw new Error("Ledger service URL must use HTTP or HTTPS");
    socket.searchParams.set("afterVersion", String(afterVersion));
    if (replayVersion > 0) socket.searchParams.set("replayVersion", String(replayVersion));
    return socket.toString();
}
