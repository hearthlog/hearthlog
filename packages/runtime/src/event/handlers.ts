import { baselineVersion, directivesReachBehind, loadArchivedHistory, REPLAY_DIRECTIVES } from '../history/baseline.js';
import { hasReplayDirectives } from '../history/legacy-replay.js';
import { EVENTS_EXCISED, WORKSPACE_RESTORED } from '@hearthlog/contracts/history/replay-selection';
import { recordIngestedProgress } from '../store/sync-progress.js';
/**
 * Event Handlers
 * 
 * Core event processing and handling functions.
 * Uses dynamic dispatch based on the entity registry.
 */

import { db as readModelDB, requireActiveContext } from '../db/index.js';
import type { ActiveContext, Database } from '../db/index.js';
import { sql, type Transaction } from 'kysely';
import type { StoredEvent } from '../ledger/types.js';
import { versionTracker, rebuildReadModel } from './rebuild.js';
import { schemaTombstoneIds } from './schema-effects.js';
import { entityRegistry, getAllEntityTables, clearDynamicRegistry } from './registry.js';
import { createEntityProjector, projectEntitySet } from './projection-builder.js';
import type {
    AppEvent,
    TombstoneEvent,
} from './types.js';
import {
    isEntityTypeDefinedEvent,
    isEntityTypeUpdatedEvent,
    isEntityTypeArchivedEvent,
} from './meta-entity-types.js';
import {
    handleEntityTypeDefined,
    handleEntityTypeUpdated,
    handleEntityTypeArchived,
} from './dynamic-entities.js';
import { withTiming, createTimer } from '../utils/perf.js';
import { postTabChange } from '../store/tab-coordination.js';

// ============================================================================
// In-memory event cache for realtime duplicate suppression
// ============================================================================

/**
 * Cache of recently processed event IDs to skip redundant INSERT operations.
 * When tabs share SQLite, one tab inserts and another receives via WebSocket.
 * The receiving tab can skip INSERT if the event was already processed.
 */
const RECENT_EVENT_CACHE_SIZE = 500;
const recentEventIds = new Set<string>();
const recentEventQueue: string[] = []; // FIFO queue to maintain order for eviction

/** Add an event ID to the recent cache */
export function cacheEventId(eventId: string): void {
    if (recentEventIds.has(eventId)) return;

    recentEventIds.add(eventId);
    recentEventQueue.push(eventId);

    // Evict oldest if over capacity
    while (recentEventQueue.length > RECENT_EVENT_CACHE_SIZE) {
        const oldest = recentEventQueue.shift();
        if (oldest) recentEventIds.delete(oldest);
    }
}

/** Check if event was recently processed by this tab */
export function isEventCached(eventId: string): boolean {
    return recentEventIds.has(eventId);
}

export function clearEventCache(): void {
    recentEventIds.clear();
    recentEventQueue.length = 0;
}

// ============================================================================
// Type Guards
// ============================================================================

export function isTombstoneEvent(event: AppEvent): event is TombstoneEvent {
    return event.type === 'EVENT_TOMBSTONED';
}

// ============================================================================
// Event Projection
// ============================================================================

export async function projectEntityById(
    entityId: string,
    tx: Transaction<Database>,
    context: ActiveContext,
): Promise<void> {
    const timer = createTimer('projection', `projectEntity:${entityId.split(':')[0]}`);
    const [entityType, uuid] = entityId.split(':');
    if (!uuid || !entityType) {
        console.warn('[Event] Invalid entity ID format for projection:', entityId);
        return;
    }

    const entry = entityRegistry[entityType];
    if (!entry) {
        // This is expected for events that don't map to entities (if any)
        return;
    }

    // The projector handles deletion of the old record and re-creation
    const projector = createEntityProjector(entry.projection);
    await projector({ payload: { id: uuid } }, tx, entityId, context);

    timer.stop({ entityId });
}

function compareStoredEvents(a: StoredEvent, b: StoredEvent): number {
    return a.version - b.version || a.timestamp - b.timestamp || a.id.localeCompare(b.id);
}

