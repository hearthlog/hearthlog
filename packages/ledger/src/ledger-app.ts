import { DurableObject } from "cloudflare:workers";
import { LogMaintenanceStore } from './log-maintenance';
import type { CheckpointChunk, LogMaintenance, CompactionPreview } from '@hearthlog/contracts/history/checkpoint';

import { SOCKET_PROTOCOL } from "./auth";
import {
    INTERNAL_SOCKET_ACCESS_HEADER,
    type AccessClaims,
    type InitializeRequest,
    parseAccessClaims,
    decodeRpc,
    parseInitializeRequest,
    parseNonnegativeInteger,
    parseRevokeRequest,
    parseRotateRequest,
    parseSocketAttachment,
    parseStoredAppendEventsResponse,
    parseUuid,
    type RevokeRequest,
    type RotateRequest,
    type SocketAttachment,
    type SocketFrame,
} from "./contracts";
import { effectiveValidationMode, findPayloadViolations, parseEventPolicy, type EventPolicy } from "./event-validation";
import {
    buildStoredEvent,
    normalizeActor,
    fileReference,
    hashAppendRequest,
    validateEntityChain,
    validateIncomingEvents,
} from "./domain";
import {
    errorResponse,
    jsonError,
    LedgerError,
    normalizeError,
    validationError,
} from "./errors";
import { type RpcResult, rpcCall, rpcSuccess } from "./rpc";
import { fenceError, parseFence, validateFenceRequest, type Fence, type FenceRequest } from "./fence";
import { migrateLedgerApp } from "./schema";
import {
    chainChecksum,
    checksumLine,
    parseTransferRecords,
    TRANSFER_FORMAT,
    TRANSFER_PAGE,
    TRANSFER_VERSION,
    transferError,
    type LogChecksum,
    type TransferRecord,
    type TransferTotals,
} from "./transfer";
import { sqliteExport } from "./sqlite-export";
import {
    applicationSummary,
    appendEventsBody,
    type ApplicationSummary,
    type AppendEventsRequest,
    type AppendEventsResponse,
    type CreateLogRequest,
    type CreateLogResponse,
    createLogBody,
    forkLogBody,
    logVisibilityBody,
    logLineageBody,
    type ForkLogRequest,
    type LogVisibilityRequest,
    type EventBatchResponse,
    type LogSummary,
    type StoredEvent,
    adminEventsQuery,
    type AdminEventsQuery,
    type AdminEventsResponse,
    type AdminMetrics,
    adminConnectionsQuery,
    type AdminConnectionsQuery,
    type AdminConnectionsResponse,
    type AdminConnection,
    type AdminRecentConnection,
} from "./schemas";

const MAX_CATCH_UP = 512;
// Sessions kept for the administrator console, including live ones.
const RECENT_SOCKET_SESSIONS = 50;
// Durable Object SQLite limits a row to 2 MB; leave room for the other
// append_requests columns.
const MAX_APPEND_RESPONSE_BYTES = 1_900_000;
const ADMIN_EXPORT_FORMAT = "ledger-application-export";
const ADMIN_EXPORT_VERSION = 1;

interface MetadataRow extends Record<string, SqlStorageValue> {
    app_id: string;
    principal_id: string;
    principal_generation: number;
    revoked_at: string | null;
}

interface LogRow extends Record<string, SqlStorageValue> {
    id: string;
    name: string;
    version: number;
    created_at: string;
    last_updated_at: string | null;
    source_log_id: string | null;
    source_log_name: string | null;
    source_version: number | null;
    source_timestamp: string | null;
    status: 'ready' | 'preparing';
    hidden_at: string | null;
}

interface EventRow extends Record<string, SqlStorageValue> {
    version: number;
    event_id: string;
    event_type: string;
    entity_id: string;
    entity_version: number;
    event_timestamp: string;
    payload: string;
    action_id: string | null;
    action_index: number | null;
    action_size: number | null;
    actor: string | null;
}

interface SocketSessionRow extends Record<string, SqlStorageValue> {
    connection_id: string;
    log_id: string;
    principal_id: string;
    principal_generation: number;
    connected_at: string;
    disconnected_at: string | null;
    close_code: number | null;
    cursor: number;
    last_sent_at: string | null;
    user_agent: string | null;
    ip: string | null;
    country: string | null;
    colo: string | null;
}

export class LedgerApp extends DurableObject<Env> {
    private maintenanceQueue: Promise<unknown> = Promise.resolve();

    private maintenance(assertWritable: () => void = () => undefined): LogMaintenanceStore {
        const appId = this.ctx.storage.sql.exec<{ app_id: string }>('SELECT app_id FROM app_metadata WHERE singleton = 1').one().app_id;
        const store = new LogMaintenanceStore(this.ctx.storage, this.env.LEDGER_ARCHIVE, appId,
            async (logId, after, through, limit, entityId) => {
                const rows = store.observeSql(this.ctx.storage.sql.exec<EventRow>(`WITH candidates AS (
                    SELECT *, SUM(COALESCE(payload_bytes, length(CAST(payload AS BLOB)))) OVER (ORDER BY version) AS byte_count,
                        ROW_NUMBER() OVER (ORDER BY version) AS row_number
                    FROM (SELECT * FROM log_events WHERE log_id = ? AND version > ? AND version <= ?
                        ${entityId === undefined ? '' : 'AND entity_id = ?'} ORDER BY version LIMIT ?)
                ) SELECT * FROM candidates WHERE byte_count <= 1500000 OR row_number = 1`,
                    logId, after, through, ...(entityId === undefined ? [] : [entityId]), limit)).toArray();
                return store.hydrate(logId, rows.map(storedEvent));
            }, assertWritable, Math.max(128, Math.min(100000, Number(this.env.MAINTENANCE_DAILY_WRITES) || 10000)),
            Math.max(10000, Math.min(1_000_000_000, Number(this.env.MAINTENANCE_DAILY_READS) || 1_000_000)));
        return store;
    }

    async logMaintenance(access: AccessClaims, logId: string): Promise<RpcResult<LogMaintenance>> {
        return rpcCall(() => {
            this.currentAccess(access);
            if (!this.log(parseUuid(logId, 'log id'))) throw validationError('Log not found');
            return rpcSuccess(this.maintenance().state(logId));
        });
    }

    async compactionPreview(access: AccessClaims, logId: string): Promise<RpcResult<CompactionPreview>> {
        return rpcCall(() => {
            this.currentAccess(access);
            if (!this.log(parseUuid(logId, 'log id'))) throw validationError('Log not found');
            return rpcSuccess(this.maintenance().preview(logId));
        });
    }

    async startLogMaintenance(access: AccessClaims, logId: string, id: string, kind: 'snapshot' | 'compact', expectedCheckpointId?: string, expectedGeneration?: number): Promise<RpcResult<LogMaintenance>> {
        return rpcCall(() => {
            this.writableAccess(access);
            return rpcSuccess(this.maintenance().start(parseUuid(logId, 'log id'), parseUuid(id, 'request id'), kind, expectedCheckpointId, expectedGeneration));
        });
    }

    async stepLogMaintenance(access: AccessClaims, logId: string, id: string): Promise<RpcResult<LogMaintenance>> {
        return rpcCall(async () => {
            this.writableAccess(access);
            const run = this.maintenanceQueue.then(() => this.maintenance(() => { this.writableAccess(access); }).step(parseUuid(logId, 'log id'), parseUuid(id, 'request id')));
            this.maintenanceQueue = run.then(() => undefined, () => undefined);
            const result = await run;
            this.currentAccess(access);
            return rpcSuccess(result);
        });
    }

