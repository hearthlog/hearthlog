import { db, requireActiveContext, type ActiveContext, type Database } from '../db/index.js';
import { projectEntityById } from '../event/handlers.js';
import type { Kysely, Transaction } from 'kysely';
import { withoutClashes, type EntityClash } from './conflict-merge.js';

export interface SyncIssueEvent {
    id: string;
    type: string;
    entityId: string | null;
    timestamp: number;
    projectionState: string;
}

export interface SyncIssueHistoryEntry {
    action: string;
    details: string | null;
    createdAt: string;
}

export interface SyncIssue {
    operationId: string;
    batchId: string;
    status: string;
    retryCount: number;
    rebaseCount: number;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
    events: SyncIssueEvent[];
    affectedEntities: string[];
    history: SyncIssueHistoryEntry[];
    /** Edits that clash with another device's, for a person to choose between. */
    conflicts: EntityClash[];
    canRebase: boolean;
    canReapply: boolean;
}

interface ResolutionDependencies {
    database?: Kysely<Database>;
    context?: ActiveContext;
}

export async function getSyncIssues(
    dependencies: ResolutionDependencies = {},
): Promise<SyncIssue[]> {
    const database = dependencies.database ?? db;
    const context = dependencies.context ?? await requireActiveContext();
    const operations = await database.selectFrom('outbox_operations')
        .selectAll()
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('status', '=', 'needs_attention')
        .orderBy('updated_at', 'desc')
        .execute();

    return Promise.all(operations.map(async (operation) => {
        const [rows, history] = await Promise.all([
            database.selectFrom('raw_events')
                .select(['id', 'type', 'entity_id', 'timestamp', 'projection_state'])
                .where('tenant_id', '=', context.tenantId)
                .where('log_id', '=', context.logId)
                .where('local_batch_id', '=', operation.batch_id)
                .orderBy('local_sequence', 'asc')
                .execute(),
            database.selectFrom('resolution_actions')
                .select(['action', 'details', 'created_at'])
                .where('tenant_id', '=', context.tenantId)
                .where('log_id', '=', context.logId)
                .where('batch_id', '=', operation.batch_id)
                .orderBy('created_at', 'desc')
                .execute(),
        ]);
        const events = rows.map((row) => ({
            id: row.id,
            type: row.type,
            entityId: row.entity_id,
            timestamp: row.timestamp,
            projectionState: row.projection_state,
        }));
        const hasMetaEvent = events.some((event) => event.type.startsWith('ENTITY_TYPE_'));

        return {
            operationId: operation.id,
            batchId: operation.batch_id,
            status: operation.status,
            retryCount: operation.retry_count,
            rebaseCount: operation.rebase_count,
            errorCode: operation.last_error_code,
            errorMessage: operation.last_error_message,
            createdAt: operation.created_at,
            updatedAt: operation.updated_at,
            events,
            affectedEntities: [...new Set(events.flatMap((event) =>
                event.entityId ? [event.entityId] : []
            ))],
            history: history.map((entry) => ({
                action: entry.action,
                details: entry.details,
                createdAt: entry.created_at,
            })),
            conflicts: operation.last_error_code === 'edit_conflict'
                ? recordedClashesFrom(history.map((entry) => ({ action: entry.action, details: entry.details })))
                : [],
            canRebase: events.some((event) => event.projectionState === 'effective'),
            canReapply: !hasMetaEvent && events.length > 0,
        };
    }));
}

/** The clashes recorded when a batch was parked, newest record first in `history`. */
function recordedClashesFrom(history: ReadonlyArray<{ action: string; details: string | null }>): EntityClash[] {
    const recorded = history.find((entry) => entry.action === 'conflict_detected');
    if (!recorded?.details) return [];
    try {
        const parsed = JSON.parse(recorded.details) as { clashes?: unknown };
        return Array.isArray(parsed.clashes) ? parsed.clashes as EntityClash[] : [];
    } catch {
        return [];
    }
}

