import { selectReplayEvents } from './replay-selection.js';

/** Checkpoints are replay inputs, never new user events. */
export const CHECKPOINT_FORMAT = 1;
export interface CheckpointEvent {
    id: string;
    type: string;
    entityId: string;
    entityVersion: number;
    version: number;
    timestamp: number;
    payload: Record<string, unknown>;
    action?: { id: string; index: number; size: number };
    actor?: string;
}
export interface CheckpointPage {
    key: string;
    sha256: string;
    count: number;
    bytes: number;
}
export interface CheckpointChunk {
    events: CheckpointEvent[];
    claims: Array<{ entityId: string; currentVersion: number; logVersion: number }>;
}
export interface CheckpointManifest {
    format: 1;
    appId: string;
    logId: string;
    id: string;
    throughVersion: number;
    createdAt: string;
    pages: CheckpointPage[];
    eventCount: number;
    sourceEventCount: number;
    sha256: string;
}
export interface LogMaintenance {
    compactedThroughVersion: number;
    storageGeneration: number;
    checkpoint: CheckpointManifest | null;
    job: MaintenanceJob | null;
    available: boolean;
}
export interface CompactionPreview {
    checkpointId: string | null;
    storageGeneration: number;
    throughVersion: number;
    activePayloadEvents: number;
    activePayloadBytes: number;
    snapshotBytes: number;
}
export interface MaintenanceJob {
    id: string;
    kind: 'snapshot' | 'compact';
    logId: string;
    throughVersion: number;
    status: 'building' | 'cleaning' | 'archiving' | 'reclaiming' | 'complete' | 'failed' | 'paused';
    cursor: number;
    error: string | null;
    updatedAt: string;
}

export async function checkpointDigest(value: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Resolve a prefix using only its replay markers; payload rows can remain archived. */
export function checkpointSelection(markers: ReadonlyArray<Pick<CheckpointEvent, 'id' | 'type' | 'version' | 'payload'>>, through: number): (event: Pick<CheckpointEvent, 'id' | 'version'>) => boolean {
    const excluded = new Set<string>();
    const ranges: Array<[number, number]> = [];
    let ceiling = through;
    for (const event of [...markers].sort((a, b) => b.version - a.version)) {
        if (event.version > ceiling) continue;
        if (event.type === 'EVENT_TOMBSTONED') {
            if (typeof event.payload.eventId !== 'string' || !event.payload.eventId) throw new Error('Invalid tombstone target');
            excluded.add(event.payload.eventId);
        }
        if (excluded.has(event.id)) continue;
        if (event.type === 'EVENTS_EXCISED') {
            const targets = event.payload.eventIds;
            if (!Array.isArray(targets) || targets.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid excision target');
            for (const id of targets) excluded.add(id);
        }
        if (event.type === 'WORKSPACE_RESTORED') {
            const target = event.payload.targetVersion;
            if (typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0 || target >= event.version) throw new Error('Invalid restore target');
            ranges.push([event.version, ceiling]);
            ceiling = target;
        }
    }
    ranges.push([1, ceiling]);
    return event => !excluded.has(event.id) && ranges.some(([from, to]) => event.version >= from && event.version <= to);
}

/**
 * Retain original witnesses for every raw payload key, creation timestamp,
 * lifecycle transition, and last accepted version. SQL can therefore replay
 * them with its existing missing-key/null/cast/default semantics. These are
 * original accepted facts, not fabricated ADDED events with invented authors.
 * Stateful consumers may request additional witnesses with selectors.
 */
export function checkpointEntityEvents(
    events: readonly CheckpointEvent[],
    selectors: readonly ((event: CheckpointEvent) => string | null)[] = [],
    standardTypes?: ReadonlySet<string>,
): CheckpointEvent[] {
    const keep = new Map<string, CheckpointEvent>();
    const fields = new Map<string, CheckpointEvent>();
    let earliest: CheckpointEvent | undefined;
    let latest: CheckpointEvent | undefined;
    for (const event of events) {
        if (!earliest || event.timestamp < earliest.timestamp) earliest = event;
        if (!latest || event.entityVersion > latest.entityVersion) latest = event;
        if ((standardTypes && !standardTypes.has(event.type)) || event.type.startsWith('ENTITY_TYPE_') || !/_(ADDED|UPDATED|REMOVED)$/.test(event.type)) {
            // Dynamic definitions and nonstandard codecs retain their source
            // facts. This is a lossless fallback, never silently dropped data.
            keep.set(event.id, event);
            continue;
        }
        if (!event.type.endsWith('_UPDATED')) keep.set(event.id, event);
        for (const key of Object.keys(event.payload)) {
            const previous = fields.get(`field:${key}`);
            if (!previous || event.entityVersion > previous.entityVersion) fields.set(`field:${key}`, event);
        }
        for (const selector of selectors) {
            const key = selector(event);
            if (key !== null) {
                const previous = fields.get(`selector:${key}`);
                if (!previous || event.entityVersion > previous.entityVersion) fields.set(`selector:${key}`, event);
            }
        }
    }
    for (const event of fields.values()) keep.set(event.id, event);
    if (earliest) keep.set(earliest.id, earliest);
    if (latest) keep.set(latest.id, latest);
    return [...keep.values()].sort((a, b) => a.version - b.version);
}

/** Resolve directives before reducing the selected source facts. */
export function buildCheckpointEvents(events: readonly CheckpointEvent[], through: number): CheckpointEvent[] {
    const effective = new Set(selectReplayEvents(events.map(event => ({ ...event, logVersion: event.version })), through).map(event => event.id));
    const entities = new Map<string, CheckpointEvent[]>();
    for (const event of events) {
        if (!effective.has(event.id) || ['EVENT_TOMBSTONED', 'WORKSPACE_RESTORED', 'EVENTS_EXCISED'].includes(event.type)) continue;
        const values = entities.get(event.entityId) ?? [];
        values.push(event);
        entities.set(event.entityId, values);
    }
    return [...entities.values()].flatMap(values => checkpointEntityEvents(values)).sort((a, b) => a.version - b.version);
}

export function verifyCheckpointManifest(manifest: CheckpointManifest, appId: string, logId: string): void {
    if (manifest.format !== CHECKPOINT_FORMAT || manifest.appId !== appId || manifest.logId !== logId
        || !Number.isSafeInteger(manifest.throughVersion) || manifest.throughVersion < 0
        || !Array.isArray(manifest.pages) || manifest.pages.some(page => !/^[a-f0-9]{64}$/.test(page.sha256)
            || !Number.isSafeInteger(page.count) || page.count < 0 || !Number.isSafeInteger(page.bytes) || page.bytes < 0)
        || manifest.pages.reduce((count, page) => count + page.count, 0) !== manifest.eventCount) {
        throw new Error('Invalid checkpoint manifest');
    }
}
