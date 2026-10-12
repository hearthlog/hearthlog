import { db, requireActiveContext } from '../db/index.js';
import type { AppendEventsRequest, StoredEvent } from '../ledger/index.js';
import {
    hashRequest,
    type PendingBatchEvent,
} from './outbox-request.js';
import { computeRetryDeadline } from './sync-coordinator.js';
import { describeClashes, type EntityClash, type EntityEdit } from './conflict-merge.js';

export { hashRequest, MAX_BATCH_SIZE, prepareAppendRequest } from './outbox-request.js';
export type { PendingBatchEvent } from './outbox-request.js';

export type OutboxStatus = 'pending' | 'syncing' | 'failed' | 'needs_attention' | 'superseded';

export interface OutboxEvent {
    id: string;
    eventId: string;
    status: OutboxStatus;
    retryCount: number;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface DurableOperation {
    id: string;
    requestId: string;
    batchId: string;
    request: AppendEventsRequest;
    requestHash: string;
    status: OutboxStatus;
    retryCount: number;
    rebaseCount: number;
    nextRetryAt: string | null;
}

export async function getPendingCount(): Promise<number> {
    const context = await requireActiveContext();
    const result = await db.selectFrom('local_batches')
        .select((eb) => eb.fn.count('id').as('count'))
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('status', 'in', ['pending', 'conflicted'])
        .executeTakeFirst();
    return Number(result?.count ?? 0);
}

export async function getReadyOperation(): Promise<DurableOperation | null> {
    const context = await requireActiveContext();
    const row = await db.selectFrom('outbox_operations')
        .selectAll()
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('status', 'in', ['pending', 'syncing', 'failed'])
        .where((eb) => eb.or([
            eb('next_retry_at', 'is', null),
            eb('next_retry_at', '<=', new Date().toISOString()),
        ]))
        .orderBy('created_at', 'asc')
        .executeTakeFirst();
    if (!row) return null;
    return {
        id: row.id,
        requestId: row.request_id,
        batchId: row.batch_id,
        request: JSON.parse(row.request_body) as AppendEventsRequest,
        requestHash: row.request_hash,
        status: row.status as OutboxStatus,
        retryCount: row.retry_count,
        rebaseCount: row.rebase_count,
        nextRetryAt: row.next_retry_at,
    };
}

/** Every request of this tenant that no Ledger has acknowledged, oldest first, exactly as queued. */
export async function listUnsyncedOperations(): Promise<Array<{ logId: string; request: AppendEventsRequest; status: string; createdAt: string }>> {
    const context = await requireActiveContext();
    const rows = await db.selectFrom('outbox_operations')
        .select(['log_id', 'request_body', 'status', 'created_at'])
        .where('tenant_id', '=', context.tenantId)
        .where('status', 'in', ['pending', 'syncing', 'failed', 'needs_attention'])
        .orderBy('created_at', 'asc')
        .execute();
    return rows.map((row) => ({
        logId: row.log_id,
        request: JSON.parse(row.request_body) as AppendEventsRequest,
        status: row.status,
        createdAt: row.created_at,
    }));
}

export async function getNextPendingBatch(): Promise<{ id: string; events: PendingBatchEvent[] } | null> {
    const context = await requireActiveContext();
    const batches = await db.selectFrom('local_batches')
        .select(['id'])
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('status', 'in', ['pending', 'conflicted'])
        .orderBy('created_at', 'asc')
        .execute();

    for (const batch of batches) {
        const existing = await db.selectFrom('outbox_operations')
            .select('id')
            .where('batch_id', '=', batch.id)
            .where('status', 'in', ['pending', 'syncing', 'failed', 'needs_attention'])
            .executeTakeFirst();
        if (existing) continue;

        const rows = await db.selectFrom('raw_events')
            .select(['id', 'type', 'timestamp', 'entity_id', 'payload', 'local_sequence'])
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('local_batch_id', '=', batch.id)
            .where('sync_state', 'in', ['pending', 'conflicted'])
            .where('projection_state', '=', 'effective')
            .orderBy('local_sequence', 'asc')
            .execute();
        if (rows.length === 0) continue;
        return {
            id: batch.id,
            events: rows.map((row) => ({
                id: row.id,
                type: row.type,
                timestamp: row.timestamp,
                entityId: row.entity_id ?? '',
                payload: JSON.parse(row.payload) as Record<string, unknown>,
                localSequence: row.local_sequence,
            })),
        };
    }
    return null;
}

export async function persistOperation(
    batchId: string,
    request: AppendEventsRequest,
    rebaseCount = 0,
    expectedScope?: { tenantId: string; logId: string },
): Promise<DurableOperation> {
    const context = await requireActiveContext();
    if (expectedScope && (context.tenantId !== expectedScope.tenantId || context.logId !== expectedScope.logId)) {
        throw new Error('The selected log changed. Preview the restore again.');
    }
    const id = crypto.randomUUID();
    const requestHash = await hashRequest(request);
    const requestBody = JSON.stringify(request);
    await db.transaction().execute(async (tx) => {
        if (request.events.some(event => event.type === 'WORKSPACE_RESTORED')) {
            if (request.events.length !== 1 || request.expectedLogVersion === undefined || !request.actionId || !expectedScope) {
                throw new Error('A restore requires a scoped, complete preview');
            }
            const pending = await tx.selectFrom('raw_events').select('id')
                .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId)
                .where('log_version', 'is', null).where('sync_state', 'in', ['pending', 'conflicted']).executeTakeFirst();
            const progress = await tx.selectFrom('log_sync_state').select('projected_head_version')
                .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId).executeTakeFirst();
            if (pending || progress?.projected_head_version !== request.expectedLogVersion) throw new Error('The log changed. Preview the restore again.');
            const sequence = await tx.selectFrom('raw_events').select(eb => eb.fn.max('local_sequence').as('last'))
                .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId).executeTakeFirst();
            const event = request.events[0]!;
            await tx.insertInto('local_batches').values({ id: batchId, tenant_id: context.tenantId, log_id: context.logId,
                status: 'pending', replacement_for: null }).execute();
            await tx.insertInto('raw_events').values({ id: event.id!, tenant_id: context.tenantId, log_id: context.logId,
                local_batch_id: batchId, local_sequence: Number(sequence?.last ?? 0) + 1,
                type: event.type, timestamp: event.timestamp!, payload: JSON.stringify(event.payload), entity_id: event.entityId,
                entity_version: null, log_version: null, sync_state: 'pending', projection_state: 'pending_restore',
                rejection_code: null, rejection_detail: null, is_tombstoned: 0 }).execute();
        }
        await tx.insertInto('outbox_operations').values({
            id,
            request_id: request.requestId,
            tenant_id: context.tenantId,
            log_id: context.logId,
            batch_id: batchId,
            request_body: requestBody,
            request_hash: requestHash,
            status: 'pending',
            retry_count: 0,
            rebase_count: rebaseCount,
            last_error_code: null,
            last_error_message: null,
            superseded_by: null,
            next_retry_at: null,
        }).execute();
        await tx.insertInto('outbox_operation_items').values(
            request.events.map((event, ordinal) => ({
                operation_id: id,
                event_id: event.id as string,
                ordinal,
            })),
        ).execute();
    });
    return {
        id,
        requestId: request.requestId,
        batchId,
        request,
        requestHash,
        status: 'pending',
        retryCount: 0,
        rebaseCount,
        nextRetryAt: null,
    };
}