export async function rebaseSyncIssue(
    operationId: string,
    dependencies: ResolutionDependencies = {},
): Promise<void> {
    const database = dependencies.database ?? db;
    const context = dependencies.context ?? await requireActiveContext();
    await database.transaction().execute(async (tx) => {
        const operation = await requireIssue(tx, context, operationId);
        const effective = await tx.selectFrom('raw_events')
            .select('id')
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('local_batch_id', '=', operation.batch_id)
            .where('projection_state', '=', 'effective')
            .executeTakeFirst();
        if (!effective) throw new Error('This rejected batch must be reapplied or discarded');

        await tx.updateTable('outbox_operations').set({
            status: 'superseded',
            next_retry_at: null,
            updated_at: new Date().toISOString(),
        }).where('id', '=', operation.id).execute();
        await tx.updateTable('local_batches').set({
            status: 'conflicted',
            updated_at: new Date().toISOString(),
        }).where('id', '=', operation.batch_id).execute();
        await tx.updateTable('raw_events').set({ sync_state: 'conflicted' })
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('local_batch_id', '=', operation.batch_id)
            .where('projection_state', '=', 'effective')
            .execute();
        await audit(tx, context, operation.batch_id, 'retry_rebase', {
            operationId,
            previousRetryCount: operation.retry_count,
            previousRebaseCount: operation.rebase_count,
        });
    });
}

export async function discardSyncIssue(
    operationId: string,
    dependencies: ResolutionDependencies = {},
): Promise<string[]> {
    const database = dependencies.database ?? db;
    const context = dependencies.context ?? await requireActiveContext();
    const affected = new Set<string>();

    await database.transaction().execute(async (tx) => {
        const operation = await requireIssue(tx, context, operationId);
        const rows = await issueRows(tx, context, operation.batch_id);
        collectAffected(rows, affected);
        await excludeBatch(tx, context, operation.id, operation.batch_id);
        await refreshTombstoneTargets(tx, context, rows, affected);
        await projectAffected(tx, context, affected);
        await audit(tx, context, operation.batch_id, 'discard_local', {
            operationId,
            affectedEntities: [...affected],
        });
    });

    return [...affected];
}

export async function reapplyLocalSyncIssue(
    operationId: string,
    dependencies: ResolutionDependencies = {},
): Promise<{ batchId: string | null; affectedEntities: string[] }> {
    return replaceIssueBatch(operationId, dependencies, 'reapply_local', (rows) => rows);
}

/**
 * Resolve a clash in the other device's favor: save the batch again without the
 * values that clashed. What did not clash is kept, as new events, and the
 * original batch stays in raw history as discarded.
 */
export async function useTheirsSyncIssue(
    operationId: string,
    dependencies: ResolutionDependencies = {},
): Promise<{ batchId: string | null; affectedEntities: string[] }> {
    return replaceIssueBatch(operationId, dependencies, 'use_theirs', async (rows, tx, context, batchId) => {
        const history = await tx.selectFrom('resolution_actions')
            .select(['action', 'details'])
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('batch_id', '=', batchId)
            .orderBy('created_at', 'desc')
            .execute();
        const clashes = recordedClashesFrom(history);
        if (clashes.length === 0) throw new Error('This change has no recorded conflict to resolve');
        return withoutClashes(rows, clashes);
    });
}

async function replaceIssueBatch(
    operationId: string,
    dependencies: ResolutionDependencies,
    action: 'reapply_local' | 'use_theirs',
    keep: (
        rows: IssueRow[],
        tx: Transaction<Database>,
        context: ActiveContext,
        batchId: string,
    ) => IssueRow[] | Promise<IssueRow[]>,
): Promise<{ batchId: string | null; affectedEntities: string[] }> {
    const database = dependencies.database ?? db;
    const context = dependencies.context ?? await requireActiveContext();
    const affected = new Set<string>();
    const replacementBatchId = `reapply:${crypto.randomUUID()}`;
    let replacedAny = false;

    await database.transaction().execute(async (tx) => {
        const operation = await requireIssue(tx, context, operationId);
        const rows = await issueRows(tx, context, operation.batch_id);
        if (rows.some((row) => row.type.startsWith('ENTITY_TYPE_'))) {
            throw new Error('Dynamic schema conflicts must be discarded and recreated');
        }
        const kept = await keep(rows, tx, context, operation.batch_id);
        collectAffected(rows, affected);
        await excludeBatch(tx, context, operation.id, operation.batch_id);
        await refreshTombstoneTargets(tx, context, rows, affected);

        const maxSequence = await tx.selectFrom('raw_events')
            .select((eb) => eb.fn.max('local_sequence').as('max_sequence'))
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .executeTakeFirst();
        let nextSequence = Number(maxSequence?.max_sequence ?? 0);
        const now = Date.now();

        // Nothing may be left to save once what clashed is given up.
        if (kept.length > 0) await tx.insertInto('local_batches').values({
            id: replacementBatchId,
            tenant_id: context.tenantId,
            log_id: context.logId,
            status: 'pending',
            replacement_for: operation.batch_id,
        }).execute();

        for (const [index, row] of kept.entries()) {
            const eventId = crypto.randomUUID();
            await tx.insertInto('raw_events').values({
                id: eventId,
                tenant_id: context.tenantId,
                log_id: context.logId,
                local_batch_id: replacementBatchId,
                local_sequence: ++nextSequence,
                type: row.type,
                timestamp: now + index,
                payload: row.payload,
                entity_id: row.entity_id,
                entity_version: null,
                log_version: null,
                sync_state: 'pending',
                projection_state: 'effective',
                rejection_code: null,
                rejection_detail: null,
                is_tombstoned: 0,
            }).execute();
            if (row.type === 'EVENT_TOMBSTONED') {
                const targetId = (JSON.parse(row.payload) as { eventId: string }).eventId;
                await tx.updateTable('raw_events').set({ is_tombstoned: 1 })
                    .where('tenant_id', '=', context.tenantId)
                    .where('log_id', '=', context.logId)
                    .where('id', '=', targetId)
                    .execute();
            }
        }

        await projectAffected(tx, context, affected);
        replacedAny = kept.length > 0;
        await audit(tx, context, operation.batch_id, action, {
            operationId,
            replacementBatchId: replacedAny ? replacementBatchId : null,
            affectedEntities: [...affected],
        });
    });

    return { batchId: replacedAny ? replacementBatchId : null, affectedEntities: [...affected] };
}

