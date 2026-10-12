/**
 * Pending work, carried by hand from a workspace that moved to its new home.
 *
 * When a tenant moves to another origin, a device that had unsynced changes
 * cannot send them to the old one (it answers 410 "moved"), and its local
 * database is bound to the old origin. It exports its queued requests as a
 * file; the new origin sends them to the Ledger as they were: same request
 * IDs, same event IDs, same bodies. The app and log IDs and the idempotency
 * records survived the move, so a request that had in fact been accepted
 * before the move is recognized and answered again, not applied twice.
 *
 * Nothing here touches the database: building and reading the file are pure.
 */

import type { AppendEventsRequest } from '../ledger/index.js';

export const PENDING_WORK_FORMAT = 'stor-pending-work';
export const PENDING_WORK_VERSION = 1;

export interface PendingWorkOperation {
    logId: string;
    /** The request exactly as it was queued, so its idempotency key and event IDs are the original ones. */
    request: AppendEventsRequest;
    /** Where the request stood on the device when it was exported. */
    status: string;
    createdAt: string;
}

export interface PendingWorkFile {
    format: typeof PENDING_WORK_FORMAT;
    version: typeof PENDING_WORK_VERSION;
    exportedAt: string;
    /** The origin the work was queued at. */
    origin: string;
    /** Where the workspace lives now, when the old origin said so. */
    destination: string | null;
    operations: PendingWorkOperation[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PendingWorkFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PendingWorkFileError';
    }
}

export function buildPendingWorkFile(input: {
    origin: string;
    destination: string | null;
    operations: PendingWorkOperation[];
    now?: Date;
}): PendingWorkFile {
    return {
        format: PENDING_WORK_FORMAT,
        version: PENDING_WORK_VERSION,
        exportedAt: (input.now ?? new Date()).toISOString(),
        origin: input.origin,
        destination: input.destination,
        operations: input.operations,
    };
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new PendingWorkFileError(`${label} must be an object`);
    return value as Record<string, unknown>;
}

/** Reads and strictly checks a file; anything unexpected is refused rather than sent to the Ledger. */
export function parsePendingWorkFile(text: string): PendingWorkFile {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new PendingWorkFileError('This is not a pending-work file');
    }
    const file = object(value, 'The file');
    if (file.format !== PENDING_WORK_FORMAT) throw new PendingWorkFileError('This is not a pending-work file');
    if (file.version !== PENDING_WORK_VERSION) throw new PendingWorkFileError(`Unsupported pending-work version ${String(file.version)}`);
    if (!Array.isArray(file.operations)) throw new PendingWorkFileError('The file lists no operations');
    const operations = file.operations.map((entry, index): PendingWorkOperation => {
        const label = `Operation ${index + 1}`;
        const operation = object(entry, label);
        const request = object(operation.request, `${label} request`);
        if (typeof operation.logId !== 'string' || !UUID.test(operation.logId)) throw new PendingWorkFileError(`${label} has no valid log`);
        if (typeof request.requestId !== 'string' || !UUID.test(request.requestId)) throw new PendingWorkFileError(`${label} has no request ID`);
        if (!Array.isArray(request.events) || request.events.length === 0) throw new PendingWorkFileError(`${label} carries no events`);
        for (const [at, event] of request.events.entries()) {
            const item = object(event, `${label} event ${at + 1}`);
            if (typeof item.id !== 'string' || !UUID.test(item.id)) throw new PendingWorkFileError(`${label} event ${at + 1} has no ID`);
            if (typeof item.type !== 'string' || typeof item.entityId !== 'string') throw new PendingWorkFileError(`${label} event ${at + 1} is incomplete`);
            object(item.payload, `${label} event ${at + 1} payload`);
        }
        return {
            logId: operation.logId.toLowerCase(),
            request: request as unknown as AppendEventsRequest,
            status: typeof operation.status === 'string' ? operation.status : 'pending',
            createdAt: typeof operation.createdAt === 'string' ? operation.createdAt : '',
        };
    });
    const ids = new Set<string>();
    for (const operation of operations) {
        if (ids.has(operation.request.requestId)) throw new PendingWorkFileError('The file repeats a request');
        ids.add(operation.request.requestId);
    }
    return {
        format: PENDING_WORK_FORMAT,
        version: PENDING_WORK_VERSION,
        exportedAt: typeof file.exportedAt === 'string' ? file.exportedAt : '',
        origin: typeof file.origin === 'string' ? file.origin : '',
        destination: typeof file.destination === 'string' ? file.destination : null,
        operations,
    };
}

export type ImportOutcome = 'applied' | 'conflict' | 'missing_log' | 'refused' | 'unavailable';

export interface ImportResult {
    requestId: string;
    outcome: ImportOutcome;
    message: string;
}

export interface ImportReport {
    results: ImportResult[];
    applied: number;
    notApplied: number;
}

export function summarizeImport(results: ImportResult[]): ImportReport {
    const applied = results.filter((result) => result.outcome === 'applied').length;
    return { results, applied, notApplied: results.length - applied };
}

/** What a failed send means for the person importing: nothing here is retried silently. */
export function classifyImportFailure(status: number | undefined, code: string | undefined): ImportOutcome {
    if (code === 'tenant_moved' || code === 'tenant_migrating') return 'unavailable';
    if (status === 404) return 'missing_log';
    if (status === 409) return 'conflict';
    if (status === undefined || status >= 500 || status === 408 || status === 429) return 'unavailable';
    return 'refused';
}