export async function markOperationSyncing(operationId: string): Promise<void> {
    const context = await requireActiveContext();
    await db.updateTable('outbox_operations').set({
        status: 'syncing',
        next_retry_at: null,
        updated_at: new Date().toISOString(),
    })
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('id', '=', operationId).execute();
}

export async function markOperationSynced(operation: DurableOperation, storedEvents: StoredEvent[]): Promise<void> {
    const context = await requireActiveContext();
    await db.transaction().execute(async (tx) => {
        for (const event of storedEvents) {
            await tx.updateTable('raw_events').set({
                entity_id: event.entityId,
                entity_version: event.entityVersion,
                log_version: event.version,
                sync_state: 'synced',
                rejection_code: null,
                rejection_detail: null,
            }).where('tenant_id', '=', context.tenantId)
              .where('log_id', '=', context.logId)
              .where('id', '=', event.id).execute();
        }
        await tx.updateTable('local_batches').set({ status: 'synced', updated_at: new Date().toISOString() })
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('id', '=', operation.batchId).execute();
        await tx.updateTable('outbox_operations').set({
            status: 'synced',
            next_retry_at: null,
            updated_at: new Date().toISOString(),
        })
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('id', '=', operation.id).execute();
    });
}

export async function markOperationFailed(
    operation: DurableOperation,
    code: string,
    message: string,
    needsAttention = false,
    now = Date.now(),
    random = Math.random,
): Promise<void> {
    // Retryable failures never park: the count only drives the capped backoff.
    const context = await requireActiveContext();
    const retryCount = operation.retryCount + 1;
    const terminal = needsAttention;
    await db.updateTable('outbox_operations').set({
        status: terminal ? 'needs_attention' : 'failed',
        retry_count: retryCount,
        next_retry_at: terminal
            ? null
            : computeRetryDeadline(retryCount, now, random).toISOString(),
        last_error_code: code,
        last_error_message: message,
        updated_at: new Date().toISOString(),
    })
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('id', '=', operation.id).execute();
}

export async function getNextRetryAt(): Promise<Date | null> {
    const context = await requireActiveContext();
    const row = await db.selectFrom('outbox_operations')
        .select('next_retry_at')
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('status', '=', 'failed')
        .where('next_retry_at', 'is not', null)
        .orderBy('next_retry_at', 'asc')
        .executeTakeFirst();
    return row?.next_retry_at ? new Date(row.next_retry_at) : null;
}

