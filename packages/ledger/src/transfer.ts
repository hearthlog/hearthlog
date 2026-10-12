/**
 * Identity-preserving transfer of one application between Ledgers.
 *
 * A copy writes through the public API and gets new IDs. A move must not:
 * every device holds the app and log IDs, event IDs and versions, and file keys
 * embed the app ID. This is the administrator-only path that carries all of it
 * (IDs, per-log versions, timestamps, authors, action batches, fork lineage,
 * hidden logs, and the idempotency records that recognize a retried request) into
 * an empty application, and a checksum per log to prove nothing changed.
 *
 * The stream is NDJSON, one record per line. `parseTransferRecords` is strict:
 * an import is refused rather than repaired.
 */

import { LedgerError, validationError } from "./errors";
import type { StoredEvent } from "./schemas";

export const TRANSFER_FORMAT = "ledger-application-transfer";
export const TRANSFER_VERSION = 1;
/** Events per `events` record and per checksum batch; both sides use the same pages. */
export const TRANSFER_PAGE = 256;

export interface TransferLog {
    t: "log";
    id: string;
    name: string;
    createdAt: string;
    lastUpdatedAt: string | null;
    sourceLogId: string | null;
    sourceVersion: number | null;
    hiddenAt: string | null;
    headVersion: number;
}

export interface TransferRequest {
    requestId: string;
    requestHash: string;
    createdAt: string;
    /** Null on rows from before replays read the version range; `result` then holds the stored response. */
    firstVersion: number | null;
    lastVersion: number | null;
    result: string | null;
}

export interface TransferFork {
    requestId: string;
    sourceLogId: string;
    targetVersion: number;
    expectedSourceHeadVersion: number;
    name: string;
    forkLogId: string;
}

export type TransferRecord =
    | TransferLog
    | { t: "events"; logId: string; events: StoredEvent[] }
    | { t: "requests"; logId: string; requests: TransferRequest[] }
    | { t: "forks"; requests: TransferFork[] };

export interface LogChecksum {
    id: string;
    headVersion: number;
    eventCount: number;
    sha256: string;
}

export interface TransferTotals {
    logs: number;
    events: number;
    requests: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
    throw validationError(`transfer: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
    if (typeof value !== "string" || !UUID.test(value)) fail(`${label} must be a UUID`);
    return (value as string).toLowerCase();
}

function text(value: unknown, label: string, max = 4096): string {
    if (typeof value !== "string" || value === "" || value.length > max) fail(`${label} must be a non-empty string`);
    return value as string;
}

function nullableText(value: unknown, label: string): string | null {
    return value === null || value === undefined ? null : text(value, label, 2_000_000);
}

function integer(value: unknown, label: string, min = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < min) fail(`${label} must be an integer of at least ${min}`);
    return value as number;
}

function nullableInteger(value: unknown, label: string): number | null {
    return value === null || value === undefined ? null : integer(value, label);
}

function iso(value: unknown, label: string): string {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO-8601 timestamp`);
    return value as string;
}

function event(value: unknown, label: string): StoredEvent {
    const raw = record(value, label);
    const payload = record(raw.payload, `${label}.payload`);
    const action = raw.action === undefined ? undefined : record(raw.action, `${label}.action`);
    return {
        version: integer(raw.version, `${label}.version`, 1),
        id: uuid(raw.id, `${label}.id`),
        type: text(raw.type, `${label}.type`, 128),
        entityId: text(raw.entityId, `${label}.entityId`, 512),
        entityVersion: integer(raw.entityVersion, `${label}.entityVersion`, 1),
        timestamp: integer(raw.timestamp, `${label}.timestamp`),
        payload: payload as StoredEvent["payload"],
        ...(action ? { action: { id: text(action.id, `${label}.action.id`, 256), index: integer(action.index, `${label}.action.index`), size: integer(action.size, `${label}.action.size`, 1) } } : {}),
        ...(raw.actor === undefined || raw.actor === null ? {} : { actor: text(raw.actor, `${label}.actor`, 512) }),
    } as StoredEvent;
}

