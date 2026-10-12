import type { StoredEvent, AppendEventsRequest } from './schemas.js';

/** Replay an exported batch at the same positions in an empty destination log. */
export function restoreBatchRequest(events: readonly StoredEvent[], requestId: string): AppendEventsRequest {
    if (!events.length) throw new Error('empty exported batch');
    return {
        requestId,
        ...(events.some(event => event.type === 'WORKSPACE_RESTORED') ? { expectedLogVersion: events[0]!.version - 1 } : {}),
        ...(events[0]?.action ? { actionId: events[0].action.id } : {}),
        events: events.map(event => ({
            id: event.id, type: event.type, entityId: event.entityId,
            ...(event.entityVersion > 1 ? { baseEntityVersion: event.entityVersion - 1 } : {}),
            timestamp: event.timestamp, payload: event.payload,
        })),
    };
}

/** Reassemble complete actions when an export page splits their events. */
export function* actionBatches(events: readonly StoredEvent[]): Generator<StoredEvent[]> {
    const seen = new Set<string>();
    for (let offset = 0; offset < events.length;) {
        const first = events[offset]!;
        const action = first.action;
        if (!action) {
            const batch: StoredEvent[] = [];
            while (offset < events.length && !events[offset]!.action && batch.length < 512) {
                batch.push(events[offset++]!);
            }
            yield batch;
            continue;
        }
        if (seen.has(action.id) || action.index !== 0 || action.size < 1 || !Number.isSafeInteger(action.size)) {
            throw new Error('invalid or repeated exported action');
        }
        seen.add(action.id);
        const batch = events.slice(offset, offset + action.size);
        if (batch.length !== action.size || batch.some((event, index) =>
            event.action?.id !== action.id || event.action.index !== index || event.action.size !== action.size)) {
            throw new Error('incomplete exported action');
        }
        yield batch;
        offset += action.size;
    }
}

/**
 * Split a batch so each replayed request has one author. A grouped action is
 * one original request and stays whole; legacy events were only batched for
 * convenience and may come from different people.
 */
export function* authorRuns(batch: readonly StoredEvent[]): Generator<StoredEvent[]> {
    if (batch[0]?.action) {
        yield [...batch];
        return;
    }
    let run: StoredEvent[] = [];
    for (const event of batch) {
        if (run.length && run[0]!.actor !== event.actor) {
            yield run;
            run = [];
        }
        run.push(event);
    }
    if (run.length) yield run;
}
