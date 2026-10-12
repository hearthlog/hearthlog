import { db, requireActiveContext } from '../db/index.js';
import {
    applyMetaEvents,
    cacheEventId,
    projectEntityById,
} from '../event/handlers.js';
import { schemaTombstoneIds } from '../event/schema-effects.js';
import type {
    ExtendedAppEvent,
} from '../event/types.js';
import { commitLocalEventBatch, SubmissionMismatchError, submissionContent } from './local-commit.js';
import { validateCommandEvents } from './validation.js';

export { CommandValidationError, validateCommandEvents } from './validation.js';
export { commitLocalEventBatch, localBatchId, SubmissionMismatchError } from './local-commit.js';

export interface LocalCommandOptions {
    submissionId?: string;
}

export interface LocalCommandResult {
    batchId: string;
    duplicate: boolean;
    eventIds: string[];
    projectionPending: boolean;
}

type CommitListener = (result: LocalCommandResult) => void | Promise<void>;

const commitListeners = new Set<CommitListener>();
const inFlightCommands = new Map<string, { content: string; execution: Promise<LocalCommandResult> }>();

export function onLocalCommandCommitted(listener: CommitListener): () => void {
    commitListeners.add(listener);
    return () => commitListeners.delete(listener);
}

export async function executeLocalCommand(
    eventOrEvents: ExtendedAppEvent | ExtendedAppEvent[],
    options: LocalCommandOptions = {},
): Promise<LocalCommandResult> {
    const events = Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents];
    validateCommandEvents(events);

    const context = await requireActiveContext();
    const submissionId = options.submissionId ?? events.map((event) => event.id).join(':');
    const inFlightKey = JSON.stringify([context.tenantId, context.logId, submissionId]);
    const content = submissionContent(events);
    const existing = inFlightCommands.get(inFlightKey);
    if (existing) {
        if (existing.content !== content) throw new SubmissionMismatchError();
        return existing.execution;
    }

    const execution = execute(events, submissionId, context);
    inFlightCommands.set(inFlightKey, { content, execution });
    try {
        return await execution;
    } finally {
        inFlightCommands.delete(inFlightKey);
    }
}

const BUSY_RETRY_DELAYS_MS = [50, 100, 200, 400];

/**
 * Another tab may hold the database's write lock (a rebuild, an ingestion).
 * A commit is atomic and its submission identity makes a repeat harmless, so
 * a busy answer waits briefly and tries again.
 */
export async function withBusyRetry<T>(
    task: () => Promise<T>,
    delaysMs: readonly number[] = BUSY_RETRY_DELAYS_MS,
    wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await task();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const delay = delaysMs[attempt];
            if (delay === undefined || !/database is locked|SQLITE_BUSY/i.test(message)) throw error;
            await wait(delay);
        }
    }
}

async function execute(
    events: ExtendedAppEvent[],
    submissionId: string,
    context: Awaited<ReturnType<typeof requireActiveContext>>,
): Promise<LocalCommandResult> {
    const committed = await withBusyRetry(() => commitLocalEventBatch({
        database: db,
        context,
        events,
        submissionId,
        projectEntity: projectEntityById,
    }));

    let projectionPending = committed.pendingDdlEventIds.length > 0;
    if (!committed.duplicate) {
        committed.eventIds.forEach(cacheEventId);
        if (committed.pendingDdlEventIds.length > 0) {
            projectionPending = !(await applyPendingDdlEvents(events, context));
        }
    }

    const result: LocalCommandResult = {
        batchId: committed.batchId,
        duplicate: committed.duplicate,
        eventIds: committed.eventIds,
        projectionPending,
    };

    if (!committed.duplicate) await notifyCommitted(result);
    return result;
}

async function applyPendingDdlEvents(
    events: ExtendedAppEvent[],
    context: Awaited<ReturnType<typeof requireActiveContext>>,
): Promise<boolean> {
    const metaEvents = events.filter((event) =>
        event.type === 'ENTITY_TYPE_DEFINED' ||
        event.type === 'ENTITY_TYPE_UPDATED' ||
        event.type === 'ENTITY_TYPE_ARCHIVED'
    );
    const schemaUndos = await schemaTombstoneIds(db, context, events);
    if (metaEvents.length === 0 && schemaUndos.size === 0) return true;

    try {
        if (schemaUndos.size > 0) {
            const { rebuildReadModel } = await import('../event/rebuild.js');
            await rebuildReadModel({ includePendingDdl: true });
        } else {
            await applyMetaEvents(metaEvents);
        }
        await db.updateTable('raw_events')
            .set({ projection_state: 'effective' })
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('id', 'in', [...metaEvents.map(event => event.id), ...schemaUndos])
            .execute();
        return true;
    } catch (error) {
        console.error('[Command] Dynamic schema projection remains pending', error);
        return false;
    }
}

export async function retryPendingCommandProjections(): Promise<number> {
    const context = await requireActiveContext();
    const rows = await db.selectFrom('raw_events')
        .select(['id', 'type', 'timestamp', 'payload'])
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('projection_state', '=', 'pending_ddl')
        .orderBy('local_sequence', 'asc')
        .execute();
    let completed = 0;

    for (const row of rows) {
        const event = {
            id: row.id,
            type: row.type,
            timestamp: row.timestamp,
            payload: JSON.parse(row.payload),
        } as ExtendedAppEvent;
        if (await applyPendingDdlEvents([event], context)) completed++;
    }

    return completed;
}

async function notifyCommitted(result: LocalCommandResult): Promise<void> {
    for (const listener of commitListeners) {
        try {
            await listener(result);
        } catch (error) {
            console.error('[Command] Post-commit listener failed', error);
        }
    }
}