export function parseTransferRecords(value: unknown): TransferRecord[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 2000) fail("records must be a list of 1 to 2000 entries");
    return value.map((entry, index): TransferRecord => {
        const label = `records[${index}]`;
        const raw = record(entry, label);
        switch (raw.t) {
            case "log":
                return {
                    t: "log",
                    id: uuid(raw.id, `${label}.id`),
                    name: text(raw.name, `${label}.name`, 512),
                    createdAt: iso(raw.createdAt, `${label}.createdAt`),
                    lastUpdatedAt: raw.lastUpdatedAt === null || raw.lastUpdatedAt === undefined ? null : iso(raw.lastUpdatedAt, `${label}.lastUpdatedAt`),
                    sourceLogId: raw.sourceLogId === null || raw.sourceLogId === undefined ? null : uuid(raw.sourceLogId, `${label}.sourceLogId`),
                    sourceVersion: nullableInteger(raw.sourceVersion, `${label}.sourceVersion`),
                    hiddenAt: raw.hiddenAt === null || raw.hiddenAt === undefined ? null : iso(raw.hiddenAt, `${label}.hiddenAt`),
                    headVersion: integer(raw.headVersion, `${label}.headVersion`),
                };
            case "events": {
                if (!Array.isArray(raw.events) || raw.events.length === 0 || raw.events.length > TRANSFER_PAGE) fail(`${label}.events must hold 1 to ${TRANSFER_PAGE} events`);
                return { t: "events", logId: uuid(raw.logId, `${label}.logId`), events: raw.events.map((item, at) => event(item, `${label}.events[${at}]`)) };
            }
            case "requests": {
                if (!Array.isArray(raw.requests) || raw.requests.length === 0 || raw.requests.length > 1000) fail(`${label}.requests must hold 1 to 1000 entries`);
                return {
                    t: "requests",
                    logId: uuid(raw.logId, `${label}.logId`),
                    requests: raw.requests.map((item, at) => {
                        const request = record(item, `${label}.requests[${at}]`);
                        const first = nullableInteger(request.firstVersion, `${label}.requests[${at}].firstVersion`);
                        const last = nullableInteger(request.lastVersion, `${label}.requests[${at}].lastVersion`);
                        if ((first === null) !== (last === null)) fail(`${label}.requests[${at}] has half a version range`);
                        const result = nullableText(request.result, `${label}.requests[${at}].result`);
                        if (first === null && result === null) fail(`${label}.requests[${at}] has neither a version range nor a stored response`);
                        return {
                            requestId: text(request.requestId, `${label}.requests[${at}].requestId`, 256),
                            requestHash: text(request.requestHash, `${label}.requests[${at}].requestHash`, 256),
                            createdAt: iso(request.createdAt, `${label}.requests[${at}].createdAt`),
                            firstVersion: first,
                            lastVersion: last,
                            result,
                        };
                    }),
                };
            }
            case "forks": {
                if (!Array.isArray(raw.requests) || raw.requests.length === 0 || raw.requests.length > 1000) fail(`${label}.requests must hold 1 to 1000 entries`);
                return {
                    t: "forks",
                    requests: raw.requests.map((item, at) => {
                        const fork = record(item, `${label}.requests[${at}]`);
                        return {
                            requestId: text(fork.requestId, `${label}.requests[${at}].requestId`, 256),
                            sourceLogId: uuid(fork.sourceLogId, `${label}.requests[${at}].sourceLogId`),
                            targetVersion: integer(fork.targetVersion, `${label}.requests[${at}].targetVersion`),
                            expectedSourceHeadVersion: integer(fork.expectedSourceHeadVersion, `${label}.requests[${at}].expectedSourceHeadVersion`),
                            name: text(fork.name, `${label}.requests[${at}].name`, 512),
                            forkLogId: uuid(fork.forkLogId, `${label}.requests[${at}].forkLogId`),
                        };
                    }),
                };
            }
            default:
                return fail(`${label}.t is not a known record type`);
        }
    });
}

/** One stored event row as the line the checksum covers; the same on both Ledgers. */
export function checksumLine(row: {
    version: number; event_id: string; event_type: string; entity_id: string; entity_version: number;
    event_timestamp: string; payload: string; action_id: string | null; action_index: number | null;
    action_size: number | null; actor: string | null;
}): string {
    return [row.version, row.event_id, row.event_type, row.entity_id, row.entity_version, row.event_timestamp, row.payload,
        row.action_id ?? "", row.action_index ?? "", row.action_size ?? "", row.actor ?? ""].join("\u001f");
}

export async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Chains one page of lines onto the running digest. */
export async function chainChecksum(previous: string, lines: readonly string[]): Promise<string> {
    return sha256Hex(`${previous}\n${lines.join("\n")}`);
}

export function transferError(code: string, message: string, status = 409): LedgerError {
    return new LedgerError(status, { error: "Conflict", code, message });
}