// Twenty raw-event columns keep 40 rows below SQLite's conservative 999-bind
// limit. Projection sets need far fewer bindings and can contain 100 entities.
const EVENT_WRITE_BATCH_SIZE = 40;
const PROJECTION_BATCH_SIZE = 100;

async function storeIncomingBatch(
    events: readonly StoredEvent[],
    tx: Transaction<Database>,
    context: ActiveContext,
): Promise<void> {
    await tx.insertInto('raw_events').values(events.map(event => ({
        id: event.id,
        tenant_id: context.tenantId,
        log_id: context.logId,
        local_batch_id: `server:${context.tenantId}:${context.logId}:${event.id}`,
        local_sequence: event.version,
        action_id: event.action?.id ?? null,
        action_index: event.action?.index ?? null,
        action_size: event.action?.size ?? null,
        actor: event.actor ?? null,
        type: event.type,
        timestamp: event.timestamp,
        payload: JSON.stringify(event.payload),
        entity_id: event.entityId,
        entity_version: event.entityVersion,
        log_version: event.version,
        sync_state: 'synced',
        projection_state: 'effective',
        rejection_code: null,
        rejection_detail: null,
        is_tombstoned: 0,
    }))).onConflict(oc => oc.columns(['tenant_id', 'log_id', 'id']).doUpdateSet(eb => ({
        log_version: eb.ref('excluded.log_version'),
        action_id: sql`COALESCE(excluded.action_id, raw_events.action_id)`,
        action_index: sql`CASE WHEN excluded.action_id IS NOT NULL THEN excluded.action_index ELSE raw_events.action_index END`,
        action_size: sql`CASE WHEN excluded.action_id IS NOT NULL THEN excluded.action_size ELSE raw_events.action_size END`,
        actor: sql`CASE WHEN excluded.actor IS NOT NULL AND excluded.actor <> '' THEN excluded.actor ELSE raw_events.actor END`,
        entity_version: eb.ref('excluded.entity_version'),
        entity_id: eb.ref('excluded.entity_id'),
        sync_state: 'synced',
        // Never rewrite payloads/local batch identities or revive hidden history.
        projection_state: sql`CASE WHEN raw_events.projection_state = 'restored_out' THEN 'restored_out' ELSE 'effective' END`,
        rejection_code: null,
        rejection_detail: null,
    }))).execute();

    // Derive status from all events in each original local batch, not just this
    // download page. Keep its creation/replacement metadata on acknowledgement.
    await sql`
        INSERT INTO local_batches (id, tenant_id, log_id, status, replacement_for, updated_at)
        SELECT DISTINCT accepted.local_batch_id, ${context.tenantId}, ${context.logId},
            CASE WHEN EXISTS (
                SELECT 1 FROM raw_events pending
                WHERE pending.tenant_id = accepted.tenant_id
                  AND pending.log_id = accepted.log_id
                  AND pending.local_batch_id = accepted.local_batch_id
                  AND pending.log_version IS NULL
            ) THEN 'pending' ELSE 'synced' END,
            NULL, ${new Date().toISOString()}
        FROM raw_events accepted
        WHERE accepted.tenant_id = ${context.tenantId}
          AND accepted.log_id = ${context.logId}
          AND accepted.id IN (${sql.join(events.map(event => event.id))})
        ON CONFLICT (id) DO UPDATE SET
            status = excluded.status, updated_at = excluded.updated_at
        WHERE local_batches.tenant_id = excluded.tenant_id
          AND local_batches.log_id = excluded.log_id
    `.execute(tx);
}

async function projectAffectedEntities(
    entityIds: ReadonlySet<string>,
    tx: Transaction<Database>,
    context: ActiveContext,
): Promise<void> {
    const byType = new Map<string, string[]>();
    for (const entityId of entityIds) {
        const [entityType, uuid] = entityId.split(':');
        if (!entityType || !uuid) {
            console.warn('[Event] Invalid entity ID format for projection:', entityId);
            continue;
        }
        if (!entityRegistry[entityType]) continue;
        const ids = byType.get(entityType) ?? [];
        ids.push(entityId);
        byType.set(entityType, ids);
    }
    for (const [type, ids] of byType) {
        for (let offset = 0; offset < ids.length; offset += PROJECTION_BATCH_SIZE) {
            const batch = ids.slice(offset, offset + PROJECTION_BATCH_SIZE);
            await withTiming('projection', `projectEntities:${type}`, () =>
                projectEntitySet(entityRegistry[type].projection, batch, tx, context),
            );
        }
    }
}