    async checkpointChunk(access: AccessClaims, logId: string, index: number): Promise<RpcResult<Omit<CheckpointChunk, 'events'> & { events: StoredEvent[] }>> {
        return rpcCall(async () => {
            this.currentAccess(access);
            const result = await this.maintenance().chunk(parseUuid(logId, 'log id'), parseNonnegativeInteger(index, 'page'));
            this.currentAccess(access);
            return rpcSuccess({ ...result, events: result.events.map(event => ({ ...event, payload: event.payload as StoredEvent['payload'] })) });
        });
    }
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.ctx.blockConcurrencyWhile(async () => {
            migrateLedgerApp(this.ctx.storage);
        });
    }

    /** Delete storage belonging to an explicitly deleted log, in bounded batches. */
    override async alarm(): Promise<void> {
        const job = this.ctx.storage.sql.exec<{ log_id: string }>('SELECT log_id FROM log_archive_deletions LIMIT 1').toArray()[0];
        if (!job) return;
        try {
            const app = this.ctx.storage.sql.exec<{ app_id: string }>('SELECT app_id FROM app_metadata WHERE singleton = 1').one();
            const bucket = this.env.LEDGER_ARCHIVE;
            const objects = await bucket.list({ prefix: `v1/${app.app_id}/${job.log_id}/`, limit: 128 });
            if (objects.objects.length) await bucket.delete(objects.objects.map(object => object.key));
            if (!objects.truncated) this.ctx.storage.sql.exec('DELETE FROM log_archive_deletions WHERE log_id = ?', job.log_id);
        } finally {
            if (this.ctx.storage.sql.exec('SELECT 1 FROM log_archive_deletions LIMIT 1').toArray().length) {
                await this.ctx.storage.setAlarm(Date.now() + 60_000);
            }
        }
    }

    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const pathname = url.pathname;
        const segments = routeSegments(pathname);
        if (
            request.method === "GET" &&
            segments.length === 4 &&
            segments[0] === "logs" &&
            segments[2] === "events" &&
            segments[3] === "socket" &&
            pathname === `/logs/${segments[1]}/events/socket`
        ) {
            try {
                const access = internalSocketAccess(request);
                const logId = parseUuid(segments[1], "logId");
                const afterVersion = parseNonnegativeInteger(
                    Number(url.searchParams.get("afterVersion") ?? 0),
                    "afterVersion",
                );
                return this.upgradeSocket(request, access, logId, afterVersion);
            } catch (cause) {
                if (cause instanceof LedgerError) {
                    return errorResponse(cause);
                }
                console.error(
                    JSON.stringify({
                        message: "Ledger WebSocket upgrade failed",
                        error: normalizeError(cause).message,
                    }),
                );
                return jsonError("internal_error", "internal error", 500);
            }
        }
        return jsonError("not_found", "resource not found", 404);
    }

    override webSocketMessage(
        ws: WebSocket,
        _message: string | ArrayBuffer,
    ): void {
        this.sendFrame(ws, {
            type: "error",
            code: "client_messages_not_supported",
        });
        ws.close(1008, "server-to-client protocol");
    }

    override webSocketClose(
        ws: WebSocket,
        code: number,
        _reason: string,
        _wasClean: boolean,
    ): void {
        this.recordSocketDisconnect(ws, code);
    }

    override webSocketError(ws: WebSocket, cause: unknown): void {
        console.error(
            JSON.stringify({
                message: "Ledger WebSocket error",
                error: normalizeError(cause).message,
            }),
        );
        this.recordSocketDisconnect(ws, null);
    }

    async getSession(
        access: AccessClaims,
    ): Promise<RpcResult<{ appId: string; principalId: string; capabilities: string[]; fence?: Fence }>> {
        return rpcCall(() => {
            const claims = this.currentAccess(access);
            const fence = this.fence();
            return rpcSuccess({
                appId: claims.appId,
                principalId: claims.principalId,
                capabilities: ["snapshot-baseline-v1", "action-metadata-v1", "workspace-restore-v1", "event-excision-v1"],
                ...(fence ? { fence } : {}),
            });
        });
    }

    async listLogs(
        access: AccessClaims,
    ): Promise<RpcResult<{ logs: LogSummary[] }>> {
        return rpcCall(() => {
            this.currentAccess(access);
            return rpcSuccess(this.listLogsValue());
        });
    }

    async administratorListLogs(
        appId: string,
    ): Promise<RpcResult<{ logs: LogSummary[] }>> {
        return rpcCall(() => {
            this.administratorApplication(appId);
            return rpcSuccess(this.listLogsValue());
        });
    }

    async administratorSetLogLineage(appId: string, logId: string, payload: unknown): Promise<RpcResult<LogSummary>> {
        return rpcCall(async () => {
            this.administratorApplication(appId);
            const { sourceLogId, sourceVersion } = decodeRpc(logLineageBody, payload, 'log lineage');
            // Prefix identity is logical, even when the two logs use different
            // physical archive layouts. Never compare '{}' payload placeholders.
            for (let after = 0; after < sourceVersion;) {
                const child = await this.hydrateEvents(logId, this.eventsThrough(logId, after, sourceVersion, 128));
                const parent = await this.hydrateEvents(sourceLogId, this.eventsThrough(sourceLogId, after, sourceVersion, 128));
                if (!child.length || child.length !== parent.length || child.some((event, index) => event.id !== parent[index]!.id
                    || JSON.stringify(event.payload) !== JSON.stringify(parent[index]!.payload))) throw validationError('Fork prefix does not match its source');
                after = child[child.length - 1]!.version;
            }

            this.ctx.storage.transactionSync(() => {
                const target = this.log(logId);
                const source = this.log(sourceLogId);
                if (!target || !source || logId === sourceLogId) throw validationError('Source and target logs must exist and differ');
                if (target.source_log_id) {
                    if (target.source_log_id === sourceLogId && target.source_version === sourceVersion) return;
                    throw validationError('Log lineage is already set');
                }
                if (sourceVersion > source.version || sourceVersion > target.version) {
                    throw validationError('Source version exceeds a log head');
                }
                let ancestor = source;
                while (ancestor.source_log_id) {
                    if (ancestor.source_log_id === logId) throw validationError('Log lineage cannot form a cycle');
                    const next = this.log(ancestor.source_log_id);
                    if (!next) throw validationError('Source ancestry is incomplete');
                    ancestor = next;
                }
                const mismatches = this.ctx.storage.sql.exec<{ count: number }>(
                    `SELECT COUNT(*) AS count FROM log_events AS child
                     LEFT JOIN log_events AS parent ON parent.log_id = ? AND parent.version = child.version
                     WHERE child.log_id = ? AND child.version <= ?
                       AND (parent.event_id IS NULL OR parent.event_id != child.event_id)`,
                    sourceLogId, logId, sourceVersion,
                ).toArray()[0]?.count ?? 0;
                if (mismatches) throw validationError('Fork prefix does not match its source');
                this.ctx.storage.sql.exec(
                    'UPDATE logs SET source_log_id = ?, source_version = ? WHERE id = ?',
                    sourceLogId, sourceVersion, logId,
                );
            });
            return rpcSuccess(this.getLogValue(logId));
        });
    }

    async administratorExportApplication(
        application: ApplicationSummary,
    ): Promise<Response> {
        const parsed = decodeRpc(
            applicationSummary,
            application,
            "application summary",
        );
        this.administratorApplication(parsed.id);
        const logs = this.logRows().map(logSummary);
        const exportedAt = new Date().toISOString();
        return new Response(
            byteStream(this.applicationExportChunks(parsed, logs, exportedAt)),
            {
                headers: {
                    "Cache-Control": "no-store",
                    "Content-Disposition": `attachment; filename="${exportFilename(parsed.name, exportedAt)}"`,
                    "Content-Security-Policy": "default-src 'none'; sandbox",
                    "Content-Type": "application/json; charset=utf-8",
                    "X-Content-Type-Options": "nosniff",
                },
            },
        );
    }

    async administratorMetrics(
        appId: string,
    ): Promise<RpcResult<AdminMetrics>> {
        return rpcCall(() => {
            this.administratorApplication(appId);
            const logs = this.logRows();
            const { count } = this.ctx.storage.sql
                .exec<{ count: number }>(
                    "SELECT COUNT(*) AS count FROM entity_claims",
                )
                .one();
            return rpcSuccess({
                sampledAt: new Date().toISOString(),
                logCount: logs.length,
                eventCount: logs.reduce((total, log) => total + log.version, 0),
                entityCount: count,
                databaseBytes: this.ctx.storage.sql.databaseSize,
                connectedClients: this.ctx.getWebSockets().length,
                lastUpdatedAt: logs.reduce<string | null>(
                    (latest, log) =>
                        log.last_updated_at &&
                        (!latest || log.last_updated_at > latest)
                            ? log.last_updated_at
                            : latest,
                    null,
                ),
            });
        });
    }

    async administratorExportSqlite(appId: string): Promise<Response> {
        this.administratorApplication(appId);
        if (this.ctx.storage.sql.exec('SELECT 1 FROM log_events WHERE archive_key IS NOT NULL LIMIT 1').toArray().length
            || this.ctx.storage.sql.exec('SELECT 1 FROM log_storage WHERE checkpoint IS NOT NULL LIMIT 1').toArray().length) {
            return jsonError('archive_bundle_required', 'Use the complete logical export or application transfer; archived payloads are outside SQLite.', 409);
        }
        return sqliteExport(
            this.ctx.storage,
            `ledger-${appId}-${new Date().toISOString().replaceAll(":", "-")}`,
        );
    }

    async administratorConnections(
        appId: string,
        query: AdminConnectionsQuery,
    ): Promise<RpcResult<AdminConnectionsResponse>> {
        return rpcCall(() => {
            this.administratorApplication(appId);
            const { afterId } = decodeRpc(
                adminConnectionsQuery,
                query,
                "connections query",
            );
            const sockets = this.ctx.getWebSockets();
            const logs = new Map(this.logRows().map((log) => [log.id, log]));
            let unavailable = 0;
            const connections: AdminConnection[] = [];
            for (const socket of sockets) {
                let attachment: SocketAttachment;
                try {
                    attachment = parseSocketAttachment(
                        socket.deserializeAttachment(),
                    );
                } catch {
                    unavailable++;
                    continue;
                }
                if (!attachment.connectionId) {
                    // Existing hibernated sockets predate connection metadata.
                    // Assign identity, but leave unknown timestamps/client info unknown.
                    attachment.connectionId = crypto.randomUUID();
                    socket.serializeAttachment(attachment);
                }
                const log = logs.get(attachment.logId);
                connections.push({
                    id: attachment.connectionId,
                    logId: attachment.logId,
                    logName: log?.name ?? null,
                    principalId: attachment.principalId,
                    generation: attachment.generation,
                    state:
                        (["connecting", "open", "closing", "closed"] as const)[
                            socket.readyState
                        ] ?? "closed",
                    cursor: attachment.cursor,
                    headVersion: log?.version ?? null,
                    connectedAt: attachment.connectedAt ?? null,
                    lastSentAt: attachment.lastSentAt ?? null,
                    client: attachment.client ?? {
                        userAgent: null,
                        ip: null,
                        country: null,
                        colo: null,
                    },
                });
            }
            connections.sort((a, b) => a.id.localeCompare(b.id));
            const remaining = connections.filter(
                (item) => !afterId || item.id > afterId,
            );
            const page = remaining.slice(0, 100);
            const live = new Set(connections.map((item) => item.id));
            const recent: AdminRecentConnection[] = this.ctx.storage.sql
                .exec<SocketSessionRow>(
                    `SELECT connection_id, log_id, principal_id,
                            principal_generation, connected_at, disconnected_at,
                            close_code, cursor, last_sent_at, user_agent, ip,
                            country, colo
                     FROM socket_sessions
                     ORDER BY connected_at DESC, connection_id DESC
                     LIMIT ?`,
                    RECENT_SOCKET_SESSIONS,
                )
                .toArray()
                .filter((row) => !live.has(row.connection_id))
                .map((row) => ({
                    id: row.connection_id,
                    logId: row.log_id,
                    logName: logs.get(row.log_id)?.name ?? null,
                    principalId: row.principal_id,
                    generation: row.principal_generation,
                    cursor: row.cursor,
                    connectedAt: row.connected_at,
                    disconnectedAt: row.disconnected_at,
                    closeCode: row.close_code,
                    lastSentAt: row.last_sent_at,
                    client: {
                        userAgent: row.user_agent,
                        ip: row.ip,
                        country: row.country,
                        colo: row.colo,
                    },
                }));
            return rpcSuccess({
                sampledAt: new Date().toISOString(),
                total: sockets.length,
                unavailable,
                connections: page,
                nextAfterId:
                    remaining.length > page.length ? page.at(-1)!.id : null,
                recent,
            });
        });
    }

    async administratorListEvents(
        appId: string,
        logId: string,
        query: AdminEventsQuery,
    ): Promise<RpcResult<AdminEventsResponse>> {
        return rpcCall(async () => {
            this.administratorApplication(appId);
            const id = parseUuid(logId, "log id");
            const parsed = decodeRpc(
                adminEventsQuery,
                query,
                "admin events query",
            );
            const log = this.log(id);
            if (!log)
                throw new LedgerError(404, {
                    error: "log not found",
                    code: "log_not_found",
                });
            const limit = parsed.limit ?? 50;
            const search = parsed.search?.trim().toLowerCase();
            const conditions = ["log_id = ?"];
            const bindings: SqlStorageValue[] = [id];
            if (parsed.beforeVersion !== undefined) {
                conditions.push("version < ?");
                bindings.push(parsed.beforeVersion);
            }
            if (search) {
                conditions.push(
                    "(instr(lower(event_type), ?) > 0 OR instr(lower(entity_id), ?) > 0 OR instr(lower(event_id), ?) > 0)",
                );
                bindings.push(search, search, search);
            }
            const rows = this.ctx.storage.sql
                .exec<EventRow>(
                    `SELECT version, event_id, event_type, entity_id, entity_version, event_timestamp, payload, action_id, action_index, action_size, actor
                 FROM log_events WHERE ${conditions.join(" AND ")} ORDER BY version DESC LIMIT ?`,
                    ...bindings,
                    limit + 1,
                )
                .toArray();
            const events = await this.hydrateEvents(id, rows.slice(0, limit).map(storedEvent));
            return rpcSuccess({
                events,
                headVersion: log.version,
                nextBeforeVersion:
                    rows.length > limit ? events.at(-1)!.version : null,
            });
        });
    }

    async createLog(
        access: AccessClaims,
        payload: CreateLogRequest,
    ): Promise<RpcResult<CreateLogResponse>> {
        return rpcCall(() => {
            const claims = this.writableAccess(access);
            return rpcSuccess(
                this.createLogValue(
                    decodeRpc(createLogBody, payload, "create log request"),
                    claims,
                ),
                201,
            );
        });
    }

    async forkLog(
        access: AccessClaims,
        sourceLogId: string,
        payload: ForkLogRequest,
    ): Promise<RpcResult<LogSummary>> {
        return rpcCall(() => {
            const claims = this.writableAccess(access);
            return rpcSuccess(this.forkLogValue(
                parseUuid(sourceLogId, 'source log id'),
                decodeRpc(forkLogBody, payload, 'fork log request'),
                claims,
            ), 201);
        });
    }

    async finalizeFork(access: AccessClaims, logId: string): Promise<RpcResult<LogSummary>> {
        return rpcCall(() => {
            const claims = this.writableAccess(access);
            const id = parseUuid(logId, 'fork log id');
            this.ctx.storage.transactionSync(() => {
                this.currentAccess(claims);
                const row = this.log(id);
                if (!row || !row.source_log_id) throw new LedgerError(404, {
                    error: 'fork not found', code: 'fork_not_found',
                });
                this.ctx.storage.sql.exec("UPDATE logs SET status = 'ready' WHERE id = ?", id);
            });
            return rpcSuccess(this.getLogValue(id));
        });
    }

    async getLog(
        access: AccessClaims,
        logId: string,
    ): Promise<RpcResult<LogSummary>> {
        return rpcCall(() => {
            this.currentAccess(access);
            return rpcSuccess(this.getLogValue(parseUuid(logId, "logId")));
        });
    }

    async getGalleryPhotoReference(
        access: AccessClaims,
        logId: string,
        photoId: string,
        fileVersionId: string,
    ): Promise<RpcResult<{ present: boolean }>> {
        return rpcCall(() => {
            this.currentAccess(access);
            const id = parseUuid(logId, 'log id');
            const photo = parseUuid(photoId, 'gallery photo id');
            const file = parseUuid(fileVersionId, 'gallery file version id');
            const log = this.log(id);
            if (!log) throw new LedgerError(404, { error: 'log not found', code: 'log_not_found' });
            if (log.status !== 'ready') throw new LedgerError(409, {
                error: 'Fork preparing', code: 'fork_preparing',
            });
            const present = this.ctx.storage.sql.exec(
                `SELECT 1 FROM gallery_photo_references
                 WHERE log_id = ? AND photo_id = ? AND file_version_id = ? LIMIT 1`,
                id, photo, file,
            ).toArray().length > 0;
            return rpcSuccess({ present });
        });
    }

    async setLogVisibility(
        access: AccessClaims,
        logId: string,
        payload: LogVisibilityRequest,
    ): Promise<RpcResult<LogSummary>> {
        return rpcCall(() => {
            const claims = this.writableAccess(access);
            const id = parseUuid(logId, "logId");
            const { hidden } = decodeRpc(logVisibilityBody, payload, "log visibility request");
            this.ctx.storage.transactionSync(() => {
                this.currentAccess(claims);
                if (!this.log(id)) throw new LedgerError(404, { error: "log not found", code: "log_not_found" });
                // Hiding again keeps the first time, so retries do not move it.
                this.ctx.storage.sql.exec(
                    "UPDATE logs SET hidden_at = CASE WHEN ? THEN COALESCE(hidden_at, ?) ELSE NULL END WHERE id = ?",
                    hidden ? 1 : 0, new Date().toISOString(), id,
                );
            });
            return rpcSuccess(this.getLogValue(id));
        });
    }

    async deleteLog(
        access: AccessClaims,
        logId: string,
    ): Promise<RpcResult<null>> {
        return rpcCall(async () => {
            const claims = this.writableAccess(access);
            this.deleteLogValue(parseUuid(logId, "logId"), claims);
            await this.ctx.storage.setAlarm(Date.now() + 1000);
            return rpcSuccess(null, 204);
        });
    }

    async listEvents(
        access: AccessClaims,
        logId: string,
        afterVersion: number | undefined,
        limit: number | undefined,
        replayVersion = 0,
    ): Promise<RpcResult<EventBatchResponse>> {
        return rpcCall(async () => {
            this.currentAccess(access);
            const id = parseUuid(logId, "logId");
            this.assertReplayCompatible(id, replayVersion);
            const batch = this.getEventsValue(id, afterVersion, limit);
            const events = await this.hydrateEvents(id, batch.events);
            this.currentAccess(access);
            return rpcSuccess({ events });
        });
    }

    async appendEvents(
        access: AccessClaims,
        logId: string,
        payload: AppendEventsRequest,
        replayVersion = 0,
        actor: string | null = null,
    ): Promise<RpcResult<AppendEventsResponse>> {
        return rpcCall(async () => {
            const claims = this.writableAccess(access);
            return rpcSuccess(
                await this.append(
                    parseUuid(logId, "logId"),
                    decodeRpc(
                        appendEventsBody,
                        payload,
                        "append events request",
                    ),
                    claims,
                    replayVersion,
                    normalizeActor(actor),
                ),
            );
        });
    }

    async initializeApplication(
        payload: InitializeRequest,
    ): Promise<RpcResult<null>> {
        return rpcCall(() => {
            const parsed = parseInitializeRequest(payload);
            if (this.metadataOptional() === undefined) {
                this.ctx.storage.sql.exec(
                    `INSERT INTO app_metadata (
                        singleton, app_id, name, principal_id,
                        principal_generation, created_at, token_created_at, event_policy, import_state
                     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    parsed.appId,
                    parsed.name,
                    parsed.principalId,
                    parsed.generation,
                    parsed.createdAt,
                    parsed.createdAt,
                    parsed.eventPolicy ?? null,
                    parsed.importing ? "importing" : null,
                );
            }
            return rpcSuccess(null, 204);
        });
    }

    /** The application's history as NDJSON records, with everything an identity-preserving import needs. */
    async administratorTransferExport(appId: string): Promise<Response> {
        try {
            this.administratorApplication(appId);
            // A fork still copying its files has no complete history to move.
            const preparing = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM logs WHERE status != 'ready'").toArray();
            if (preparing.length) {
                throw transferError("fork_preparing", `Log ${preparing[0]!.id} is still preparing; finish or wait for it before exporting`);
            }
        } catch (cause) {
            if (cause instanceof LedgerError) return errorResponse(cause);
            throw cause;
        }
        return new Response(byteStream(this.transferChunks(appId)), {
            headers: {
                "Cache-Control": "no-store",
                "Content-Type": "application/x-ndjson; charset=utf-8",
                "X-Content-Type-Options": "nosniff",
            },
        });
    }

    /** One digest per log over its events, for comparing a source and its imported copy. */
    async administratorChecksums(appId: string): Promise<RpcResult<{ logs: LogChecksum[] }>> {
        try {
            this.administratorApplication(appId);
            const logs: LogChecksum[] = [];
            for (const log of this.ctx.storage.sql.exec<{ id: string; version: number }>("SELECT id, version FROM logs ORDER BY id").toArray()) {
                let digest = "";
                let count = 0;
                let after = 0;
                for (;;) {
                    const rows = this.ctx.storage.sql.exec<EventRow>(
                        `SELECT version, event_id, event_type, entity_id, entity_version, event_timestamp, payload,
                                action_id, action_index, action_size, actor
                         FROM log_events WHERE log_id = ? AND version > ? ORDER BY version LIMIT ?`,
                        log.id, after, TRANSFER_PAGE,
                    ).toArray();
                    if (rows.length === 0) break;
                    const hydrated = await this.hydrateEvents(log.id, rows.map(storedEvent));
                    digest = await chainChecksum(digest, rows.map((row, index) => checksumLine({ ...row, payload: JSON.stringify(hydrated[index]!.payload) })));
                    count += rows.length;
                    after = rows[rows.length - 1]!.version;
                }
                logs.push({ id: log.id, headVersion: log.version, eventCount: count, sha256: digest });
            }
            return rpcSuccess({ logs });
        } catch (cause) {
            if (cause instanceof LedgerError) return { ok: false, status: cause.status, body: cause.body };
            throw cause;
        }
    }

    /** Applies one chunk of an identity-preserving import; the application must still be empty and importing. */
    async importRecords(appId: string, records: unknown): Promise<RpcResult<TransferTotals>> {
        return rpcCall(() => {
            this.administratorApplication(appId);
            if (this.importState() !== "importing") {
                throw transferError("not_importing", "This application is not accepting an import");
            }
            const parsed = parseTransferRecords(records);
            const totals: TransferTotals = { logs: 0, events: 0, requests: 0 };
            this.ctx.storage.transactionSync(() => {
                for (const record of parsed) this.importRecord(record, totals);
            });
            return rpcSuccess(totals);
        });
    }

    /** Empties an application whose import failed, so the import can start again. Refused once it has finished. */
    async abortImport(appId: string): Promise<RpcResult<null>> {
        return rpcCall(() => {
            this.administratorApplication(appId);
            if (this.importState() !== "importing") {
                throw transferError("not_importing", "Only an import in progress can be aborted");
            }
            this.ctx.storage.transactionSync(() => {
                for (const table of ["log_storage", "log_archive_pages", "log_maintenance_jobs", "gallery_photo_references", "log_fork_requests", "append_requests", "entity_claims", "log_events", "logs", "app_metadata"]) {
                    this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
                }
            });
            return rpcSuccess(null, 204);
        });
    }

    /** Checks the imported history against what the source said it held, then opens the application. */
    async finishImport(appId: string, expected: { logs: Array<{ id: string; headVersion: number }> }): Promise<RpcResult<{ logs: number; events: number }>> {
        return rpcCall(() => {
            this.administratorApplication(appId);
            if (this.importState() !== "importing") {
                throw transferError("not_importing", "This application is not accepting an import");
            }
            const actual = this.ctx.storage.sql.exec<{ id: string; version: number; events: number }>(
                `SELECT logs.id AS id, logs.version AS version,
                        (SELECT COUNT(*) FROM log_events WHERE log_id = logs.id) AS events
                 FROM logs ORDER BY logs.id`,
            ).toArray();
            const wanted = new Map(expected.logs.map((log) => [log.id.toLowerCase(), log.headVersion]));
            if (wanted.size !== actual.length) {
                throw transferError("import_incomplete", `Expected ${wanted.size} logs, found ${actual.length}`);
            }
            let events = 0;
            for (const log of actual) {
                const head = wanted.get(log.id);
                if (head === undefined) throw transferError("import_incomplete", `Log ${log.id} was not expected`);
                if (log.version !== head || log.events !== head) {
                    throw transferError("import_incomplete", `Log ${log.id} holds ${log.events} events at version ${log.version}; expected ${head}`);
                }
                events += log.events;
            }
            this.ctx.storage.sql.exec("UPDATE app_metadata SET import_state = NULL WHERE singleton = 1");
            return rpcSuccess({ logs: actual.length, events });
        });
    }

    /** Sets or lifts the write fence. Reads stay open; see fence.ts. */
    async setFence(request: FenceRequest): Promise<RpcResult<{ fence: Fence | null }>> {
        return rpcCall(() => {
            this.metadata();
            const fence = validateFenceRequest(request);
            this.ctx.storage.sql.exec(
                "UPDATE app_metadata SET fence_mode = ?, fence_destination = ? WHERE singleton = 1",
                fence?.mode ?? null,
                fence?.destination ?? null,
            );
            // A paused or moved workspace should not keep serving live batches as if nothing changed.
            if (fence) this.closeAllSockets(1013, fence.mode);
            return rpcSuccess({ fence });
        });
    }

    async getFence(): Promise<RpcResult<{ fence: Fence | null }>> {
        return rpcCall(() => {
            this.metadata();
            return rpcSuccess({ fence: this.fence() });
        });
    }

    /** Replaces the application's event policy; appends already accepted are never re-judged. */
    async setEventPolicy(policy: EventPolicy): Promise<RpcResult<EventPolicy>> {
        return rpcCall(() => {
            this.metadata();
            this.ctx.storage.sql.exec(
                "UPDATE app_metadata SET event_policy = ? WHERE singleton = 1",
                JSON.stringify(policy),
            );
            return rpcSuccess(policy);
        });
    }

    /** The application's event policy; null for an application that predates policies. */
    async getEventPolicy(): Promise<RpcResult<{ policy: EventPolicy | null }>> {
        return rpcCall(() => {
            this.metadata();
            return rpcSuccess({ policy: this.eventPolicy() });
        });
    }

    async rotateApplicationPrincipal(
        payload: RotateRequest,
    ): Promise<RpcResult<null>> {
        return rpcCall(() => {
            const parsed = parseRotateRequest(payload);
            // Generations only move forward, so a delayed or concurrent
            // rotation can never replace a newer principal.
            const rotated = this.ctx.storage.sql.exec(
                `UPDATE app_metadata
                 SET principal_id = ?, principal_generation = ?, token_created_at = ?
                 WHERE singleton = 1 AND revoked_at IS NULL
                   AND principal_generation < ?
                 RETURNING singleton`,
                parsed.principalId,
                parsed.generation,
                parsed.createdAt,
                parsed.generation,
            ).toArray();
            if (rotated.length === 0) {
                throw new LedgerError(409, {
                    error: "principal was already rotated or revoked",
                    code: "rotation_superseded",
                });
            }
            this.closeAllSockets(1008, "principal_rotated");
            return rpcSuccess(null, 204);
        });
    }

    async revokeApplicationState(
        payload: RevokeRequest,
    ): Promise<RpcResult<null>> {
        return rpcCall(() => {
            const parsed = parseRevokeRequest(payload);
            this.ctx.storage.sql.exec(
                "UPDATE app_metadata SET revoked_at = ? WHERE singleton = 1",
                parsed.revokedAt,
            );
            this.closeAllSockets(1008, "application_revoked");
            return rpcSuccess(null, 204);
        });
    }

    private currentAccess(value: AccessClaims): AccessClaims {
        const access = parseAccessClaims(value);
        const metadata = this.metadata();
        if (
            metadata.revoked_at !== null ||
            access.appId !== metadata.app_id ||
            access.principalId !== metadata.principal_id ||
            access.generation !== metadata.principal_generation
        ) {
            throw new LedgerError(401, {
                error: "access token has been rotated or revoked",
                code: "unauthorized",
            });
        }
        return access;
    }

    private administratorApplication(appId: string): void {
        const parsed = parseUuid(appId, "application id");
        if (this.metadata().app_id !== parsed) {
            throw new LedgerError(404, {
                error: "application not found",
                code: "not_found",
            });
        }
    }

    private listLogsValue() {
        const logs = this.logRows().map(logSummary);
        const logIds = new Set(logs.map(log => log.id));
        const rootIds: string[] = [];
        const childIdsByLogId: Record<string, string[]> = Object.fromEntries(
            logs.map(log => [log.id, []]),
        );
        for (const log of logs) {
            if (log.sourceLogId && logIds.has(log.sourceLogId)) {
                (childIdsByLogId[log.sourceLogId] ??= []).push(log.id);
            } else {
                rootIds.push(log.id);
            }
        }
        return { logs, lineage: { rootIds, childIdsByLogId } };
    }

    private logRows(): LogRow[] {
        return this.ctx.storage.sql
            .exec<LogRow>(
                `SELECT child.id, child.name, child.version, child.created_at, child.last_updated_at,
                        child.source_log_id, parent.name AS source_log_name, child.source_version,
                        (SELECT event_timestamp FROM log_events
                         WHERE log_id = child.source_log_id AND version = child.source_version) AS source_timestamp,
                        child.status, child.hidden_at
                 FROM logs AS child LEFT JOIN logs AS parent ON parent.id = child.source_log_id
                 ORDER BY child.created_at`,
            )
            .toArray();
    }

    private createLogValue(
        payload: CreateLogRequest,
        access: AccessClaims,
    ): CreateLogResponse {
        const requestedName = payload.name ?? undefined;
        if (requestedName !== undefined && requestedName.trim() === "") {
            throw validationError("name must not be empty");
        }
        const id = crypto.randomUUID();
        const name = requestedName ?? `log-${id.replaceAll("-", "")}`;
        const createdAt = new Date().toISOString();
        this.ctx.storage.transactionSync(() => {
            this.currentAccess(access);
            this.ctx.storage.sql.exec(
                "INSERT INTO logs (id, name, created_at) VALUES (?, ?, ?)",
                id,
                name,
                createdAt,
            );
        });
        return { id, name, headVersion: 0, createdAt };
    }

    private forkLogValue(sourceLogId: string, payload: ForkLogRequest, access: AccessClaims): LogSummary {
        const name = payload.name.trim();
        if (!name) throw validationError('name must not be empty');
        const { targetVersion, expectedSourceHeadVersion, requestId } = payload;
        const forkId = this.ctx.storage.transactionSync(() => {
            this.currentAccess(access);
            const prior = this.ctx.storage.sql.exec<{
                source_log_id: string; target_version: number; expected_source_head_version: number;
                name: string; fork_log_id: string;
            }>('SELECT * FROM log_fork_requests WHERE request_id = ?', requestId).toArray()[0];
            if (prior) {
                if (prior.source_log_id !== sourceLogId || prior.target_version !== targetVersion
                    || prior.expected_source_head_version !== expectedSourceHeadVersion || prior.name !== name) {
                    throw new LedgerError(409, { error: 'Conflict', code: 'idempotency_mismatch' });
                }
                return prior.fork_log_id;
            }
            const source = this.log(sourceLogId);
            if (!source || source.status !== 'ready') throw new LedgerError(404, {
                error: 'source log not found', code: 'log_not_found',
            });
            if (source.version !== expectedSourceHeadVersion) throw new LedgerError(409, {
                error: 'Conflict', code: 'stale_fork_preview', message: 'The source log changed. Review this point again.',
            });
            if (targetVersion > source.version) throw validationError('Fork point exceeds the source head');
            if (targetVersion > 0) {
                const boundary = this.ctx.storage.sql.exec<{
                    action_id: string | null; action_index: number | null; action_size: number | null;
                }>('SELECT action_id, action_index, action_size FROM log_events WHERE log_id = ? AND version = ?',
                    sourceLogId, targetVersion).toArray()[0];
                if (!boundary || (boundary.action_id !== null && boundary.action_index !== boundary.action_size! - 1)) {
                    throw validationError('Fork point must end a complete accepted action');
                }
            }
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            this.ctx.storage.sql.exec(
                `INSERT INTO logs (id, name, version, created_at, last_updated_at, source_log_id, source_version, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing')`,
                id, name, targetVersion, now, now, sourceLogId, targetVersion,
            );
            this.ctx.storage.sql.exec(
                `INSERT INTO log_events (log_id, version, event_id, event_type, entity_id, entity_version,
                    event_timestamp, payload, action_id, action_index, action_size, actor, archive_key, payload_bytes)
                 SELECT ?, version, event_id, event_type, entity_id, entity_version,
                    event_timestamp, payload, action_id, action_index, action_size, actor, archive_key, payload_bytes
                 FROM log_events WHERE log_id = ? AND version <= ? ORDER BY version`,
                id, sourceLogId, targetVersion,
            );
            this.ctx.storage.sql.exec(
                `INSERT INTO entity_claims (log_id, entity_id, current_version, version_created, created_at, updated_at)
                 SELECT ?, source.entity_id, source.entity_version, first_version.first_version, ?, ?
                 FROM log_events AS source
                 JOIN (SELECT entity_id, MAX(version) AS last_version, MIN(version) AS first_version
                       FROM log_events WHERE log_id = ? AND version <= ? GROUP BY entity_id) AS first_version
                   ON first_version.entity_id = source.entity_id AND first_version.last_version = source.version
                 WHERE source.log_id = ?`,
                id, now, now, sourceLogId, targetVersion, sourceLogId,
            );
            this.ctx.storage.sql.exec(
                `INSERT INTO gallery_photo_references (log_id, photo_id, file_version_id, source_version)
                 SELECT ?, photo_id, file_version_id, source_version
                 FROM gallery_photo_references WHERE log_id = ? AND source_version <= ?`,
                id, sourceLogId, targetVersion,
            );
            this.ctx.storage.sql.exec(
                `INSERT INTO log_fork_requests (request_id, source_log_id, target_version,
                    expected_source_head_version, name, fork_log_id) VALUES (?, ?, ?, ?, ?, ?)`,
                requestId, sourceLogId, targetVersion, expectedSourceHeadVersion, name, id,
            );
            return id;
        });
        return this.getLogValue(forkId);
    }

    private getLogValue(logId: string): LogSummary {
        const row = this.log(logId);
        if (!row) {
            throw new LedgerError(404, {
                error: "log not found",
                code: "log_not_found",
            });
        }
        return logSummary(row);
    }

    private deleteLogValue(logId: string, access: AccessClaims): void {
        if (!this.log(logId)) {
            throw new LedgerError(404, {
                error: "log not found",
                code: "log_not_found",
            });
        }
        this.ctx.storage.transactionSync(() => {
            this.currentAccess(access);
            if (this.ctx.storage.sql.exec("SELECT 1 FROM log_maintenance_jobs WHERE log_id = ? AND status NOT IN ('complete', 'failed') LIMIT 1", logId).toArray().length) {
                throw new LedgerError(409, { error: 'Conflict', code: 'maintenance_in_progress', message: 'Finish log maintenance before deleting this log.' });
            }
            if (this.ctx.storage.sql.exec('SELECT 1 FROM logs WHERE source_log_id = ? LIMIT 1', logId).toArray().length) {
                throw new LedgerError(409, { error: 'Conflict', code: 'log_has_forks',
                    message: 'Remove descendant logs before deleting their source.' });
            }
            if (this.ctx.storage.sql.exec(`SELECT 1 FROM log_events WHERE log_id != ? AND archive_key IN
                (SELECT object_key FROM log_archive_pages WHERE log_id = ?) LIMIT 1`, logId, logId).toArray().length) {
                throw new LedgerError(409, { error: 'Conflict', code: 'log_has_archive_dependents',
                    message: 'Other logs still depend on this archived history.' });
            }
            for (const query of [
                "DELETE FROM log_checkpoint_entities WHERE job_id IN (SELECT id FROM log_maintenance_jobs WHERE log_id = ?)",
                "DELETE FROM log_fork_requests WHERE fork_log_id = ?",
                "DELETE FROM append_requests WHERE log_id = ?",
                "DELETE FROM log_storage WHERE log_id = ?",
                "DELETE FROM log_archive_pages WHERE log_id = ?",
                "DELETE FROM log_maintenance_jobs WHERE log_id = ?",
                "DELETE FROM gallery_photo_references WHERE log_id = ?",
                "DELETE FROM entity_claims WHERE log_id = ?",
                "DELETE FROM log_events WHERE log_id = ?",
                "DELETE FROM logs WHERE id = ?",
            ]) {
                this.ctx.storage.sql.exec(query, logId);
            }
            this.ctx.storage.sql.exec('INSERT OR IGNORE INTO log_archive_deletions (log_id) VALUES (?)', logId);
        });
        this.closeLogSockets(logId, 1008, "log_deleted");
    }

    private getEventsValue(
        logId: string,
        afterVersion: number | undefined,
        limit: number | undefined,
    ): { events: StoredEvent[] } {
        const log = this.log(logId);
        if (!log) {
            throw new LedgerError(404, {
                error: "log not found",
                code: "log_not_found",
            });
        }
        if (log.status !== 'ready') throw new LedgerError(409, {
            error: 'Fork preparing', code: 'fork_preparing',
        });
        return {
            events: this.eventsAfter(
                logId,
                Math.max(0, afterVersion ?? 0),
                clamp(limit ?? MAX_CATCH_UP, 1, MAX_CATCH_UP),
            ),
        };
    }

    private async append(
        logId: string,
        request: AppendEventsRequest,
        access: AccessClaims,
        replayVersion: number,
        actor: string | null,
    ): Promise<AppendEventsResponse> {
        if (request.events.length === 0) {
            throw validationError("events must not be empty");
        }
        validateIncomingEvents(request.events);
        const requestHash = await hashAppendRequest(logId, request);

        // The original response may now live in R2. Resolve it before entering
        // the synchronous append transaction; accepted requests never append twice.
        const receipt = this.ctx.storage.sql.exec<{ request_hash: string; first_version: number | null; last_version: number | null }>(
            'SELECT request_hash, first_version, last_version FROM append_requests WHERE log_id = ? AND request_id = ?', logId, request.requestId).toArray()[0];
        if (receipt && receipt.first_version !== null && receipt.last_version !== null) {
            if (receipt.request_hash !== requestHash) throw new LedgerError(409, { error: 'Conflict', code: 'idempotency_mismatch' });
            const result = this.replayedAppend(logId, receipt.first_version, receipt.last_version);
            result.events = await this.hydrateEvents(logId, result.events);
            this.currentAccess(access);
            return result;
        }

        const response = this.ctx.storage.transactionSync(() => {
            this.currentAccess(access);
            this.assertReplayCompatible(logId, replayVersion);
            if (request.events.some(event => event.type === "WORKSPACE_RESTORED") && replayVersion < 1) {
                throw validationError("Restore requires replay version 1");
            }
            if (request.events.some(event => event.type === "EVENTS_EXCISED") && replayVersion < 2) {
                throw validationError("Removing events requires replay version 2");
            }
            return this.appendTransaction(logId, request, requestHash, actor);
        });
        // The append is committed. Realtime delivery is best effort: sockets
        // recover through HTTP replay, and a delivery fault must never turn an
        // accepted append into an error response.
        try {
            this.deliver(logId);
        } catch (cause) {
            console.error(
                JSON.stringify({
                    message: "Ledger socket delivery failed",
                    error: normalizeError(cause).message,
                }),
            );
        }
        return response;
    }

    private assertReplayCompatible(logId: string, replayVersion: number): void {
        if (!Number.isSafeInteger(replayVersion) || replayVersion < 0) throw validationError("Invalid replay version");
        // The IN list must match log_events_replay_markers exactly so SQLite
        // reads only marker events instead of the whole log.
        const { required } = this.ctx.storage.sql.exec<{ required: number | null }>(
            `SELECT MAX(CASE event_type WHEN 'EVENTS_EXCISED' THEN 2 ELSE 1 END) AS required
             FROM log_events
             WHERE log_id = ? AND event_type IN ('WORKSPACE_RESTORED', 'EVENTS_EXCISED')`,
            logId,
        ).one();
        if (required === null || replayVersion >= required) return;
        throw new LedgerError(409, { error: "UpgradeRequired", code: "client_upgrade_required",
            message: required === 2
                ? "Update this app to read or edit a log with removed events."
                : "Update this app to read or edit a restored log." });
    }

    private appendTransaction(
        logId: string,
        request: AppendEventsRequest,
        requestHash: string,
        actor: string | null,
    ): AppendEventsResponse {
        const log = this.log(logId);
        if (!log) {
            throw new LedgerError(404, {
                error: "NotFound",
                code: "log_not_found",
            });
        }
        if (log.status !== 'ready') throw new LedgerError(409, {
            error: 'Fork preparing', code: 'fork_preparing',
        });

        const replay = this.ctx.storage.sql
            .exec<{ request_hash: string; result: string; first_version: number | null; last_version: number | null }>(
                `SELECT request_hash, result, first_version, last_version FROM append_requests
                 WHERE request_id = ? AND log_id = ?`,
                request.requestId,
                logId,
            )
            .toArray()[0];
        if (replay) {
            if (replay.request_hash !== requestHash) {
                throw new LedgerError(409, {
                    error: "Conflict",
                    code: "idempotency_mismatch",
                    message:
                        "requestId was already used with different request content",
                });
            }
            if (replay.first_version !== null && replay.last_version !== null) {
                return this.replayedAppend(logId, replay.first_version, replay.last_version);
            }
            return parseStoredAppendEventsResponse(JSON.parse(replay.result));
        }

        // After the replay check, so an accepted request always replays even
        // when the rules have tightened since.
        this.checkEventPayloads(request);

        if (request.expectedLogVersion !== undefined && request.expectedLogVersion !== log.version) {
            throw new LedgerError(409, { error: "Conflict", code: "stale_restore_preview",
                message: "The log changed. Preview the restore again." });
        }
        const restore = request.events.find(event => event.type === "WORKSPACE_RESTORED");
        if (restore) {
            const target = restore.payload.targetVersion;
            if (request.events.length !== 1 || !request.actionId || request.expectedLogVersion === undefined
                || typeof target !== "number" || !Number.isSafeInteger(target) || target < 0 || target > log.version) {
                throw validationError("Restore requires one complete action, an expected head and a valid target");
            }
            if (target > 0) {
                const boundary = this.ctx.storage.sql.exec<{ action_id: string | null; action_index: number | null; action_size: number | null }>(
                    'SELECT action_id,action_index,action_size FROM log_events WHERE log_id = ? AND version = ?', logId, target,
                ).toArray()[0];
                if (!boundary || (boundary.action_id !== null && boundary.action_index !== boundary.action_size! - 1)) {
                    throw validationError("Restore target must be a complete accepted action");
                }
            }
        }

        if (request.actionId && this.ctx.storage.sql.exec(
            'SELECT 1 FROM log_events WHERE log_id = ? AND action_id = ? LIMIT 1',
            logId, request.actionId,
        ).toArray().length) {
            throw new LedgerError(409, { error: "Conflict", code: "action_already_accepted" });
        }

        const suppliedEventIds = request.events.flatMap((event) => event.id ? [event.id] : []);
        const accepted = suppliedEventIds.length === 0 ? undefined : this.ctx.storage.sql.exec<{ event_id: string }>(
            `SELECT event_id FROM log_events
             WHERE log_id = ? AND event_id IN (SELECT value FROM json_each(?))
             LIMIT 1`,
            logId, JSON.stringify(suppliedEventIds),
        ).toArray()[0];
        if (accepted) {
            throw new LedgerError(409, {
                error: "Conflict",
                code: "event_already_accepted",
                message: "An event with this id was already accepted by another request",
                eventId: accepted.event_id,
            });
        }

        const byEntity = new Map<string, typeof request.events>();
        for (const event of request.events) {
            const entityId = event.entityId.trim();
            const events = byEntity.get(entityId) ?? [];
            events.push(event);
            byEntity.set(entityId, events);
        }

        const entityVersions = new Map<string, number>();
        for (const [entityId, events] of byEntity) {
            const row = this.ctx.storage.sql
                .exec<{ version: number }>(
                    `SELECT current_version AS version FROM entity_claims
                     WHERE log_id = ? AND entity_id = ?`,
                    logId,
                    entityId,
                )
                .toArray()[0];
            validateEntityChain(entityId, events, row?.version, log.version);
            if (row) entityVersions.set(entityId, row.version);
        }

        let logVersion = log.version;
        const stored: StoredEvent[] = [];
        for (const incoming of request.events) {
            const entityId = incoming.entityId.trim();
            const entityVersion = (entityVersions.get(entityId) ?? 0) + 1;
            entityVersions.set(entityId, entityVersion);
            logVersion += 1;
            const event = buildStoredEvent(incoming, logVersion, entityVersion);
            if (request.actionId) event.action = {
                id: request.actionId, index: stored.length, size: request.events.length,
            };
            if (actor) event.actor = actor;
            stored.push(event);
        }

        // The idempotency record stores the whole response in one SQLite row.
        // Reject what can never fit instead of failing inside the transaction.
        const response = { newVersion: logVersion, events: stored };
        // The stored copy keeps the pre-authorship shape: a rolled-back Worker
        // validates it strictly, and replays read log_events anyway.
        const result = JSON.stringify({
            newVersion: logVersion,
            events: stored.map(({ actor: _actor, ...event }) => event),
        });
        if (new TextEncoder().encode(result).byteLength > MAX_APPEND_RESPONSE_BYTES) {
            throw new LedgerError(400, {
                error: "ValidationError",
                code: "request_too_large",
                message: `accepted events must serialize to at most ${MAX_APPEND_RESPONSE_BYTES} bytes`,
            });
        }

        for (const event of stored) {
            this.ctx.storage.sql.exec(
                `INSERT INTO log_events (
                    log_id, version, event_id, event_type, entity_id,
                    entity_version, event_timestamp, payload, action_id, action_index, action_size, actor
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                logId,
                event.version,
                event.id,
                event.type,
                event.entityId,
                event.entityVersion,
                new Date(event.timestamp).toISOString(),
                JSON.stringify(event.payload),
                event.action?.id ?? null,
                event.action?.index ?? null,
                event.action?.size ?? null,
                event.actor ?? null,
            );
            const now = new Date().toISOString();
            this.ctx.storage.sql.exec(
                `INSERT INTO entity_claims (
                    log_id, entity_id, current_version, version_created,
                    created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (log_id, entity_id) DO UPDATE SET
                    current_version = excluded.current_version,
                    updated_at = excluded.updated_at`,
                logId,
                event.entityId,
                event.entityVersion,
                event.version,
                now,
                now,
            );
            const reference = fileReference(event);
            if (reference) {
                this.ctx.storage.sql.exec(
                    `INSERT INTO gallery_photo_references
                        (log_id, photo_id, file_version_id, source_version)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT (log_id, photo_id, file_version_id) DO NOTHING`,
                    logId,
                    reference.ownerId,
                    reference.fileVersionId,
                    event.version,
                );
            }
        }

        this.ctx.storage.sql.exec(
            "UPDATE logs SET version = ?, last_updated_at = ? WHERE id = ?",
            logVersion,
            new Date().toISOString(),
            logId,
        );
        this.ctx.storage.sql.exec(
            `INSERT INTO append_requests (
                request_id, log_id, request_hash, result, created_at,
                first_version, last_version
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            request.requestId,
            logId,
            requestHash,
            // Still written so a rolled-back Worker can replay this request;
            // replays read the version range.
            result,
            new Date().toISOString(),
            stored[0]!.version,
            logVersion,
        );
        return response;
    }

    private checkEventPayloads(request: AppendEventsRequest): void {
        const policy = this.eventPolicy();
        const violations = findPayloadViolations(request.events, 5, policy);
        if (violations.length === 0) return;
        const mode = effectiveValidationMode(policy, this.env.EVENT_VALIDATION);
        // Types, keys and rule names only: payload values are never logged.
        console.warn(JSON.stringify({ message: "Ledger event validation", mode, violations }));
        if (mode !== "enforce") return;
        const first = violations[0]!;
        throw new LedgerError(422, {
            error: "UnprocessableEntity",
            code: "invalid_event_payload",
            message: `event ${first.index + 1} (${first.type}): ${first.problem}`,
            eventIndex: first.index,
        });
    }

    /** Rebuild an accepted append's response from the events it stored. */
    private replayedAppend(logId: string, firstVersion: number, lastVersion: number): AppendEventsResponse {
        const events = this.eventsThrough(logId, firstVersion - 1, lastVersion, MAX_CATCH_UP);
        if (events.length !== lastVersion - firstVersion + 1 || events[0]?.version !== firstVersion) {
            throw new Error("invalid persisted idempotency response");
        }
        return { newVersion: lastVersion, events };
    }

    private upgradeSocket(
        request: Request,
        access: AccessClaims,
        logId: string,
        afterVersion: number,
    ): Response {
        const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
            .split(",")
            .map((value) => value.trim());
        if (!protocols.includes(SOCKET_PROTOCOL)) {
            return jsonError(
                "invalid_subprotocol",
                "ledger.v1 subprotocol required",
                400,
            );
        }
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
            return jsonError("upgrade_required", "WebSocket upgrade required", 426);
        }
        const claims = this.currentAccess(access);
        const log = this.log(logId);
        if (!log) {
            return jsonError("log_not_found", "log not found", 404);
        }
        if (log.status !== "ready") {
            return jsonError("fork_preparing", "Fork preparing", 409);
        }

        const replayVersion = parseNonnegativeInteger(Number(new URL(request.url).searchParams.get("replayVersion") ?? 0), "replayVersion");
        this.assertReplayCompatible(logId, replayVersion);
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        const attachment: SocketAttachment = {
            logId,
            replayVersion,
            cursor: afterVersion,
            principalId: claims.principalId,
            generation: claims.generation,
            connectionId: crypto.randomUUID(),
            connectedAt: new Date().toISOString(),
            client: {
                userAgent:
                    request.headers.get("User-Agent")?.slice(0, 512) ?? null,
                ip:
                    request.headers.get("CF-Connecting-IP")?.slice(0, 64) ??
                    null,
                country:
                    typeof request.cf?.country === "string"
                        ? request.cf.country.slice(0, 16)
                        : null,
                colo:
                    typeof request.cf?.colo === "string"
                        ? request.cf.colo.slice(0, 16)
                        : null,
            },
        };
        this.ctx.acceptWebSocket(server, [socketTag(logId)]);
        server.serializeAttachment(attachment);
        this.recordSocketSession(attachment);
        this.sendCatchUp(server, attachment, true);
        return new Response(null, {
            status: 101,
            webSocket: client,
            headers: { "Sec-WebSocket-Protocol": SOCKET_PROTOCOL },
        });
    }

    private sendCatchUp(
        ws: WebSocket,
        attachment: SocketAttachment,
        sendReady: boolean,
    ): void {
        try { this.assertReplayCompatible(attachment.logId, attachment.replayVersion ?? 0); }
        catch {
            this.sendFrame(ws, { type: "error", code: "client_upgrade_required" });
            ws.close(1008, "client upgrade required");
            return;
        }
        const head = this.logHead(attachment.logId);
        const archived = this.ctx.storage.sql.exec<{ version: number | null }>('SELECT MAX(version) AS version FROM log_events WHERE log_id = ? AND archive_key IS NOT NULL', attachment.logId).one().version ?? 0;
        if (attachment.cursor < archived) {
            this.sendFrame(ws, { type: 'resync_required', headVersion: head, reason: 'gap_too_large' });
            ws.close(1008, 'baseline resync required');
            return;
        }
        if (attachment.cursor > head) {
            this.sendFrame(ws, {
                type: "resync_required",
                headVersion: head,
                reason: "cursor_ahead",
            });
            ws.close(1008, "resync required");
            return;
        }
        if (head - attachment.cursor > MAX_CATCH_UP) {
            this.sendFrame(ws, {
                type: "resync_required",
                headVersion: head,
                reason: "gap_too_large",
            });
            ws.close(1008, "resync required");
            return;
        }
        for (const event of this.eventsAfter(
            attachment.logId,
            attachment.cursor,
            MAX_CATCH_UP,
        )) {
            this.sendFrame(ws, { type: "event", event });
            attachment.cursor = event.version;
            attachment.lastSentAt = new Date().toISOString();
            ws.serializeAttachment(attachment);
        }
        if (sendReady) {
            this.sendFrame(ws, { type: "ready", headVersion: head });
            attachment.lastSentAt = new Date().toISOString();
            ws.serializeAttachment(attachment);
        }
    }

    private deliver(logId: string): void {
        const metadata = this.metadata();
        for (const ws of this.ctx.getWebSockets(socketTag(logId))) {
            let attachment: SocketAttachment;
            try {
                attachment = parseSocketAttachment(ws.deserializeAttachment());
            } catch {
                ws.close(1011, "missing attachment");
                continue;
            }
            if (
                attachment.principalId !== metadata.principal_id ||
                attachment.generation !== metadata.principal_generation ||
                metadata.revoked_at !== null
            ) {
                ws.close(1008, "principal revoked");
                continue;
            }
            try {
                this.sendCatchUp(ws, attachment, false);
            } catch (cause) {
                console.error(
                    JSON.stringify({
                        message: "Ledger socket delivery failed",
                        error: normalizeError(cause).message,
                    }),
                );
                ws.close(1011, "delivery failure");
            }
        }
    }

    private sendFrame(ws: WebSocket, frame: SocketFrame): void {
        ws.send(JSON.stringify(frame));
    }

    private recordSocketSession(attachment: SocketAttachment): void {
        const sql = this.ctx.storage.sql;
        sql.exec(
            `INSERT INTO socket_sessions (
                connection_id, log_id, principal_id, principal_generation,
                connected_at, cursor, user_agent, ip, country, colo
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            attachment.connectionId!,
            attachment.logId,
            attachment.principalId,
            attachment.generation,
            attachment.connectedAt!,
            attachment.cursor,
            attachment.client?.userAgent ?? null,
            attachment.client?.ip ?? null,
            attachment.client?.country ?? null,
            attachment.client?.colo ?? null,
        );
        sql.exec(
            `DELETE FROM socket_sessions WHERE connection_id IN (
                SELECT connection_id FROM socket_sessions
                ORDER BY connected_at DESC, connection_id DESC
                LIMIT -1 OFFSET ?
            )`,
            RECENT_SOCKET_SESSIONS,
        );
    }

    private recordSocketDisconnect(ws: WebSocket, code: number | null): void {
        let attachment: SocketAttachment;
        try {
            attachment = parseSocketAttachment(ws.deserializeAttachment());
        } catch {
            return;
        }
        if (!attachment.connectionId) return;
        this.ctx.storage.sql.exec(
            `UPDATE socket_sessions
             SET disconnected_at = COALESCE(disconnected_at, ?),
                 close_code = COALESCE(close_code, ?),
                 cursor = ?,
                 last_sent_at = ?
             WHERE connection_id = ?`,
            new Date().toISOString(),
            code,
            attachment.cursor,
            attachment.lastSentAt ?? null,
            attachment.connectionId,
        );
    }

    private metadata(): MetadataRow {
        const row = this.metadataOptional();
        if (!row) throw new Error("application is not initialized");
        return row;
    }

    private fence(): Fence | null {
        const row = this.ctx.storage.sql
            .exec<{ fence_mode: string | null; fence_destination: string | null }>(
                "SELECT fence_mode, fence_destination FROM app_metadata WHERE singleton = 1",
            )
            .toArray()[0];
        return parseFence(row?.fence_mode, row?.fence_destination);
    }

    /** The claims, for a request that writes: refused while the application is fenced. */
    private writableAccess(access: AccessClaims): AccessClaims {
        const claims = this.currentAccess(access);
        const fence = this.fence();
        if (fence) throw fenceError(fence);
        return claims;
    }

    private importState(): string | null {
        return this.ctx.storage.sql
            .exec<{ import_state: string | null }>("SELECT import_state FROM app_metadata WHERE singleton = 1")
            .toArray()[0]?.import_state ?? null;
    }

    private importRecord(record: TransferRecord, totals: TransferTotals): void {
        const sql = this.ctx.storage.sql;
        const requireLog = (logId: string): { version: number } => {
            const log = sql.exec<{ version: number }>("SELECT version FROM logs WHERE id = ?", logId).toArray()[0];
            if (!log) throw transferError("import_order", `Log ${logId} must be imported before its events`);
            return log;
        };
        switch (record.t) {
            case "log": {
                if (sql.exec("SELECT 1 FROM logs WHERE id = ?", record.id).toArray().length) {
                    throw transferError("import_duplicate", `Log ${record.id} was already imported`);
                }
                // The version grows with the events; finishImport compares it with the source's head.
                sql.exec(
                    `INSERT INTO logs (id, name, version, created_at, last_updated_at, source_log_id, source_version, status, hidden_at)
                     VALUES (?, ?, 0, ?, ?, ?, ?, 'ready', ?)`,
                    record.id, record.name, record.createdAt, record.lastUpdatedAt ?? record.createdAt,
                    record.sourceLogId, record.sourceVersion, record.hiddenAt,
                );
                totals.logs += 1;
                return;
            }
            case "events": {
                let version = requireLog(record.logId).version;
                for (const event of record.events) {
                    version += 1;
                    if (event.version !== version) {
                        throw transferError("import_gap", `Log ${record.logId} expected version ${version}, got ${event.version}`);
                    }
                    const iso = new Date(event.timestamp).toISOString();
                    const claim = sql.exec<{ current_version: number }>(
                        "SELECT current_version FROM entity_claims WHERE log_id = ? AND entity_id = ?", record.logId, event.entityId,
                    ).toArray()[0];
                    if (event.entityVersion !== (claim?.current_version ?? 0) + 1) {
                        throw transferError("import_entity_chain", `Entity ${event.entityId} in log ${record.logId} jumps to version ${event.entityVersion}`);
                    }
                    sql.exec(
                        `INSERT INTO log_events (log_id, version, event_id, event_type, entity_id, entity_version,
                            event_timestamp, payload, action_id, action_index, action_size, actor)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        record.logId, event.version, event.id, event.type, event.entityId, event.entityVersion, iso,
                        JSON.stringify(event.payload), event.action?.id ?? null, event.action?.index ?? null,
                        event.action?.size ?? null, event.actor ?? null,
                    );
                    sql.exec(
                        `INSERT INTO entity_claims (log_id, entity_id, current_version, version_created, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?)
                         ON CONFLICT (log_id, entity_id) DO UPDATE SET current_version = excluded.current_version, updated_at = excluded.updated_at`,
                        record.logId, event.entityId, event.entityVersion, event.version, iso, iso,
                    );
                    const reference = fileReference(event);
                    if (reference) {
                        sql.exec(
                            `INSERT INTO gallery_photo_references (log_id, photo_id, file_version_id, source_version)
                             VALUES (?, ?, ?, ?) ON CONFLICT (log_id, photo_id, file_version_id) DO NOTHING`,
                            record.logId, reference.ownerId, reference.fileVersionId, event.version,
                        );
                    }
                }
                sql.exec("UPDATE logs SET version = ? WHERE id = ?", version, record.logId);
                totals.events += record.events.length;
                return;
            }
            case "requests": {
                const log = requireLog(record.logId);
                for (const request of record.requests) {
                    let result = request.result;
                    if (request.firstVersion !== null && request.lastVersion !== null) {
                        if (request.firstVersion < 1 || request.lastVersion < request.firstVersion || request.lastVersion > log.version) {
                            throw transferError("import_request_range", `Request ${request.requestId} names versions the log does not hold`);
                        }
                        // Replays read log_events; the stored copy keeps the shape a rolled-back Worker validates.
                        const events: StoredEvent[] = [];
                        for (let after = request.firstVersion - 1; after < request.lastVersion;) {
                            const page = this.eventsThrough(record.logId, after, request.lastVersion, MAX_CATCH_UP);
                            if (page.length === 0) throw transferError("import_request_range", `Request ${request.requestId} names missing events`);
                            events.push(...page);
                            after = page[page.length - 1]!.version;
                        }
                        result = JSON.stringify({ newVersion: request.lastVersion, events: events.map(({ actor: _actor, ...rest }) => rest) });
                    }
                    sql.exec(
                        `INSERT INTO append_requests (request_id, log_id, request_hash, result, created_at, first_version, last_version)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        request.requestId, record.logId, request.requestHash, result, request.createdAt, request.firstVersion, request.lastVersion,
                    );
                }
                totals.requests += record.requests.length;
                return;
            }
            case "forks": {
                for (const fork of record.requests) {
                    sql.exec(
                        `INSERT INTO log_fork_requests (request_id, source_log_id, target_version, expected_source_head_version, name, fork_log_id)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        fork.requestId, fork.sourceLogId, fork.targetVersion, fork.expectedSourceHeadVersion, fork.name, fork.forkLogId,
                    );
                }
                return;
            }
        }
    }

    private async *transferChunks(appId: string): AsyncGenerator<Uint8Array> {
        const encoder = new TextEncoder();
        const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
        const sql = this.ctx.storage.sql;
        const app = sql.exec<{ name: string; created_at: string; event_policy: string | null }>(
            "SELECT name, created_at, event_policy FROM app_metadata WHERE singleton = 1",
        ).toArray()[0]!;
        yield line({
            t: "app", format: TRANSFER_FORMAT, version: TRANSFER_VERSION, id: appId, name: app.name,
            createdAt: app.created_at, policy: parseEventPolicy(app.event_policy), exportedAt: new Date().toISOString(),
        });
        const totals: TransferTotals = { logs: 0, events: 0, requests: 0 };
        const logs = sql.exec<{
            id: string; name: string; version: number; created_at: string; last_updated_at: string | null;
            source_log_id: string | null; source_version: number | null; hidden_at: string | null;
        }>("SELECT id, name, version, created_at, last_updated_at, source_log_id, source_version, hidden_at FROM logs ORDER BY created_at, id").toArray();
        for (const log of logs) {
            yield line({
                t: "log", id: log.id, name: log.name, createdAt: log.created_at, lastUpdatedAt: log.last_updated_at,
                sourceLogId: log.source_log_id, sourceVersion: log.source_version, hiddenAt: log.hidden_at, headVersion: log.version,
            });
            totals.logs += 1;
            for (let after = 0; after < log.version;) {
                const events = await this.hydrateEvents(log.id, this.eventsThrough(log.id, after, log.version, TRANSFER_PAGE));
                if (events.length === 0) throw new Error(`log ${log.id} export stopped at version ${after}`);
                yield line({ t: "events", logId: log.id, events });
                after = events[events.length - 1]!.version;
                totals.events += events.length;
            }
            const requests = sql.exec<{
                request_id: string; request_hash: string; created_at: string; first_version: number | null;
                last_version: number | null; result: string;
            }>("SELECT request_id, request_hash, created_at, first_version, last_version, result FROM append_requests WHERE log_id = ? ORDER BY created_at, request_id", log.id).toArray();
            for (let at = 0; at < requests.length; at += 500) {
                yield line({
                    t: "requests", logId: log.id,
                    requests: requests.slice(at, at + 500).map((row) => ({
                        requestId: row.request_id, requestHash: row.request_hash, createdAt: row.created_at,
                        firstVersion: row.first_version, lastVersion: row.last_version,
                        // Only rows that predate version ranges need the stored response.
                        result: row.first_version === null ? row.result : null,
                    })),
                });
                totals.requests += Math.min(500, requests.length - at);
            }
        }
        const forks = sql.exec<{
            request_id: string; source_log_id: string; target_version: number; expected_source_head_version: number; name: string; fork_log_id: string;
        }>("SELECT request_id, source_log_id, target_version, expected_source_head_version, name, fork_log_id FROM log_fork_requests ORDER BY request_id").toArray();
        for (let at = 0; at < forks.length; at += 500) {
            yield line({
                t: "forks",
                requests: forks.slice(at, at + 500).map((row) => ({
                    requestId: row.request_id, sourceLogId: row.source_log_id, targetVersion: row.target_version,
                    expectedSourceHeadVersion: row.expected_source_head_version, name: row.name, forkLogId: row.fork_log_id,
                })),
            });
        }
        yield line({ t: "end", ...totals });
    }

    private eventPolicy(): EventPolicy | null {
        const row = this.ctx.storage.sql
            .exec<{ event_policy: string | null }>("SELECT event_policy FROM app_metadata WHERE singleton = 1")
            .toArray()[0];
        return parseEventPolicy(row?.event_policy);
    }

    private metadataOptional(): MetadataRow | undefined {
        return this.ctx.storage.sql
            .exec<MetadataRow>(
                `SELECT app_id, principal_id, principal_generation, revoked_at
                 FROM app_metadata WHERE singleton = 1`,
            )
            .toArray()[0];
    }

    private log(logId: string): LogRow | undefined {
        return this.ctx.storage.sql
            .exec<LogRow>(
                `SELECT child.id, child.name, child.version, child.created_at, child.last_updated_at,
                        child.source_log_id, parent.name AS source_log_name, child.source_version,
                        (SELECT event_timestamp FROM log_events
                         WHERE log_id = child.source_log_id AND version = child.source_version) AS source_timestamp,
                        child.status, child.hidden_at
                 FROM logs AS child LEFT JOIN logs AS parent ON parent.id = child.source_log_id
                 WHERE child.id = ?`,
                logId,
            )
            .toArray()[0];
    }

    private logHead(logId: string): number {
        const log = this.log(logId);
        if (!log) throw new Error("log not found");
        return log.version;
    }

    private async hydrateEvents(logId: string, events: StoredEvent[]): Promise<StoredEvent[]> {
        if (!events.length) return events;
        const ordered = [...events].sort((a, b) => a.version - b.version);
        const hydrated = await this.maintenance().hydrate(logId, ordered);
        const byId = new Map(hydrated.map(event => [event.id, event]));
        return events.map(event => ({ ...event, payload: byId.get(event.id)!.payload as StoredEvent['payload'] }));
    }

    private eventsAfter(
        logId: string,
        after: number,
        limit: number,
    ): StoredEvent[] {
        return this.ctx.storage.sql
            .exec<EventRow>(
                `SELECT version, event_id, event_type, entity_id, entity_version,
                        event_timestamp, payload, action_id, action_index, action_size, actor
                 FROM log_events
                 WHERE log_id = ? AND version > ?
                 ORDER BY version
                 LIMIT ?`,
                logId,
                Math.max(0, after),
                clamp(limit, 1, MAX_CATCH_UP),
            )
            .toArray()
            .map(storedEvent);
    }

    private eventsThrough(
        logId: string,
        after: number,
        through: number,
        limit: number,
    ): StoredEvent[] {
        return this.ctx.storage.sql
            .exec<EventRow>(
                `SELECT version, event_id, event_type, entity_id, entity_version,
                        event_timestamp, payload, action_id, action_index, action_size, actor
                 FROM log_events
                 WHERE log_id = ? AND version > ? AND version <= ?
                 ORDER BY version
                 LIMIT ?`,
                logId,
                Math.max(0, after),
                Math.max(0, through),
                clamp(limit, 1, MAX_CATCH_UP),
            )
            .toArray()
            .map(storedEvent);
    }

    private async *applicationExportChunks(
        application: ApplicationSummary,
        logs: LogSummary[],
        exportedAt: string,
    ): AsyncGenerator<Uint8Array> {
        const encoder = new TextEncoder();
        const encode = (value: string) => encoder.encode(value);
        yield encode(
            `{"format":${JSON.stringify(ADMIN_EXPORT_FORMAT)}` +
                `,"version":${ADMIN_EXPORT_VERSION}` +
                `,"exportedAt":${JSON.stringify(exportedAt)}` +
                `,"application":${JSON.stringify(application)}` +
                `,"logs":[`,
        );

        for (const [logIndex, log] of logs.entries()) {
            // The full log summary, including fork lineage, opens each log.
            const summary = JSON.stringify(log);
            yield encode(
                `${logIndex === 0 ? "" : ","}${summary.slice(0, -1)},"events":[`,
            );
            let cursor = 0;
            let firstEvent = true;
            while (cursor < log.headVersion) {
                const events = await this.hydrateEvents(log.id, this.eventsThrough(
                    log.id,
                    cursor,
                    log.headVersion,
                    MAX_CATCH_UP,
                ));
                if (events.length === 0) {
                    throw new Error(
                        `log ${log.id} export stopped at version ${cursor}`,
                    );
                }
                for (const event of events) {
                    if (event.version !== cursor + 1) {
                        throw new Error(
                            `log ${log.id} export is not contiguous at version ${cursor + 1}`,
                        );
                    }
                    yield encode(
                        `${firstEvent ? "" : ","}${JSON.stringify(event)}`,
                    );
                    firstEvent = false;
                    cursor = event.version;
                }
            }
            yield encode("]}");
        }
        yield encode("]}\n");
    }

    private closeAllSockets(code: number, reason: string): void {
        for (const ws of this.ctx.getWebSockets()) ws.close(code, reason);
    }

    private closeLogSockets(logId: string, code: number, reason: string): void {
        for (const ws of this.ctx.getWebSockets(socketTag(logId))) {
            ws.close(code, reason);
        }
    }
}

