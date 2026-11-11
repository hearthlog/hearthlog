import { baselineVersion, directivesReachBehind, loadArchivedHistory, REPLAY_DIRECTIVES } from '../history/baseline.js';
import { hasReplayDirectives } from '../history/legacy-replay.js';
import { EVENTS_EXCISED, WORKSPACE_RESTORED } from '@hearthlog/contracts/history/replay-selection';
import { recordIngestedProgress } from '../store/sync-progress.js';
import { writeEntityVersions } from '../ledger/version-tracker.js';
import { indexIngestedActions, markHistoryIndexStale } from '../history/action-index.js';
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
import { versionTracker, rebuildReadModel, forgetProjections } from './rebuild.js';
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

/**
 * Downloaded events carry this batch id: a short constant instead of one id per event, so the batch index takes
 * sequential appends and no `local_batches` row is created per event. Local batches keep their own ids.
 */
export const SERVER_BATCH_ID = 'server';
/** A whole download page is written by one statement; tombstones still split it (see below). */
const EVENT_WRITE_BATCH_SIZE = 512;
const PROJECTION_BATCH_SIZE = 100;

async function storeIncomingBatch(
    events: readonly StoredEvent[],
    tx: Transaction<Database>,
    context: ActiveContext,
): Promise<void> {
    // One statement for the whole batch: the rows travel as one JSON array, and payloads as the exact text
    // stored before (never re-serialized by SQLite).
    const rows = JSON.stringify(events.map(event => ({
        id: event.id,
        version: event.version,
        actionId: event.action?.id ?? null,
        actionIndex: event.action?.index ?? null,
        actionSize: event.action?.size ?? null,
        actor: event.actor ?? null,
        type: event.type,
        timestamp: event.timestamp,
        payload: JSON.stringify(event.payload),
        entityId: event.entityId,
        entityVersion: event.entityVersion,
    })));
    await sql`
        INSERT INTO raw_events (id, tenant_id, log_id, local_batch_id, local_sequence, action_id, action_index,
            action_size, actor, type, timestamp, payload, entity_id, entity_version, log_version, sync_state,
            projection_state, rejection_code, rejection_detail, is_tombstoned)
        SELECT json_extract(value, '$.id'), ${context.tenantId}, ${context.logId}, ${SERVER_BATCH_ID},
            json_extract(value, '$.version'), json_extract(value, '$.actionId'), json_extract(value, '$.actionIndex'),
            json_extract(value, '$.actionSize'), json_extract(value, '$.actor'), json_extract(value, '$.type'),
            json_extract(value, '$.timestamp'), json_extract(value, '$.payload'), json_extract(value, '$.entityId'),
            json_extract(value, '$.entityVersion'), json_extract(value, '$.version'), 'synced', 'effective', NULL, NULL, 0
        FROM json_each(${rows}) WHERE true
        ON CONFLICT (tenant_id, log_id, id) DO UPDATE SET
            log_version = excluded.log_version,
            action_id = COALESCE(excluded.action_id, raw_events.action_id),
            action_index = CASE WHEN excluded.action_id IS NOT NULL THEN excluded.action_index ELSE raw_events.action_index END,
            action_size = CASE WHEN excluded.action_id IS NOT NULL THEN excluded.action_size ELSE raw_events.action_size END,
            actor = CASE WHEN excluded.actor IS NOT NULL AND excluded.actor <> '' THEN excluded.actor ELSE raw_events.actor END,
            entity_version = excluded.entity_version,
            entity_id = excluded.entity_id,
            sync_state = 'synced',
            -- Never rewrite payloads/local batch identities or revive hidden history.
            projection_state = CASE WHEN raw_events.projection_state = 'restored_out' THEN 'restored_out' ELSE 'effective' END,
            rejection_code = NULL,
            rejection_detail = NULL
    `.execute(tx);

    // An accepted event of this device's own batch updates that batch's status, derived from all its events, not
    // just this page. Downloaded events have no batch row to update. CROSS JOIN keeps the event ids as the outer
    // loop, so each is a primary-key lookup.
    await sql`
        UPDATE local_batches SET
            status = CASE WHEN EXISTS (
                SELECT 1 FROM raw_events pending
                WHERE pending.tenant_id = local_batches.tenant_id
                  AND pending.log_id = local_batches.log_id
                  AND pending.local_batch_id = local_batches.id
                  AND pending.log_version IS NULL
            ) THEN 'pending' ELSE 'synced' END,
            updated_at = ${new Date().toISOString()}
        WHERE tenant_id = ${context.tenantId} AND log_id = ${context.logId}
          AND id IN (
            SELECT DISTINCT accepted.local_batch_id
            FROM json_each(${JSON.stringify(events.map(event => event.id))}) AS wanted
            CROSS JOIN raw_events accepted
            WHERE accepted.tenant_id = ${context.tenantId}
              AND accepted.log_id = ${context.logId}
              AND accepted.id = wanted.value
              AND accepted.local_batch_id <> ${SERVER_BATCH_ID}
          )
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
        await forgetProjections(context);
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
        await markHistoryIndexStale((query) => query.execute(tx), context);
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
 * Whether these events only acknowledge this device's own uploads, already projected while they waited, with no other
 * device's events in between. Waiting events project ahead of accepted ones, and with nothing accepted in between
 * the order (and so every projected value) is the same after they are accepted, so they need no reprojection.
 */
async function acknowledgesProjectedEvents(
    context: ActiveContext,
    events: readonly StoredEvent[],
    existing: ReadonlyArray<{ id: string; log_version: number | null }>,
): Promise<boolean> {
    if (events.length === 0 || existing.length !== events.length) return false;
    if (existing.some(row => row.log_version !== null)) return false;
    if (events.some((event, index) => event.type === 'EVENT_TOMBSTONED' || event.version !== events[0]!.version + index)) return false;
    const progress = await readModelDB.selectFrom('log_sync_state').select('projected_head_version')
        .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId).executeTakeFirst();
    return (progress?.projected_head_version ?? 0) === events[0]!.version - 1;
}

/**
 * Handles incoming StoredEvents from the Ledger Service (via HTTP or WebSocket).
 * Preserves server-assigned entity versions.
 * @returns Object indicating whether new events were processed (vs just metadata updates)
 */
export interface IngestOptions {
    /** Runs inside the transaction that stores the events, e.g. marking the upload that produced them as synced. */
    inTransaction?: (tx: Transaction<Database>) => Promise<void>;
}

export async function handleIncomingStoredEvents(
    storedEvents: StoredEvent[],
    options: IngestOptions = {},
): Promise<{ hasNewEvents: boolean; newCount: number }> {
    console.log(
        '[Event] handleIncomingStoredEvents called with',
        storedEvents.length,
        'events'
    );

    if (storedEvents.length === 0) {
        if (options.inTransaction) await readModelDB.transaction().execute(options.inTransaction);
        return { hasNewEvents: false, newCount: 0 };
    }

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
                await indexIngestedActions((query) => query.execute(tx), context, covered);
                if (covered.length === storedEvents.length) await options.inTransaction?.(tx);
            });
            if (covered.length === storedEvents.length) return { hasNewEvents: true, newCount: 0 };
            storedEvents = storedEvents.filter(event => event.version > coveredThrough);
        }

        const existingRows = await readModelDB.selectFrom('raw_events')
            .select(['id', 'log_version'])
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
        const projectionCurrent = !hasDdl && await acknowledgesProjectedEvents(context, storedEvents, existingRows);

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
                    if (!hasDdl && !projectionCurrent) {
                        await projectAffectedEntities(affectedEntityIds, tx, context);
                    }
                    await indexIngestedActions((query) => query.execute(tx), context, storedEvents);
                    // Ordinary pages commit their versions and progress with the events, in this one transaction.
                    if (!hasDdl) {
                        await writeEntityVersions(tx, context, storedEvents);
                        await recordIngestedProgress(tx, context, storedEvents.map(event => event.version));
                    }
                    await options.inTransaction?.(tx);
                });
            });
        }

        if (hasDdl) {
            await rebuildReadModel();
            await versionTracker.updateVersionsFromEvents(storedEvents);
            await recordIngestedProgress(readModelDB, context, storedEvents.map(event => event.version));
        }

        console.log(`[Event] handleIncomingStoredEvents completed: ${uncachedEvents.length} inserted, ${cachedEvents.length} skipped`);
        return { hasNewEvents: uncachedEvents.length > 0, newCount: uncachedEvents.length };
    });
}