export async function applyMetaEvents(events: Array<{ type: string; payload: unknown }>): Promise<void> {
    let changedSchema = false;
    for (const event of events) {
        if (isEntityTypeDefinedEvent(event)) {
            await handleEntityTypeDefined(event.payload as Parameters<typeof handleEntityTypeDefined>[0]);
            changedSchema = true;
        } else if (isEntityTypeUpdatedEvent(event)) {
            await handleEntityTypeUpdated(event.payload as Parameters<typeof handleEntityTypeUpdated>[0]);
            changedSchema = true;
        } else if (isEntityTypeArchivedEvent(event)) {
            await handleEntityTypeArchived(event.payload as Parameters<typeof handleEntityTypeArchived>[0]);
            changedSchema = true;
        }
    }
    if (changedSchema) {
        // Each tab keeps its own registry of runtime-defined entities.
        const context = await requireActiveContext();
        postTabChange({ kind: 'schema', tenantId: context.tenantId, logId: context.logId });
    }
}


// ============================================================================
// Tombstone Handling
// ============================================================================

/**
 * Handles a tombstone event by re-projecting only the affected entity.
 * This avoids the costly full read model rebuild.
 */
/**
 * Applies a tombstone by marking the target event as tombstoned.
 * Returns the entity ID of the target event so it can be re-projected.
 */
async function applyTombstoneAndGetEntityId(
    event: TombstoneEvent,
    tx: Transaction<Database>,
    context: ActiveContext,
): Promise<string | null> {
    const targetEventId = event.payload.eventId;
    console.log('[Event] Applying tombstone for target event:', targetEventId);

    // 1. Look up the target event to get entity info
    const targetEvent = await tx
        .selectFrom('raw_events')
        .select(['entity_id', 'type'])
        .where('id', '=', targetEventId)
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .executeTakeFirst();

    if (!targetEvent) {
        console.warn('[Event] Tombstone target event not found:', targetEventId);
        return null;
    }

    // 2. Mark as tombstoned
    await tx
        .updateTable('raw_events')
        .set({ is_tombstoned: 1 })
        .where('id', '=', targetEventId)
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .execute();

    return targetEvent.entity_id || null;
}

// ============================================================================
// Public API
// ============================================================================

export async function clearActiveProjections(): Promise<void> {
    console.log('[Event] Clearing active projections');
    try {
        const context = await requireActiveContext();
        const tablesToClear = [...new Set(getAllEntityTables())];
        await readModelDB.transaction().execute(async (tx) => {
            // Clear only this tab's log scope — other logs' projections stay intact
            for (const table of tablesToClear) {
                await tx.deleteFrom(table as keyof Database)
                    .where('tenant_id', '=', context.tenantId)
                    .where('log_id', '=', context.logId)
                    .execute();
            }
            // Clear entity version cache table as well
            await tx.deleteFrom('entity_versions')
                .where('tenant_id', '=', context.tenantId)
                .where('log_id', '=', context.logId)
                .execute();
            // Dynamic type definitions follow the same log scope as their source events
            await tx.deleteFrom('entity_type_definitions')
                .where('tenant_id', '=', context.tenantId)
                .where('log_id', '=', context.logId)
                .execute();
        });
        clearDynamicRegistry();
        clearEventCache();
        console.log('[Event] Active projections cleared');
    } catch (error) {
        console.error('[Event] Failed to clear read model:', error);
        throw error;
    }
}

