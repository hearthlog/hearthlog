import { schemaTombstoneIds } from '../event/schema-effects.js';
import type { ActiveContext, Database } from '../db/index.js';
import { extractEntityId } from '../ledger/entity-id.js';
import type { ExtendedAppEvent } from '../event/types.js';
import { isMetaEntityEvent } from '../event/meta-entity-types.js';
import { reconcileRestoredEvents } from '../history/legacy-replay.js';
import { EVENTS_EXCISED, WORKSPACE_RESTORED } from '@hearthlog/contracts/history/replay-selection';
import type { Kysely, Transaction } from 'kysely';

export type ProjectEntity = (
    entityId: string,
    tx: Transaction<Database>,
    context: ActiveContext,
) => Promise<void>;

export interface LocalCommitInput {
    database: Kysely<Database>;
    context: ActiveContext;
    events: ExtendedAppEvent[];
    submissionId: string;
    projectEntity: ProjectEntity;
}

export interface LocalCommitResult {
    batchId: string;
    duplicate: boolean;
    eventIds: string[];
    pendingDdlEventIds: string[];
}

/** A submission identity was reused for different content. */
export class SubmissionMismatchError extends Error {
    constructor() {
        super('This action was already saved with different values. Reopen it to make another change.');
        this.name = 'SubmissionMismatchError';
    }
}

/** What a retry must repeat exactly: each event's type and payload, in order. */
export function submissionContent(
    events: ReadonlyArray<{ type: string; payload: unknown }>,
): string {
    return JSON.stringify(events.map((event) => [event.type, event.payload]));
}

export function localBatchId(
    context: Pick<ActiveContext, 'tenantId' | 'logId'>,
    submissionId: string,
): string {
    return `local:${context.tenantId}:${context.logId}:${submissionId}`;
}

export async function commitLocalEventBatch(
    input: LocalCommitInput,
): Promise<LocalCommitResult> {
    const { database, context, events, submissionId, projectEntity } = input;
    const batchId = localBatchId(context, submissionId);
    let eventIds = events.map((event) => event.id);
    let pendingDdlEventIds = events
        .filter(isMetaEntityEvent)
        .map((event) => event.id);
    let duplicate = false;

    await database.transaction().execute(async (tx) => {
        const existingBatch = await tx
            .selectFrom('local_batches')
            .select('id')
            .where('id', '=', batchId)
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .executeTakeFirst();

        if (existingBatch) {
            const persisted = await tx.selectFrom('raw_events')
                .select(['id', 'type', 'payload', 'projection_state'])
                .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId)
                .where('local_batch_id', '=', batchId).orderBy('local_sequence').execute();
            const recorded = persisted.map((event) => ({ type: event.type, payload: JSON.parse(event.payload) as unknown }));
            if (submissionContent(recorded) !== submissionContent(events)) throw new SubmissionMismatchError();
            eventIds = persisted.map(event => event.id);
            pendingDdlEventIds = persisted.filter(event => event.projection_state === 'pending_ddl').map(event => event.id);
            duplicate = true;
            return;
        }

        const schemaUndos = await schemaTombstoneIds(tx, context, events);
        pendingDdlEventIds.push(...schemaUndos);

        const maxSequence = await tx
            .selectFrom('raw_events')
            .select((eb) => eb.fn.max('local_sequence').as('max_sequence'))
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .executeTakeFirst();
        let nextSequence = Number(maxSequence?.max_sequence ?? 0);
        const affectedEntityIds = new Set<string>();
        let replayMembershipChanged = false;

        await tx.insertInto('local_batches').values({
            id: batchId,
            tenant_id: context.tenantId,
            log_id: context.logId,
            status: 'pending',
            replacement_for: null,
        }).execute();

        for (const event of events) {
            const entityId = extractEntityId(event);
            const pendingDdl = isMetaEntityEvent(event) || schemaUndos.has(event.id);

            await tx.insertInto('raw_events').values({
                id: event.id,
                tenant_id: context.tenantId,
                log_id: context.logId,
                local_batch_id: batchId,
                local_sequence: ++nextSequence,
                type: event.type,
                timestamp: event.timestamp,
                payload: JSON.stringify(event.payload),
                entity_id: entityId,
                entity_version: null,
                log_version: null,
                sync_state: 'pending',
                projection_state: pendingDdl ? 'pending_ddl' : 'effective',
                rejection_code: null,
                rejection_detail: null,
                is_tombstoned: 0,
            }).execute();

            if (entityId) affectedEntityIds.add(entityId);

            if (event.type === 'EVENT_TOMBSTONED') {
                const targetEventId = (event.payload as { eventId: string }).eventId;
                const target = await tx.selectFrom('raw_events')
                    .select(['entity_id', 'type', 'payload'])
                    .where('tenant_id', '=', context.tenantId)
                    .where('log_id', '=', context.logId)
                    .where('id', '=', targetEventId)
                    .executeTakeFirst();

                if (target) {
                    await tx.updateTable('raw_events')
                        .set({ is_tombstoned: 1 })
                        .where('tenant_id', '=', context.tenantId)
                        .where('log_id', '=', context.logId)
                        .where('id', '=', targetEventId)
                        .execute();
                    if (target.entity_id) affectedEntityIds.add(target.entity_id);
                    // Undoing an excision or a restore changes replay
                    // membership; recompute it and reproject the events the
                    // directive had excluded.
                    if (target.type === EVENTS_EXCISED || target.type === WORKSPACE_RESTORED) {
                        replayMembershipChanged = true;
                        await collectDirectiveTargetEntities(tx, context, target.type, target.payload, affectedEntityIds);
                    }
                }
            }

            if (event.type === EVENTS_EXCISED) {
                replayMembershipChanged = true;
                await collectDirectiveTargetEntities(tx, context, event.type, JSON.stringify(event.payload), affectedEntityIds);
            }
        }

        if (replayMembershipChanged) {
            // Membership is derived, not incremental: one pass recomputes
            // projection_state/is_tombstoned for the whole scope so excision
            // and revive stay exact.
            await reconcileRestoredEvents(tx, context);
        }

        for (const entityId of affectedEntityIds) {
            await projectEntity(entityId, tx, context);
        }
    });

    return {
        batchId,
        duplicate,
        eventIds,
        pendingDdlEventIds,
    };
}

/** Entities whose events are hidden or revealed by a replay directive. */
async function collectDirectiveTargetEntities(
    tx: Transaction<Database>,
    context: ActiveContext,
    type: string,
    payload: string,
    affectedEntityIds: Set<string>,
): Promise<void> {
    if (type === WORKSPACE_RESTORED) return;
    if (type !== EVENTS_EXCISED) return;
    let eventIds: string[] = [];
    try {
        const parsed = JSON.parse(payload) as { eventIds?: unknown };
        if (Array.isArray(parsed.eventIds)) {
            eventIds = parsed.eventIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
        }
    } catch {
        return;
    }
    if (eventIds.length === 0) return;
    const rows = await tx.selectFrom('raw_events')
        .select('entity_id')
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('id', 'in', eventIds)
        .execute();
    for (const row of rows) {
        if (row.entity_id) affectedEntityIds.add(row.entity_id);
    }
}