type IssueRow = Awaited<ReturnType<typeof issueRows>>[number];

async function requireIssue(
    tx: Transaction<Database>,
    context: ActiveContext,
    operationId: string,
) {
    return tx.selectFrom('outbox_operations').selectAll()
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('id', '=', operationId)
        .where('status', '=', 'needs_attention')
        .executeTakeFirstOrThrow();
}

async function issueRows(
    tx: Transaction<Database>,
    context: ActiveContext,
    batchId: string,
) {
    return tx.selectFrom('raw_events').selectAll()
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('local_batch_id', '=', batchId)
        .orderBy('local_sequence', 'asc')
        .execute();
}

function collectAffected(rows: IssueRow[], affected: Set<string>): void {
    rows.forEach((row) => {
        if (row.entity_id && !row.entity_id.startsWith('tombstone:')) {
            affected.add(row.entity_id);
        }
    });
}

async function excludeBatch(
    tx: Transaction<Database>,
    context: ActiveContext,
    operationId: string,
    batchId: string,
): Promise<void> {
    await tx.updateTable('raw_events').set({
        sync_state: 'discarded',
        projection_state: 'excluded',
    }).where('tenant_id', '=', context.tenantId)
      .where('log_id', '=', context.logId)
      .where('local_batch_id', '=', batchId).execute();
    await tx.updateTable('local_batches').set({
        status: 'discarded',
        updated_at: new Date().toISOString(),
    }).where('id', '=', batchId).execute();
    await tx.updateTable('outbox_operations').set({
        status: 'superseded',
        next_retry_at: null,
        updated_at: new Date().toISOString(),
    }).where('id', '=', operationId).execute();
}

async function refreshTombstoneTargets(
    tx: Transaction<Database>,
    context: ActiveContext,
    rows: IssueRow[],
    affected: Set<string>,
): Promise<void> {
    for (const row of rows.filter((item) => item.type === 'EVENT_TOMBSTONED')) {
        const targetId = (JSON.parse(row.payload) as { eventId: string }).eventId;
        const target = await tx.selectFrom('raw_events').select('entity_id')
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('id', '=', targetId).executeTakeFirst();
        await tx.updateTable('raw_events').set({ is_tombstoned: 0 })
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('id', '=', targetId).execute();
        if (target?.entity_id) affected.add(target.entity_id);
    }
}

async function projectAffected(
    tx: Transaction<Database>,
    context: ActiveContext,
    affected: Set<string>,
): Promise<void> {
    for (const entityId of affected) await projectEntityById(entityId, tx, context);
}

async function audit(
    tx: Transaction<Database>,
    context: ActiveContext,
    batchId: string,
    action: string,
    details: Record<string, unknown>,
): Promise<void> {
    await tx.insertInto('resolution_actions').values({
        id: crypto.randomUUID(),
        tenant_id: context.tenantId,
        log_id: context.logId,
        batch_id: batchId,
        action,
        details: JSON.stringify(details),
    }).execute();
}