async function deleteActiveLogData(): Promise<void> {
    const context = await requireActiveContext();
    await readModelDB.transaction().execute(async (tx) => {
        const operations = await tx.selectFrom('outbox_operations')
            .select('id')
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .execute();
        if (operations.length > 0) {
            await tx.deleteFrom('outbox_operation_items')
                .where('operation_id', 'in', operations.map((operation) => operation.id))
                .execute();
        }
        await tx.deleteFrom('outbox_operations')
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .execute();
        await tx.deleteFrom('local_batches')
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .execute();
        await tx.deleteFrom('raw_events')
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .execute();
        for (const table of ['checkpoint_events', 'checkpoint_claims', 'log_baselines'] as const) {
            await tx.deleteFrom(table).where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId).execute();
        }
        await tx.deleteFrom('log_sync_state')
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .execute();
    });
    await clearActiveProjections();
}

export async function replaceAllStoredEvents(storedEvents: StoredEvent[]): Promise<void> {
    console.log('[Event] Replacing all stored events with', storedEvents.length, 'events');

    try {
        await deleteActiveLogData();
        await handleIncomingStoredEvents(storedEvents);
        console.log('[Event] Replace all stored events completed successfully');
    } catch (error) {
        console.error('[Event] Replace all stored events failed:', error);
        throw error;
    }
}

/** An incoming tombstone that undoes an accepted restore or removal. */
async function undoesReplayDirective(
    context: ActiveContext,
    storedEvents: readonly StoredEvent[],
): Promise<boolean> {
    const targetIds = storedEvents
        .filter((event) => event.type === 'EVENT_TOMBSTONED')
        .map((event) => (event.payload as { eventId?: unknown }).eventId)
        .filter((eventId): eventId is string => typeof eventId === 'string' && eventId.length > 0);
    if (targetIds.length === 0) return false;
    const directive = await readModelDB.selectFrom('raw_events').select('id')
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('id', 'in', targetIds)
        .where('type', 'in', [WORKSPACE_RESTORED, EVENTS_EXCISED])
        .executeTakeFirst();
    return Boolean(directive);
}

/**
 * Reconciliation holds back events past a download gap, so in a log with
 * directives any accepted row beyond the contiguous head means this batch may
 * release a deferred restore or removal.
 */
async function fillsDeferredReplay(context: ActiveContext): Promise<boolean> {
    if (!await hasReplayDirectives(readModelDB, context)) return false;
    const progress = await readModelDB.selectFrom('log_sync_state')
        .select('downloaded_head_version')
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .executeTakeFirst();
    const beyondHead = await readModelDB.selectFrom('raw_events').select('id')
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('log_version', '>', progress?.downloaded_head_version ?? 0)
        .executeTakeFirst();
    return Boolean(beyondHead);
}

/**
 * Handles incoming StoredEvents from the Ledger Service (via HTTP or WebSocket).
 * Preserves server-assigned entity versions.
 * @returns Object indicating whether new events were processed (vs just metadata updates)
 */