export async function supersedeOperation(operation: DurableOperation): Promise<void> {
    const context = await requireActiveContext();
    // Both rows move together: a superseded operation always leaves its batch
    // conflicted, ready for one rebased operation.
    await db.transaction().execute(async (tx) => {
        await tx.updateTable('outbox_operations').set({
            status: 'superseded',
            next_retry_at: null,
            updated_at: new Date().toISOString(),
        })
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('id', '=', operation.id).execute();
        await tx.updateTable('local_batches').set({ status: 'conflicted', updated_at: new Date().toISOString() })
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('id', '=', operation.batchId).execute();
    });
}

export async function rejectBatch(operation: DurableOperation, code: string, message: string): Promise<void> {
    const context = await requireActiveContext();
    await db.transaction().execute(async (tx) => {
        await tx.updateTable('raw_events').set({
            sync_state: 'rejected',
            projection_state: 'excluded',
            rejection_code: code,
            rejection_detail: message,
        }).where('tenant_id', '=', context.tenantId)
          .where('log_id', '=', context.logId)
          .where('local_batch_id', '=', operation.batchId).execute();
        await tx.updateTable('local_batches').set({ status: 'rejected', updated_at: new Date().toISOString() })
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('id', '=', operation.batchId).execute();
        await tx.updateTable('outbox_operations').set({
            status: 'needs_attention', last_error_code: code,
            last_error_message: message, next_retry_at: null,
            updated_at: new Date().toISOString(),
        })
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('id', '=', operation.id).execute();
        await tx.insertInto('resolution_actions').values({
            id: crypto.randomUUID(), tenant_id: context.tenantId, log_id: context.logId,
            batch_id: operation.batchId, action: 'rejected', details: JSON.stringify({ code, message }),
        }).execute();
    });
}

export async function clearOutbox(): Promise<void> {
    const context = await requireActiveContext();
    await db.transaction().execute(async (tx) => {
        const operations = await tx.selectFrom('outbox_operations').select('id')
            .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId).execute();
        if (operations.length > 0) {
            await tx.deleteFrom('outbox_operation_items')
                .where('operation_id', 'in', operations.map((operation) => operation.id)).execute();
        }
        await tx.deleteFrom('outbox_operations')
            .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId).execute();
        await tx.updateTable('raw_events').set({ sync_state: 'discarded', projection_state: 'excluded' })
            .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId)
            .where('sync_state', 'in', ['pending', 'conflicted']).execute();
        await tx.updateTable('local_batches').set({ status: 'discarded', updated_at: new Date().toISOString() })
            .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId)
            .where('status', 'in', ['pending', 'conflicted']).execute();
    });
}

export async function getAllOutboxEvents(): Promise<OutboxEvent[]> {
    const context = await requireActiveContext();
    const rows = await db.selectFrom('outbox_operations').selectAll()
        .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId)
        .where('status', 'in', ['pending', 'syncing', 'failed', 'needs_attention'])
        .orderBy('created_at', 'asc').execute();
    return rows.map((row) => ({
        id: row.id,
        eventId: row.batch_id,
        status: row.status as OutboxStatus,
        retryCount: row.retry_count,
        lastError: row.last_error_message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }));
}

/**
 * Edits other devices had accepted for one record after the version a local
 * batch was based on, oldest first. Only accepted, effective events count.
 */
export async function getAcceptedEntityEdits(
    entityId: string,
    afterEntityVersion: number,
): Promise<EntityEdit[]> {
    const context = await requireActiveContext();
    const rows = await db.selectFrom('raw_events')
        .select(['type', 'payload'])
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('entity_id', '=', entityId)
        .where('entity_version', '>', afterEntityVersion)
        .where('log_version', 'is not', null)
        .where('projection_state', '=', 'effective')
        .where('is_tombstoned', '=', 0)
        .orderBy('entity_version', 'asc')
        .execute();
    return rows.map((row) => ({ type: row.type, payload: JSON.parse(row.payload) as Record<string, unknown> }));
}

/** Park a batch whose edits clash with another device's, keeping both sides for a person to choose. */
export async function parkOperationForConflict(
    operation: DurableOperation,
    clashes: readonly EntityClash[],
): Promise<void> {
    const context = await requireActiveContext();
    const message = describeClashes(clashes);
    await db.transaction().execute(async (tx) => {
        await tx.updateTable('outbox_operations').set({
            status: 'needs_attention',
            last_error_code: 'edit_conflict',
            last_error_message: message,
            next_retry_at: null,
            updated_at: new Date().toISOString(),
        })
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('id', '=', operation.id).execute();
        await tx.insertInto('resolution_actions').values({
            id: crypto.randomUUID(),
            tenant_id: context.tenantId,
            log_id: context.logId,
            batch_id: operation.batchId,
            action: 'conflict_detected',
            details: JSON.stringify({ clashes }),
        }).execute();
    });
}