function storedEvent(row: EventRow): StoredEvent {
    const payload: unknown = JSON.parse(row.payload);
    if (
        payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload)
    ) {
        throw new Error("invalid stored event payload");
    }
    return {
        ...(row.action_id !== null ? { action: {
            id: row.action_id, index: row.action_index!, size: row.action_size!,
        } } : {}),
        version: row.version,
        id: parseUuid(row.event_id, "stored event id"),
        type: row.event_type,
        entityId: row.entity_id,
        entityVersion: row.entity_version,
        timestamp: Date.parse(row.event_timestamp),
        payload: payload as StoredEvent["payload"],
        // Omitted when unknown so events from before authorship export unchanged.
        ...(row.actor !== null ? { actor: row.actor } : {}),
    };
}

function logSummary(row: LogRow): {
    id: string;
    name: string;
    headVersion: number;
    createdAt: string;
    lastUpdatedAt: string | null;
    sourceLogId: string | null;
    sourceLogName: string | null;
    sourceVersion: number | null;
    sourceTimestamp: string | null;
    status: 'ready' | 'preparing';
    hiddenAt: string | null;
} {
    return {
        id: parseUuid(row.id, "stored log id"),
        name: row.name,
        headVersion: row.version,
        createdAt: row.created_at,
        lastUpdatedAt: row.last_updated_at,
        sourceLogId: row.source_log_id,
        sourceLogName: row.source_log_name,
        sourceVersion: row.source_version,
        sourceTimestamp: row.source_timestamp,
        status: row.status,
        hiddenAt: row.hidden_at,
    };
}