export async function handleIncomingStoredEvents(
    storedEvents: StoredEvent[]
): Promise<{ hasNewEvents: boolean; newCount: number }> {
    console.log(
        '[Event] handleIncomingStoredEvents called with',
        storedEvents.length,
        'events'
    );

    if (storedEvents.length === 0) return { hasNewEvents: false, newCount: 0 };

    return withTiming('projection', 'handleIncomingStoredEvents', async () => {
        storedEvents.sort(compareStoredEvents);
        const context = await requireActiveContext();
        // The baseline already holds everything it covers. Only a directive that reaches behind it needs the
        // original history; one that targets pending or later events replays on top of the baseline.
        const installed = await baselineVersion(context);
        const directives = installed ? storedEvents.filter(event => (REPLAY_DIRECTIVES as readonly string[]).includes(event.type)) : [];
        if (directives.length) {
            const later = directives.filter(event => event.version > installed);
            // A directive the baseline already covers is replayed from full history, as before.
            if (later.length < directives.length || await directivesReachBehind(context, installed, later,
                new Set(storedEvents.filter(event => event.version > installed).map(event => event.id)))) {
                await loadArchivedHistory();
            }
        }

        const coveredThrough = await baselineVersion(context);
        const covered = coveredThrough ? storedEvents.filter(event => event.version <= coveredThrough) : [];
        if (covered.length) {
            await readModelDB.transaction().execute(async tx => {
                for (let offset = 0; offset < covered.length; offset += EVENT_WRITE_BATCH_SIZE) {
                    const batch = covered.slice(offset, offset + EVENT_WRITE_BATCH_SIZE);
                    await storeIncomingBatch(batch, tx, context);
                    await tx.updateTable('raw_events').set({ projection_state: 'baseline_covered' })
                        .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId).where('id', 'in', batch.map(event => event.id)).execute();
                }
                await projectAffectedEntities(new Set(covered.map(event => event.entityId)), tx, context);
            });
            storedEvents = storedEvents.filter(event => event.version > coveredThrough);
            if (!storedEvents.length) return { hasNewEvents: true, newCount: 0 };
        }

        const existingRows = await readModelDB.selectFrom('raw_events')
            .select('id')
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('id', 'in', storedEvents.map((event) => event.id))
            .execute();
        const existingIds = new Set(existingRows.map((row) => row.id));
        const uncachedEvents = storedEvents.filter((event) => !existingIds.has(event.id));
        const cachedEvents = storedEvents.filter((event) => existingIds.has(event.id));

        console.log(`[Event] Processing: ${uncachedEvents.length} uncached, ${cachedEvents.length} cached (skipping INSERT)`);

        const affectedEntityIds = new Set<string>();
        // Ordinary events after a restore or removal keep membership as is:
        // only directives, their undo, or filling a gap that holds a directive
        // back change which events replay.
        const hasDdl = storedEvents.some(event => event.type.startsWith('ENTITY_TYPE_') || event.type === WORKSPACE_RESTORED || event.type === EVENTS_EXCISED)
            || (await schemaTombstoneIds(readModelDB, context, storedEvents)).size > 0
            || await undoesReplayDirective(context, storedEvents)
            || await fillsDeferredReplay(context);

        if (storedEvents.length > 0) {
            await withTiming('db', 'eventTransaction', async () => {
                await readModelDB.transaction().execute(async (tx) => {
                    for (let offset = 0; offset < storedEvents.length;) {
                        const candidate = storedEvents.slice(offset, offset + EVENT_WRITE_BATCH_SIZE);
                        // Flush through each tombstone before inserting later events:
                        // its target lookup must observe the same ordered prefix.
                        const tombstoneIndex = candidate.findIndex(event => event.type === 'EVENT_TOMBSTONED');
                        const batch = tombstoneIndex < 0 ? candidate : candidate.slice(0, tombstoneIndex + 1);
                        await storeIncomingBatch(batch, tx, context);
                        offset += batch.length;
                        for (const event of batch) {
                            // Cache the event ID
                            cacheEventId(event.id);

                            if (event.entityId) affectedEntityIds.add(event.entityId);

                            // Handle tombstone events
                            if (event.type === 'EVENT_TOMBSTONED') {
                                const tombstonePayload = event.payload as { eventId: string };
                                const tombstoneEvent = {
                                    ...event,
                                    payload: tombstonePayload
                                } as unknown as TombstoneEvent;
                                const targetEntityId = await applyTombstoneAndGetEntityId(tombstoneEvent, tx, context);
                                if (targetEntityId) affectedEntityIds.add(targetEntityId);
                            }
                        }
                    }
                    if (!hasDdl) {
                        await projectAffectedEntities(affectedEntityIds, tx, context);
                    }
                });
            });
        }

        if (hasDdl) await rebuildReadModel();

        // Update version tracker for ALL events (cached and uncached need version updates)
        await withTiming('db', 'updateVersionTracker', async () => {
            await versionTracker.updateVersionsFromEvents(storedEvents);
        });

        await recordIngestedProgress(readModelDB, context, storedEvents.map(event => event.version));

        console.log(`[Event] handleIncomingStoredEvents completed: ${uncachedEvents.length} inserted, ${cachedEvents.length} skipped`);
        return { hasNewEvents: uncachedEvents.length > 0, newCount: uncachedEvents.length };
    });
}
