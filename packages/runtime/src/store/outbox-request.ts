import type { AppendEventsRequest, IncomingEvent } from '../ledger/index.js';

/** Matches Ledger's append contract (`appendEventsBody` in `packages/ledger/src/schemas.ts`). */
export const MAX_BATCH_SIZE = 512;

export interface PendingBatchEvent {
    id: string;
    type: string;
    timestamp: number;
    entityId: string;
    payload: Record<string, unknown>;
    localSequence: number;
}

export function prepareAppendRequest(
    events: PendingBatchEvent[],
    currentVersions: ReadonlyMap<string, number>,
    requestId: string = crypto.randomUUID(),
): AppendEventsRequest {
    if (events.length === 0) throw new Error('Cannot prepare an empty Ledger append');
    if (events.length > MAX_BATCH_SIZE) {
        throw new Error(`Ledger batches are limited to ${MAX_BATCH_SIZE} events`);
    }

    const nextVersions = new Map(currentVersions);
    const incomingEvents: IncomingEvent[] = events.map((event) => {
        if (!event.id) throw new Error('Every local event must have an ID before it enters the outbox');
        const currentVersion = nextVersions.get(event.entityId);
        const incoming: IncomingEvent = {
            id: event.id,
            type: event.type,
            entityId: event.entityId,
            timestamp: event.timestamp,
            payload: event.payload,
        };
        if (currentVersion !== undefined) incoming.baseEntityVersion = currentVersion;
        nextVersions.set(event.entityId, (currentVersion ?? 0) + 1);
        return incoming;
    });
    return { requestId, events: incomingEvents };
}

export async function hashRequest(request: AppendEventsRequest): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(request)));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, nested]) => [key, canonicalize(nested)]),
        );
    }
    return value;
}