function byteStream(
    chunks: AsyncGenerator<Uint8Array>,
): ReadableStream<Uint8Array> {
    const source: UnderlyingByteSource = {
        type: "bytes",
        async pull(controller) {
            try {
                const next = await chunks.next();
                if (next.done) {
                    controller.close();
                } else {
                    controller.enqueue(next.value);
                }
            } catch (error) {
                controller.error(error);
            }
        },
        async cancel() {
            await chunks.return(undefined);
        },
    };
    return new ReadableStream(source);
}

function exportFilename(name: string, exportedAt: string): string {
    const safeName =
        name
            .normalize("NFKD")
            .replace(/[^a-zA-Z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 64) || "application";
    return `ledger-${safeName}-${exportedAt.slice(0, 10)}.json`;
}

function routeSegments(path: string): string[] {
    return path.split("/").filter(Boolean);
}

function internalSocketAccess(request: Request): AccessClaims {
    const value = request.headers.get(INTERNAL_SOCKET_ACCESS_HEADER);
    if (!value) {
        throw new LedgerError(401, {
            error: "invalid bearer token",
            code: "unauthorized",
        });
    }
    try {
        return parseAccessClaims(JSON.parse(value));
    } catch {
        throw new LedgerError(401, {
            error: "invalid bearer token",
            code: "unauthorized",
        });
    }
}

function socketTag(logId: string): string {
    return `log:${logId}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}
