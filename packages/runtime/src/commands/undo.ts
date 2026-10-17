import { ENTITY_DEFINITIONS, getEventPrefix } from '@hearthlog/contracts/event/entity-definitions';
import type { ExtendedAppEvent } from '../event/types.js';

/** A record whose removal reverses its addition. */
export interface UndoTarget {
    type: string;
    id: string;
}

/** Standard entities: each adds, updates and removes through `<PREFIX>ADDED|UPDATED|REMOVED`. */
const STANDARD_PREFIXES = new Set(ENTITY_DEFINITIONS.map(getEventPrefix));

/**
 * Undo appends the opposite of an action; history is never edited and no event is tombstoned. Only an action that
 * just added standard records has an exact opposite, their removal, so anything else (an edit, a removal, a
 * module's own event) returns null and offers no undo.
 */
export function undoTargets(events: readonly ExtendedAppEvent[]): UndoTarget[] | null {
    const targets: UndoTarget[] = [];
    for (const event of events) {
        const prefix = event.type.endsWith('_ADDED') ? event.type.slice(0, -'ADDED'.length) : null;
        const id = (event.payload as { id?: unknown } | null)?.id;
        if (!prefix || !STANDARD_PREFIXES.has(prefix) || typeof id !== 'string' || id === '') return null;
        targets.push({ type: `${prefix}REMOVED`, id });
    }
    return targets.length > 0 ? targets : null;
}

/** The removal events for an undo, stamped when it runs. */
export function undoEvents(targets: readonly UndoTarget[], now = Date.now()): ExtendedAppEvent[] {
    return targets.map(({ type, id }) => ({ id: crypto.randomUUID(), type, timestamp: now, payload: { id } }) as ExtendedAppEvent);
}
