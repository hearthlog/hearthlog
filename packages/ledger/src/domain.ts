import type {
    AppendEventsRequest,
    IncomingEvent,
    StoredEvent,
} from "./schemas";
import {
    invalidEvent,
    LedgerError,
    validationError,
} from "./errors";
import { parseUuid } from "./contracts";
import { FILE_REFERENCES, type FileReference } from "#generated/event-schemas";

/** The largest millisecond timestamp a JavaScript Date can represent. */
const MAX_EVENT_TIMESTAMP = 8_640_000_000_000_000;

export async function hashAppendRequest(
    logId: string,
    request: AppendEventsRequest,
): Promise<string> {
    const normalized = canonicalJson({
        logId,
        ...(request.actionId ? { actionId: request.actionId } : {}),
        ...(request.expectedLogVersion !== undefined ? { expectedLogVersion: request.expectedLogVersion } : {}),
        events: request.events.map((event) => ({
            id: event.id ?? null,
            type: event.type,
            timestamp: event.timestamp ?? null,
            entityId: event.entityId,
            baseEntityVersion: event.baseEntityVersion ?? null,
            payload: event.payload,
        })),
    });
    const bytes = new TextEncoder().encode(normalized);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

export function validateIncomingEvents(
    events: readonly IncomingEvent[],
    references: Readonly<Record<string, FileReference>> = FILE_REFERENCES,
): void {
    const eventIds = new Set<string>();
    for (const event of events) {
        validateIncomingEvent(event, references);
        if (!event.id) continue;
        if (eventIds.has(event.id)) {
            throw invalidEvent("event ids must be unique within a request");
        }
        eventIds.add(event.id);
    }
}

export function validateIncomingEvent(
    event: IncomingEvent,
    references: Readonly<Record<string, FileReference>> = FILE_REFERENCES,
): void {
    if (event.type.trim() === "") {
        throw invalidEvent("event type must not be empty");
    }
    if (event.entityId.trim() === "") {
        throw invalidEvent("entityId must not be empty");
    }
    if (event.type === "EVENTS_EXCISED") {
        validateExcisionPayload(event);
    }
    fileReference(event, references);
}

/**
 * An accepted event that names an immutable file version grants its log that version. An add must
 * name one; an update does so only when it replaces the file. The entity id must be `<entity>:<id>`.
 * The references come from the installed modules' entity definitions (`fileReference`).
 */
export function fileReference(
    event: IncomingEvent,
    references: Readonly<Record<string, FileReference>> = FILE_REFERENCES,
): { ownerId: string; fileVersionId: string } | null {
    const reference = references[event.type];
    if (!reference) return null;
    if (!reference.requiredOnAdd && event.payload[reference.versionKey] === undefined) return null;
    let ownerId: string;
    let fileVersionId: string;
    try {
        ownerId = parseUuid(event.payload.id, `${reference.entity} id`);
        fileVersionId = parseUuid(event.payload[reference.versionKey], `${reference.entity} file version id`);
    } catch {
        throw invalidEvent(`${reference.entity} file reference requires UUID id and ${reference.versionKey}`);
    }
    if (event.entityId !== `${reference.entity}:${ownerId}`) {
        throw invalidEvent(`${reference.entity} entityId must match payload id`);
    }
    return { ownerId, fileVersionId };
}

const MAX_EXCISION_TARGETS = 200;

function validateExcisionPayload(event: IncomingEvent): void {
    const eventIds = event.payload.eventIds;
    if (!Array.isArray(eventIds) || eventIds.length === 0) {
        throw invalidEvent("excision requires eventIds");
    }
    if (eventIds.length > MAX_EXCISION_TARGETS) {
        throw invalidEvent(`excision is limited to ${MAX_EXCISION_TARGETS} events`);
    }
    const unique = new Set<string>();
    for (const target of eventIds) {
        if (typeof target !== "string" || target.trim() === "") {
            throw invalidEvent("excision targets must be non-empty event ids");
        }
        if (unique.has(target)) {
            throw invalidEvent("excision targets must be unique");
        }
        unique.add(target);
    }
    if (event.id && unique.has(event.id)) {
        throw invalidEvent("an excision cannot remove itself");
    }
}

export function validateEntityChain(
    entityId: string,
    events: readonly IncomingEvent[],
    currentEntityVersion: number | undefined,
    currentLogVersion: number,
): void {
    if (events.length === 0) return;

    if (currentEntityVersion !== undefined) {
        events.forEach((event, offset) => {
            const expected = currentEntityVersion + offset;
            const actual = event.baseEntityVersion ?? undefined;
            if (offset === 0 && actual !== expected) {
                if (actual === undefined) {
                    throw invalidEntityVersionChain(
                        entityId,
                        expected,
                        undefined,
                    );
                }
                throw new LedgerError(409, {
                    code: "entity_conflict",
                    entityId,
                    currentEntityVersion,
                    currentLogVersion,
                });
            }
            if (offset > 0 && actual !== expected) {
                throw invalidEntityVersionChain(
                    entityId,
                    expected,
                    actual,
                );
            }
        });
        return;
    }

    events.forEach((event, offset) => {
        const expected = offset > 0 ? offset : undefined;
        const actual = event.baseEntityVersion ?? undefined;
        if (actual !== expected) {
            throw invalidEntityVersionChain(
                entityId,
                expected,
                actual,
            );
        }
    });
}

export function buildStoredEvent(
    incoming: IncomingEvent,
    version: number,
    entityVersion: number,
): StoredEvent {
    const timestamp = incoming.timestamp ?? Date.now();
    if (
        !Number.isSafeInteger(timestamp) ||
        timestamp < 0 ||
        timestamp > MAX_EVENT_TIMESTAMP
    ) {
        throw invalidEvent("timestamp out of range");
    }
    return {
        version,
        id: incoming.id ?? crypto.randomUUID(),
        type: incoming.type,
        entityId: incoming.entityId.trim(),
        entityVersion,
        timestamp,
        payload: incoming.payload,
    };
}

/**
 * The identity a gateway stamped on a request. Anything that is not a short
 * printable string is ignored rather than stored, so a malformed header can
 * never fail an append.
 */
export function normalizeActor(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const actor = value.trim();
    if (actor.length === 0 || actor.length > 320) return null;
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u001f\u007f]/.test(actor) ? null : actor;
}

export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
            )
            .join(",")}}`;
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw validationError("value is not JSON serializable");
    }
    return serialized;
}

function invalidEntityVersionChain(
    entityId: string,
    expected: number | undefined,
    actual: number | undefined,
): LedgerError {
    return new LedgerError(409, {
        error: "ValidationError",
        code: "invalid_entity_version_chain",
        message: "baseEntityVersion does not continue the entity version chain",
        entityId,
        expectedBaseEntityVersion: expected ?? null,
        actualBaseEntityVersion: actual ?? null,
    });
}
