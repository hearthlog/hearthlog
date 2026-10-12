import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";

import { validationError } from "./errors";
import {
    apiModels,
    type AppendEventsResponse,
    type StoredEvent,
} from "./schemas";

export interface AccessClaims {
    version: number;
    kind: "access";
    appId: string;
    principalId: string;
    generation: number;
    keyId: string;
}

export const INTERNAL_SOCKET_ACCESS_HEADER = "x-ledger-internal-access";

export interface SocketAttachment {
    replayVersion?: number;
    logId: string;
    cursor: number;
    principalId: string;
    generation: number;
    connectionId?: string;
    connectedAt?: string;
    lastSentAt?: string;
    client?: {
        userAgent: string | null;
        ip: string | null;
        country: string | null;
        colo: string | null;
    };
}

export type SocketFrame =
    | { type: "event"; event: StoredEvent }
    | { type: "ready"; headVersion: number }
    | {
          type: "resync_required";
          headVersion: number;
          reason: "gap_too_large" | "cursor_ahead";
      }
    | { type: "error"; code: string };

export interface InitializeRequest {
    appId: string;
    name: string;
    principalId: string;
    generation: number;
    createdAt: string;
    /** The application's event policy, as JSON; absent for none. */
    eventPolicy?: string;
    /** The application is being filled by an identity-preserving import and serves nobody yet. */
    importing?: boolean;
}

export interface RotateRequest {
    principalId: string;
    generation: number;
    createdAt: string;
}

export interface RevokeRequest {
    revokedAt: string;
}

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuid(value: unknown, label: string): string {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
        throw validationError(`${label} must be a UUID`);
    }
    return value.toLowerCase();
}

export function parseNonnegativeInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw validationError(`${label} must be a non-negative safe integer`);
    }
    return value as number;
}

export function parsePositiveInteger(value: unknown, label: string): number {
    const parsed = parseNonnegativeInteger(value, label);
    if (parsed < 1) throw validationError(`${label} must be positive`);
    return parsed;
}

export function parseIsoTimestamp(value: unknown, label: string): string {
    if (
        typeof value !== "string" ||
        value.trim() === "" ||
        !Number.isFinite(Date.parse(value))
    ) {
        throw validationError(`${label} must be an ISO-8601 timestamp`);
    }
    return value;
}

export function parseInitializeRequest(value: unknown): InitializeRequest {
    const record = strictRecord(
        value,
        ["appId", "name", "principalId", "generation", "createdAt", "eventPolicy", "importing"],
        "initialize request",
    );
    return {
        ...(typeof record.eventPolicy === "string" ? { eventPolicy: record.eventPolicy } : {}),
        ...(record.importing === true ? { importing: true } : {}),
        appId: parseUuid(record.appId, "appId"),
        name: requiredString(record.name, "name"),
        principalId: parseUuid(record.principalId, "principalId"),
        generation: parsePositiveInteger(record.generation, "generation"),
        createdAt: parseIsoTimestamp(record.createdAt, "createdAt"),
    };
}

export function parseRotateRequest(value: unknown): RotateRequest {
    const record = strictRecord(
        value,
        ["principalId", "generation", "createdAt"],
        "rotate request",
    );
    return {
        principalId: parseUuid(record.principalId, "principalId"),
        generation: parsePositiveInteger(record.generation, "generation"),
        createdAt: parseIsoTimestamp(record.createdAt, "createdAt"),
    };
}

export function parseRevokeRequest(value: unknown): RevokeRequest {
    const record = strictRecord(value, ["revokedAt"], "revoke request");
    return {
        revokedAt: parseIsoTimestamp(record.revokedAt, "revokedAt"),
    };
}

export function parseAccessClaims(value: unknown): AccessClaims {
    const record = recordValue(value, "access token claims");
    if (record.version !== 1 || record.kind !== "access") {
        throw validationError("invalid access token claims");
    }
    return {
        version: 1,
        kind: "access",
        appId: parseUuid(record.appId, "appId"),
        principalId: parseUuid(record.principalId, "principalId"),
        generation: parsePositiveInteger(record.generation, "generation"),
        keyId: requiredString(record.keyId, "keyId"),
    };
}

export function parseSocketAttachment(value: unknown): SocketAttachment {
    const record = recordValue(value, "socket attachment");
    return {
        logId: parseUuid(record.logId, "logId"),
        ...(record.replayVersion === undefined ? {} : { replayVersion: parseNonnegativeInteger(record.replayVersion, "replayVersion") }),
        cursor: parseNonnegativeInteger(record.cursor, "cursor"),
        principalId: parseUuid(record.principalId, "principalId"),
        generation: parsePositiveInteger(record.generation, "generation"),
        ...(record.connectionId === undefined
            ? {}
            : { connectionId: parseUuid(record.connectionId, "connectionId") }),
        ...(record.connectedAt === undefined
            ? {}
            : {
                  connectedAt: parseIsoTimestamp(
                      record.connectedAt,
                      "connectedAt",
                  ),
              }),
        ...(record.lastSentAt === undefined
            ? {}
            : {
                  lastSentAt: parseIsoTimestamp(
                      record.lastSentAt,
                      "lastSentAt",
                  ),
              }),
        ...(record.client === undefined
            ? {}
            : { client: parseSocketClient(record.client) }),
    };
}

function parseSocketClient(
    value: unknown,
): NonNullable<SocketAttachment["client"]> {
    const record = recordValue(value, "socket client");
    const field = (name: string, limit: number) =>
        typeof record[name] === "string" ? record[name].slice(0, limit) : null;
    return {
        userAgent: field("userAgent", 512),
        ip: field("ip", 64),
        country: field("country", 16),
        colo: field("colo", 16),
    };
}

export function parseStoredAppendEventsResponse(
    value: unknown,
): AppendEventsResponse {
    if (!Value.Check(apiModels.AppendEventsResponse, value)) {
        throw new Error("invalid persisted idempotency response");
    }
    return value;
}

export function decodeRpc<T extends TSchema>(
    schema: T,
    value: unknown,
    label: string,
): Static<T> {
    if (!Value.Check(schema, value)) {
        throw validationError(`invalid ${label}`);
    }
    return value;
}

function strictRecord(
    value: unknown,
    fields: readonly string[],
    label: string,
): Record<string, unknown> {
    const record = recordValue(value, label);
    const allowed = new Set(fields);
    for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
            throw validationError(`${label} contains unknown field ${key}`);
        }
    }
    return record;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw validationError(`${label} must be a JSON object`);
    }
    return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
    if (typeof value !== "string") {
        throw validationError(`${label} must be a string`);
    }
    return value;
}
