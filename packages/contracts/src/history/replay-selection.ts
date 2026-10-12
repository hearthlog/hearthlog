export const WORKSPACE_RESTORED = 'WORKSPACE_RESTORED';
export const EVENTS_EXCISED = 'EVENTS_EXCISED';

export interface ReplayEvent {
    id: string;
    type: string;
    logVersion: number;
    payload: Record<string, unknown>;
}

/**
 * Select the effective facts at an accepted boundary. A restore chooses an
 * earlier prefix; subsequent accepted facts overlay it. Walking backwards lets
 * a later undo exclude a restore before its boundary is followed. Timestamps,
 * devices, enabled domains and projection tables do not affect this selection.
 *
 * Legacy excision markers exclude their targets while the marker is live.
 * Existing logs and forks may contain these events even though the app no
 * longer creates them.
 */
export function selectReplayEvents(events: readonly ReplayEvent[], boundary: number): ReplayEvent[] {
    if (!Number.isSafeInteger(boundary) || boundary < 0) throw new Error('Invalid replay boundary');
    const ordered = events.filter(event => event.logVersion <= boundary)
        .sort((a, b) => a.logVersion - b.logVersion);
    const positions = new Map<number, number>();
    for (const [index, event] of ordered.entries()) {
        if (!Number.isSafeInteger(event.logVersion) || event.logVersion < 1 || positions.has(event.logVersion)) {
            throw new Error('Invalid accepted event ordering');
        }
        positions.set(event.logVersion, index);
    }
    const excluded = new Set<string>();
    const selected: ReplayEvent[] = [];
    for (let index = ordered.length - 1; index >= 0; index--) {
        const event = ordered[index]!;
        if (event.type === 'EVENT_TOMBSTONED') {
            const target = event.payload.eventId;
            if (typeof target !== 'string' || !target) throw new Error('Invalid tombstone target');
            // Preserve legacy replay: tombstones remain effective even if another
            // tombstone names them. Undo never creates tombstones of tombstones.
            excluded.add(target);
        }
        if (excluded.has(event.id)) continue;
        if (event.type === EVENTS_EXCISED) {
            const targets = event.payload.eventIds;
            if (!Array.isArray(targets) || targets.some(target => typeof target !== 'string' || !target)) {
                throw new Error('Invalid excision target');
            }
            for (const target of targets) excluded.add(target);
        }
        selected.push(event);
        if (event.type === WORKSPACE_RESTORED) {
            const target = event.payload.targetVersion;
            if (typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0 || target >= event.logVersion) {
                throw new Error('Invalid restore target');
            }
            if (target !== 0 && !positions.has(target)) throw new Error('Restore target has not been downloaded');
            index = target === 0 ? 0 : positions.get(target)! + 1;
        }
    }
    return selected.reverse().filter(event => !excluded.has(event.id));
}
