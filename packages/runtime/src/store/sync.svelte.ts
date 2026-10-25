import { baselineVersion, directivesReachBehind, installBaseline, REPLAY_DIRECTIVES } from '../history/baseline.js';
import { waitForPageUpdates } from '../runtime/page-data.svelte.js';
import { pageVisible } from '../runtime/visibility.js';
import { announceInvalidation } from '../runtime/invalidation.js';
import { measurementMetadata } from '../utils/perf.js';
import { invalidate } from '$app/navigation';
import { db, requireActiveContext } from '../db/index.js';
import {
    clearActiveProjections,
    handleIncomingStoredEvents,
    rebuildReadModel,
} from '../event/index.js';
import {
    AuthenticationError,
    EntityVersionChainError,
    IdempotencyMismatchError,
    getLedgerClient,
    LedgerServiceError,
    NotFoundError,
    VersionConflictError,
    loadLedgerConfig,
    type StoredEvent,
} from '../ledger/index.js';
import {
    AccessSessionExpiredError,
    requestAccessReauthentication,
} from '../access/session.js';
import { versionTracker } from '../ledger/version-tracker-singleton.js';
import { notifyEventsChanged } from './events.svelte.js';
import { markWorkspaceMoved, movedDestination, movedWorkspace } from './moved.svelte.js';
import { get as getKv, del as delKv } from '../db/kv.js';
import {
    getPendingCount,
    getNextRetryAt,
    getNextPendingBatch,
    getAcceptedEntityEdits,
    getReadyOperation,
    markOperationFailed,
    parkOperationForConflict,
    markOperationSynced,
    markOperationSyncing,
    persistOperation,
    prepareAppendRequest,
    rejectBatch,
    supersedeOperation,
    type DurableOperation,
    type PendingBatchEvent,
} from './outbox.js';
import {
    activateLogContext,
    deactivateLogContext,
    getActiveContext,
    getLedgerCacheKey,
} from './local-context.js';
import { activateCurrentReadTarget } from '../runtime/read-coordinator.js';
import { withTiming } from '../utils/perf.js';
import { deriveSyncPhase, type SyncPhase } from './sync-state.js';
import { refreshEntitySyncState } from './entity-sync-state.svelte.js';
import { onLocalCommandCommitted } from '../commands/index.js';
import {
    SerialTaskQueue,
    CoalescedTaskQueue,
    RETRY_BASE_DELAY_MS,
    classifyRealtimeVersion,
    isTransientSyncFailure,
    withExclusiveSyncLock,
    type SyncTrigger,
} from './sync-coordinator.js';
import { SYNC_INVALIDATION_TARGETS } from './sync-invalidation.js';
import { findClashes, type EntityClash } from './conflict-merge.js';
import {
    holdTabLock,
    onTabChange,
    postTabChange,
    realtimeLockName,
    scopeKey,
    syncCycleLockName,
    withTabLock,
    type TabChange,
    type TabChangeKind,
} from './tab-coordination.js';
import { loadDynamicEntityTypes } from '../event/dynamic-entities.js';
const UPLOAD_DEBOUNCE_MS = 100;
const REALTIME_INVALIDATION_DEBOUNCE_MS = 150;
const REALTIME_HEALTH_RECOVERY_MS = 5_000;

export type SyncLogType =
    | 'upload'
    | 'download'
    | 'ws_receive'
    | 'ws_ready'
    | 'ws_close'
    | 'ws_error'
    | 'ws_resync'
    | 'drain'
    | 'error';

export interface SyncLogEntry {
    id: string;
    timestamp: Date;
    type: SyncLogType;
    message: string;
    details?: string;
}

export const syncLog = $state<{ entries: SyncLogEntry[]; hasMore: boolean }>({
    entries: [],
    hasMore: false,
});

export let syncStatus = $state({
    isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
    isLedgerReachable: null as boolean | null,
    isSyncing: false,
    hasCompletedSync: false,
    hasError: false,
    /** The last failure was Ledger being unreachable; uploads keep retrying. */
    waitingForLedger: false,
    errorMessage: null as string | null,
    lastSyncedAt: null as Date | null,
    pendingUploads: 0,
    tenantId: null as string | null,
    logId: null as string | null,
    needsAttention: 0,
});

export function getSyncPhase(): SyncPhase {
    return deriveSyncPhase(syncStatus);
}

let catchUpRevision = 0;
let caughtUpScope: string | null = null;
let eventSocket: import('../ledger/socket.js').EventSocket | null = null;
let uploadDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
let syncInProgress = false;
let syncRequestedWhileRunning = false;
let synchronizationSuspended = false;
let syncIdleWaiters: Array<() => void> = [];
let retryWakeupTimeout: ReturnType<typeof setTimeout> | null = null;
let realtimeHealthTimeout: ReturnType<typeof setTimeout> | null = null;
let realtimeHealthy = false;
let realtimeStopRequested = false;
let accessProbeInFlight = false;
let suspendedForAccessExpiry = false;
const realtimeEventQueue = new SerialTaskQueue();
// One visible tab per log owns the live connection to Ledger. The others hold
// no socket: they hear about ingested events over the tab channel.
let realtimeLeaseKey: string | null = null;
let releaseRealtimeLeaseLock: (() => void) | null = null;
let realtimeLeaseAcquired = false;
let openingRealtime = false;
let realtimeGeneration = 0;
const pendingRealtimeEvents: StoredEvent[] = [];
const SYNC_LOG_PAGE_SIZE = 50;
/** The persisted sync log is a diagnostic trail, not history: keep the newest entries. */
const SYNC_LOG_RETAINED_ENTRIES = 1_000;

export { getLedgerClient };

async function getSelectedLogId(): Promise<string | null> {
    const selection = await getKv<{ logId: string }>(await getLedgerCacheKey('selected-log'));
    return selection?.logId || null;
}

async function ensureSelectedContext(): Promise<string> {
    // Prefer this tab's session context so another tab's log switch cannot redirect sync/writes.
    const active = await getActiveContext();
    if (active?.logId) {
        syncStatus.tenantId = active.tenantId;
        syncStatus.logId = active.logId;
        return active.logId;
    }

    const logId = await getSelectedLogId();
    if (!logId) throw new Error('No Ledger log selected');
    await activateLogContext(logId);
    const context = await requireActiveContext();
    syncStatus.tenantId = context.tenantId;
    syncStatus.logId = context.logId;
    return logId;
}

export const accessSessionState = $state({ expired: false });

function setSyncError(error: unknown): void {
    syncStatus.hasError = true;
    syncStatus.waitingForLedger = isTransientSyncFailure(error);
    accessSessionState.expired = error instanceof AccessSessionExpiredError;
    if (error instanceof AccessSessionExpiredError) {
        // Reauthentication is automatic when online: the page navigates to a
        // cache-busted app URL so the edge can render the Access login flow.
        // Offline, the toast's "Sign in again" action is the way back.
        syncStatus.errorMessage = syncStatus.isOnline
            ? 'Your sign-in session expired. Redirecting to sign in…'
            : 'Your sign-in session expired. Sign in again to continue.';
    } else if (error instanceof AuthenticationError) {
        syncStatus.errorMessage = 'Ledger authentication failed. Local changes remain on this device.';
    } else if (error instanceof NotFoundError) {
        syncStatus.errorMessage = 'The selected Ledger log is no longer available.';
    } else if (error instanceof Error) {
        syncStatus.errorMessage = error.message;
    } else {
        syncStatus.errorMessage = 'Synchronization failed';
    }
    console.error('[Sync]', error);
}

function markLedgerUnreachable(error: unknown): void {
    syncStatus.isLedgerReachable = false;
    setSyncError(error);
}

function clearSyncError(): void {
    syncStatus.hasError = false;
    syncStatus.waitingForLedger = false;
    syncStatus.errorMessage = null;
    accessSessionState.expired = false;
}

function markLedgerReachable(): void {
    syncStatus.isLedgerReachable = true;
    clearSyncError();
}

export async function addSyncLogEntry(
    type: SyncLogType,
    message: string,
    details?: string,
): Promise<void> {
    const entry: SyncLogEntry = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        type,
        message,
        details,
    };
    syncLog.entries = [entry, ...syncLog.entries].slice(0, 100);
    try {
        await db.insertInto('sync_logs').values({
            id: entry.id,
            timestamp: entry.timestamp.getTime(),
            type,
            message,
            details: details ?? null,
        }).execute();
        await db.deleteFrom('sync_logs')
            .where('id', 'in', db.selectFrom('sync_logs').select('id')
                .orderBy('timestamp', 'desc').limit(-1).offset(SYNC_LOG_RETAINED_ENTRIES))
            .execute();
    } catch (error) {
        console.error('[SyncLog] Failed to persist entry', error);
    }
}

export async function loadSyncLog(limit = SYNC_LOG_PAGE_SIZE, offset = 0): Promise<void> {
    const rows = await db.selectFrom('sync_logs').selectAll()
        .orderBy('timestamp', 'desc').limit(limit + 1).offset(offset).execute();
    const entries = rows.slice(0, limit).map((row) => ({
        id: row.id,
        timestamp: new Date(row.timestamp),
        type: normalizePersistedSyncLogType(row.type),
        message: row.message,
        details: row.details ?? undefined,
    }));
    syncLog.entries = offset === 0 ? entries : [...syncLog.entries, ...entries];
    syncLog.hasMore = rows.length > limit;
}

export async function loadMoreSyncLog(): Promise<void> {
    await loadSyncLog(SYNC_LOG_PAGE_SIZE, syncLog.entries.length);
}

function normalizePersistedSyncLogType(type: string): SyncLogType {
    const legacy: Record<string, SyncLogType> = {
        sse_receive: 'ws_receive',
        sse_open: 'ws_ready',
        sse_close: 'ws_close',
        sse_error: 'ws_error',
    };
    return legacy[type] ?? type as SyncLogType;
}

export async function clearSyncLog(): Promise<void> {
    await db.deleteFrom('sync_logs').execute();
    syncLog.entries = [];
    syncLog.hasMore = false;
}

export async function getSyncLogCount(): Promise<number> {
    const result = await db.selectFrom('sync_logs')
        .select((eb) => eb.fn.count('id').as('count')).executeTakeFirst();
    return Number(result?.count ?? 0);
}

function announceChange(kind: TabChangeKind): void {
    void requireActiveContext()
        .then((context) => postTabChange({ kind, tenantId: context.tenantId, logId: context.logId }))
        .catch(() => undefined);
}

let remoteChangePending = false;

const syncRefreshQueue = new CoalescedTaskQueue(async () => {
    await updatePendingCount();
    try {
        await invalidateViews();
    } finally {
        notifyEventsChanged({ routesInvalidated: true });
    }
}, REALTIME_INVALIDATION_DEBOUNCE_MS);

function scheduleRemoteRefresh(): void {
    remoteChangePending = false;
    void syncRefreshQueue.schedule().catch(setSyncError);
}

/** Another tab changed this log's data: refresh now if visible, on return otherwise. */
async function handleTabChange(change: TabChange): Promise<void> {
    const context = await getActiveContext();
    if (!context || context.tenantId !== change.tenantId || context.logId !== change.logId) return;
    if (change.kind === 'rebuild' || change.kind === 'schema') {
        // The registry of runtime-defined entities lives in memory per tab.
        await loadDynamicEntityTypes();
    }
    if (!pageVisible()) {
        remoteChangePending = true;
        return;
    }
    scheduleRemoteRefresh();
}

if (typeof window !== 'undefined') {
    onTabChange((change) => {
        void handleTabChange(change).catch((error) => console.warn('[Sync] Could not apply a change from another tab', error));
    });
}

async function invalidateViews(): Promise<void> {
    await withTiming('ui', 'invalidateTargets', async () => {
        announceInvalidation(SYNC_INVALIDATION_TARGETS);
        await Promise.all(SYNC_INVALIDATION_TARGETS.map((target) => invalidate(target)));
        await waitForPageUpdates();
    }, { ...measurementMetadata(), kind: 'refresh', baselineMetric: 'invalidationCost', route: typeof location === 'undefined' ? '' : location.pathname, targetCount: SYNC_INVALIDATION_TARGETS.length });
}

function scheduleRealtimeInvalidation(): void {
    void syncRefreshQueue.schedule().catch(setSyncError);
}

async function getLocalHeadVersion(): Promise<number> {
    const context = await requireActiveContext();
    const row = await db.selectFrom('log_sync_state')
        .select('downloaded_head_version')
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .executeTakeFirst();
    return row?.downloaded_head_version ?? 0;
}

async function updatePendingCount(): Promise<void> {
    try {
        syncStatus.pendingUploads = await getPendingCount();
        const context = await requireActiveContext();
        const attention = await db.selectFrom('outbox_operations')
            .select((eb) => eb.fn.count('id').as('count'))
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('status', '=', 'needs_attention').executeTakeFirst();
        syncStatus.needsAttention = Number(attention?.count ?? 0);
        await refreshEntitySyncState();
    } catch {
        syncStatus.pendingUploads = 0;
        syncStatus.needsAttention = 0;
    }
}

function clearRetryWakeup(): void {
    if (retryWakeupTimeout) clearTimeout(retryWakeupTimeout);
    retryWakeupTimeout = null;
}

async function scheduleRetryWakeup(): Promise<void> {
    clearRetryWakeup();
    if (!syncStatus.isOnline) return;
    const nextRetryAt = await getNextRetryAt();
    if (!nextRetryAt) return;
    const delay = Math.max(0, nextRetryAt.getTime() - Date.now());
    retryWakeupTimeout = setTimeout(() => {
        retryWakeupTimeout = null;
        void runSyncCoordinator('retry_deadline');
    }, delay);
}

async function suspendForAccessSessionExpiry(error: AccessSessionExpiredError): Promise<void> {
    if (synchronizationSuspended) return;
    synchronizationSuspended = true;
    suspendedForAccessExpiry = true;
    syncRequestedWhileRunning = false;
    clearRetryWakeup();
    if (uploadDebounceTimeout) clearTimeout(uploadDebounceTimeout);
    uploadDebounceTimeout = null;
    realtimeHealthy = false;
    syncStatus.isLedgerReachable = false;
    setSyncError(error);
    await closeRealtime();
    requestAccessReauthentication();
}

function probeAccessAfterRealtimeFailure(): void {
    if (accessProbeInFlight || synchronizationSuspended || !syncStatus.isOnline) return;
    if (!pageVisible()) return;
    accessProbeInFlight = true;
    void getLedgerClient().getSession()
        .catch(async (error) => {
            if (error instanceof AccessSessionExpiredError) {
                await suspendForAccessSessionExpiry(error);
            }
        })
        .finally(() => {
            accessProbeInFlight = false;
        });
}

function scheduleRealtimeHealthRecovery(): void {
    if (realtimeStopRequested || realtimeHealthTimeout) return;
    realtimeHealthTimeout = setTimeout(() => {
        realtimeHealthTimeout = null;
        if (!realtimeHealthy) {
            void runSyncCoordinator('ws_error').finally(() => {
                if (!realtimeHealthy) scheduleRealtimeHealthRecovery();
            });
        }
    }, REALTIME_HEALTH_RECOVERY_MS);
}

function clearRealtimeHealthRecovery(): void {
    if (realtimeHealthTimeout) clearTimeout(realtimeHealthTimeout);
    realtimeHealthTimeout = null;
}

export async function loadStoredLogSnapshot(
    logId: string | null,
    storedEvents: StoredEvent[],
): Promise<void> {
    if (!logId) {
        const active = await getActiveContext();
        if (active) await clearActiveProjections();
        await deactivateLogContext();
        syncStatus.logId = null;
        syncStatus.tenantId = null;
        syncStatus.lastSyncedAt = null;
        syncStatus.hasCompletedSync = false;
        syncStatus.isLedgerReachable = null;
        await updatePendingCount();
        notifyEventsChanged();
        return;
    }

    await activateLogContext(logId);
    syncStatus.hasCompletedSync = false;
    syncStatus.isLedgerReachable = null;
    if (storedEvents.length > 0) await handleIncomingStoredEvents(storedEvents);
    await rebuildReadModel();
    // Route invalidation reads through the active target. Activate the rebuilt
    // log first so a guarded log transition cannot deadlock waiting on itself.
    await activateCurrentReadTarget();
    syncStatus.lastSyncedAt = storedEvents.length > 0 ? new Date() : null;
    await updatePendingCount();
    await syncRefreshQueue.flush();
    clearSyncError();
}

/** Fewer retained local facts than this are not worth a baseline install on an up-to-date device. */
const ADOPT_MIN_SURPLUS = 256;

async function coveredSurplus(context: { tenantId: string; logId: string }, through: number): Promise<number> {
    const row = await db.selectFrom('raw_events').select(eb => eb.fn.countAll<number>().as('count'))
        .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId)
        .where('sync_state', '=', 'synced').where('log_version', '<=', through).executeTakeFirst();
    return Number(row?.count ?? 0);
}

/**
 * Local replay directives the baseline cannot stand in for: one still waiting to upload, or one accepted after the
 * snapshot that reaches back into history the snapshot folds away. Directives the snapshot already includes do not
 * matter; installing it replaces them.
 */
async function localDirectivesBlockBaseline(context: { tenantId: string; logId: string }, through: number): Promise<boolean> {
    const rows = await db.selectFrom('raw_events').select(['type', 'payload', 'log_version'])
        .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId)
        .where('type', 'in', [...REPLAY_DIRECTIVES])
        .where(eb => eb.or([eb('log_version', 'is', null), eb('log_version', '>', through)])).execute();
    if (rows.some(row => row.log_version === null)) return true;
    return rows.length > 0 && await directivesReachBehind(context, through, rows);
}

async function download(): Promise<number> {
    return withTiming('sync', 'download', async () => {
        const logId = await ensureSelectedContext();
        const context = await requireActiveContext();
        let cursor = await getLocalHeadVersion();
        const maintenance = await getLedgerClient().getLogMaintenance(logId);
        let installedBaseline = false;
        const checkpoint = maintenance?.checkpoint;
        // Adopt a newer snapshot even when this device is already caught up, so its accepted prefix shrinks to the
        // snapshot. A device that is merely ahead only does so when that saves real work.
        if (checkpoint && await baselineVersion(context) < checkpoint.throughVersion
            && (cursor < checkpoint.throughVersion || await coveredSurplus(context, checkpoint.throughVersion) > checkpoint.eventCount + ADOPT_MIN_SURPLUS)
            && !await localDirectivesBlockBaseline(context, checkpoint.throughVersion)) {
            await installBaseline(checkpoint, context);
            installedBaseline = true;
            cursor = await getLocalHeadVersion();
        }
        let downloaded = 0;
        while (true) {
            const storedEvents = await getLedgerClient().getEventPage(logId, cursor, 512);
            if (storedEvents.length === 0) break;
            await handleIncomingStoredEvents(storedEvents);
            const next = await getLocalHeadVersion();
            if (next <= cursor) throw new Error('Ledger download did not fill the next event-log position');
            cursor = next;
            downloaded += storedEvents.length;
            eventSocket?.acknowledge(cursor);
            if (storedEvents.length < 512) break;
        }
        catchUpRevision += 1;
        caughtUpScope = scopeKey({ tenantId: context.tenantId, logId });
        if (downloaded === 0 && !installedBaseline) return 0;
        await addSyncLogEntry('download', installedBaseline ? `Loaded snapshot and ${downloaded} events` : `Downloaded ${downloaded} events`, `Through version ${cursor}`);
        await syncRefreshQueue.flush();
        announceChange('ingest');
        return downloaded;
    });
}

async function currentVersionsFor(events: PendingBatchEvent[]): Promise<Map<string, number>> {
    const versions = new Map<string, number>();
    for (const entityId of new Set(events.map((event) => event.entityId))) {
        const version = await versionTracker.getCurrentVersion(entityId);
        if (version !== null) versions.set(entityId, version);
    }
    return versions;
}

async function prepareNextOperation(rebaseCount = 0): Promise<DurableOperation | null> {
    const batch = await getNextPendingBatch();
    if (!batch) return null;
    const request = prepareAppendRequest(batch.events, await currentVersionsFor(batch.events));
    // Existing durable requests are retried byte-for-byte. Only freshly prepared
    // requests gain metadata after the server has advertised support.
    if (await getLedgerClient().getActionMetadataSupport()) request.actionId = batch.events[0]!.id;
    return persistOperation(batch.id, request, rebaseCount);
}

type OperationResult = 'synced' | 'retry_later' | 'continue';

/** Automatic merges attempted for one batch while other devices keep writing. */
const MAX_AUTOMATIC_REBASES = 5;

/**
 * What of this batch's edits clashes with edits other devices had accepted for
 * the same records since the versions the batch was prepared against.
 */
async function findBatchClashes(operation: DurableOperation): Promise<EntityClash[]> {
    const byEntity = new Map<string, DurableOperation['request']['events']>();
    for (const event of operation.request.events) {
        byEntity.set(event.entityId, [...byEntity.get(event.entityId) ?? [], event]);
    }
    const clashes: EntityClash[] = [];
    for (const [entityId, events] of byEntity) {
        const base = events[0]?.baseEntityVersion;
        // A record this batch creates has no history to clash with.
        if (base === undefined || base === null) continue;
        const theirs = await getAcceptedEntityEdits(entityId, base);
        if (theirs.length === 0) continue;
        const mine = events.map((event) => ({ type: event.type, payload: event.payload }));
        clashes.push(...findClashes(entityId, mine, theirs));
    }
    return clashes;
}

async function executeOperation(operation: DurableOperation): Promise<OperationResult> {
    const logId = await ensureSelectedContext();
    await markOperationSyncing(operation.id);
    let accepted = false;
    let applied = false;
    try {
        const response = await getLedgerClient().appendEvents(logId, operation.request);
        accepted = true;
        // An append response contains only this request's events, not intervening
        // writes from other devices. Ingest/re-project it, then catch up any gap.
        await handleIncomingStoredEvents(response.events);
        await markOperationSynced(operation, response.events);
        applied = true;
        const through = await getLocalHeadVersion();
        eventSocket?.acknowledge(through);
        if (through < response.newVersion) await download();
        await addSyncLogEntry('upload', `Uploaded ${response.events.length} events`, `requestId: ${operation.requestId}`);
        announceChange('ingest');
        return 'synced';
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (accepted) {
            if (!applied) await markOperationFailed(operation, 'local_apply_failed', message);
            throw error; // An accepted append must never become a rejected local action.
        }
        if (operation.request.expectedLogVersion !== undefined && error instanceof LedgerServiceError
            && (error.code === 'stale_restore_preview' || error instanceof VersionConflictError)) {
            await rejectBatch(operation, 'stale_restore_preview', 'The log changed. Preview the restore again.');
            return 'continue';
        }
        if (error instanceof VersionConflictError) {
            // The other devices' events are needed to tell a merge from a clash.
            await download();
            const clashes = await findBatchClashes(operation);
            if (clashes.length > 0) {
                await parkOperationForConflict(operation, clashes);
                return 'retry_later';
            }
            if (operation.rebaseCount >= MAX_AUTOMATIC_REBASES) {
                await markOperationFailed(operation, error.code ?? 'entity_conflict', message, true);
                return 'retry_later';
            }
            // Different fields, or the same values: send the batch again on top.
            await supersedeOperation(operation);
            await rebuildReadModel();
            await prepareNextOperation(operation.rebaseCount + 1);
            return 'continue';
        }
        // A retry cannot change these answers, so park the batch now instead
        // of spending its retries on a guaranteed conflict.
        const alreadyAccepted = error instanceof LedgerServiceError && error.statusCode === 409
            && (error.code === 'event_already_accepted' || error.code === 'action_already_accepted');
        if (error instanceof EntityVersionChainError || error instanceof IdempotencyMismatchError || alreadyAccepted) {
            await markOperationFailed(operation, error.code ?? 'sync_invariant', message, true);
            return 'retry_later';
        }
        const moved = movedDestination(error);
        if (moved) {
            // Not a bad change: the workspace lives elsewhere now. Keep the request, stop sending, tell the person.
            await markWorkspaceMoved(moved.destination);
            await markOperationFailed(operation, 'tenant_moved', message, false);
            throw error;
        }
        if (error instanceof AccessSessionExpiredError) {
            // The operation remains in its durable, retryable state. Access
            // expiry is not a bad local change and must not require repair
            // after the user signs in again.
            throw error;
        }
        if (error instanceof AuthenticationError || error instanceof NotFoundError) {
            await markOperationFailed(operation, error.code ?? 'client_error', message, true);
            throw error;
        }
        if (error instanceof LedgerServiceError && [400, 422].includes(error.statusCode ?? 0)) {
            await rejectBatch(operation, error.code ?? 'invalid_event_envelope', message);
            await rebuildReadModel();
            return 'continue';
        }
        // Ledger being unreachable never needs a person; any other answer
        // would repeat on every attempt, so park it now.
        await markOperationFailed(
            operation,
            error instanceof LedgerServiceError ? error.code ?? 'ledger_error' : 'network_error',
            message,
            !isTransientSyncFailure(error),
        );
        throw error instanceof Error ? error : new Error(message);
    }
}

/**
 * Turns every queued local batch of the active log into a durable request, so a
 * file exported after a move holds all of this device's unsynced work.
 */
export async function preparePendingOperations(): Promise<void> {
    const context = await requireActiveContext();
    await withExclusiveSyncLock(`stor:outbox:${context.tenantId}:${context.logId}`, async () => {
        while (await prepareNextOperation()) {
            // Each pass persists the next batch that has no request yet, so this ends.
        }
    });
}

async function drainDurableOutbox(): Promise<void> {
    // A moved workspace keeps its queue for export; sending would only repeat the 410.
    if (movedWorkspace.value) return;
    const context = await requireActiveContext();
    const acquired = await withExclusiveSyncLock(
        `stor:outbox:${context.tenantId}:${context.logId}`,
        async () => {
            let logged = false;
            while (true) {
                const operation = await getReadyOperation() ?? await prepareNextOperation();
                if (!operation) break;
                if (!logged) await addSyncLogEntry('drain', 'Draining durable outbox');
                logged = true;
                const result = await executeOperation(operation);
                if (result === 'retry_later') break;
            }
        },
    );
    await updatePendingCount();
    await scheduleRetryWakeup();
    if (!acquired && !retryWakeupTimeout && syncStatus.isOnline) {
        retryWakeupTimeout = setTimeout(() => {
            retryWakeupTimeout = null;
            void runSyncCoordinator('retry_deadline');
        }, RETRY_BASE_DELAY_MS);
    }
}

/**
 * Applies every event delivered since the last drain in one ingestion, so a
 * batch appended elsewhere costs one transaction instead of one per event.
 */
async function handleRealtimeEvents(): Promise<void> {
    const delivered = pendingRealtimeEvents.splice(0).sort((a, b) => a.version - b.version);
    try {
        const localHead = await getLocalHeadVersion();
        let head = localHead;
        const batch: StoredEvent[] = [];
        for (const storedEvent of delivered) {
            const disposition = classifyRealtimeVersion(head, storedEvent.version);
            if (disposition === 'duplicate') continue;
            if (disposition === 'resynchronize') {
                await resynchronizeRealtime(delivered.at(-1)!.version, 'gap_too_large');
                return;
            }
            batch.push(storedEvent);
            head = storedEvent.version;
        }
        if (batch.length === 0) {
            eventSocket?.acknowledge(localHead);
            return;
        }
        await handleIncomingStoredEvents(batch);
        eventSocket?.acknowledge(await getLocalHeadVersion());
        syncStatus.lastSyncedAt = new Date();
        syncStatus.hasCompletedSync = true;
        markLedgerReachable();
        const last = batch.at(-1)!;
        await addSyncLogEntry('ws_receive', batch.length === 1
            ? `Received event v${last.version}: ${last.type}`
            : `Received ${batch.length} events through v${last.version}`);
        scheduleRealtimeInvalidation();
        announceChange('ingest');
    } catch (error) {
        await addSyncLogEntry('error', 'Failed to process WebSocket event', error instanceof Error ? error.message : String(error));
        setSyncError(error);
    }
}

function enqueueRealtimeEvent(storedEvent: StoredEvent): void {
    pendingRealtimeEvents.push(storedEvent);
    // A drain is already queued; it takes every event delivered before it runs.
    if (pendingRealtimeEvents.length > 1) return;
    void realtimeEventQueue
        .enqueue(handleRealtimeEvents)
        .catch((error) => {
            void addSyncLogEntry(
                'error',
                'Failed to process queued WebSocket event',
                error instanceof Error ? error.message : String(error),
            );
            setSyncError(error);
        });
}

async function handleRealtimeReady(headVersion: number): Promise<void> {
    const localHead = await getLocalHeadVersion();
    if (localHead < headVersion) {
        await resynchronizeRealtime(headVersion, 'gap_too_large');
        return;
    }
    eventSocket?.acknowledge(localHead);
    realtimeHealthy = true;
    markLedgerReachable();
    clearRealtimeHealthRecovery();
    await addSyncLogEntry('ws_ready', `WebSocket ready at version ${headVersion}`);
}

async function resynchronizeRealtime(
    headVersion: number,
    reason: import('../ledger/socket.js').SocketResyncReason,
): Promise<void> {
    realtimeHealthy = false;
    const socket = eventSocket;
    socket?.pause();
    await addSyncLogEntry('ws_resync', `Resynchronizing through version ${headVersion}`, reason);
    await download();
    const localHead = await getLocalHeadVersion();
    socket?.resetAfterVersion(localHead);
    if (
        socket &&
        socket === eventSocket &&
        !realtimeStopRequested &&
        syncStatus.isOnline &&
        pageVisible()
    ) {
        await socket.open();
    }
}

async function initializeRealtime(catchUpScope: string | null = null): Promise<void> {
    if (!loadLedgerConfig().enableRealtime) return;
    await ensureSelectedContext();
    const context = await requireActiveContext();
    const key = scopeKey(context);
    if (releaseRealtimeLeaseLock && realtimeLeaseKey === key) {
        // Already ours or queued behind another tab; retry a connection that
        // failed to open.
        if (realtimeLeaseAcquired) await openRealtime(catchUpScope);
        return;
    }
    releaseRealtimeLease();
    const generation = ++realtimeGeneration;
    realtimeLeaseKey = key;
    releaseRealtimeLeaseLock = holdTabLock(realtimeLockName(context), async () => {
        if (generation !== realtimeGeneration) return;
        realtimeLeaseAcquired = true;
        try {
            await openRealtime(catchUpScope);
        } catch (error) {
            setSyncError(error);
            scheduleRealtimeHealthRecovery();
        }
    });
}

function releaseRealtimeLease(): void {
    realtimeGeneration += 1;
    releaseRealtimeLeaseLock?.();
    releaseRealtimeLeaseLock = null;
    realtimeLeaseKey = null;
    realtimeLeaseAcquired = false;
}

async function openRealtime(catchUpScope: string | null = null): Promise<void> {
    if (eventSocket || openingRealtime) return;
    openingRealtime = true;
    const generation = realtimeGeneration;
    try {
        const logId = await ensureSelectedContext();
        // A completed coordinator catch-up already supplies this scope's cursor.
        // Ordered socket replay covers the connection gap; oversized gaps still
        // return to HTTP through resynchronizeRealtime.
        if (catchUpScope !== scopeKey(await requireActiveContext())) await download();
        await getLedgerClient().getWorkspaceRestoreSupport();
        // The lease may have been given up while this was waiting on the network.
        if (generation !== realtimeGeneration) return;
        await connectRealtime(logId, generation);
    } finally {
        openingRealtime = false;
    }
    // A newer lease may have been granted while this one was opening.
    if (generation !== realtimeGeneration && realtimeLeaseAcquired && !eventSocket) await openRealtime();
}

async function connectRealtime(logId: string, generation: number): Promise<void> {
    const socket = getLedgerClient().createEventSocket(logId, await getLocalHeadVersion());
    if (generation !== realtimeGeneration) return;
    eventSocket = socket;
    socket.on('event', enqueueRealtimeEvent);
    socket.on('ready', (headVersion) => {
        void realtimeEventQueue.enqueue(() => handleRealtimeReady(headVersion)).catch(setSyncError);
    });
    socket.on('resync_required', (headVersion, reason) => {
        void realtimeEventQueue
            .enqueue(() => resynchronizeRealtime(headVersion, reason))
            .catch(setSyncError);
    });
    socket.on('error', (error: Error) => {
        realtimeHealthy = false;
        syncStatus.isLedgerReachable = false;
        void addSyncLogEntry('ws_error', 'WebSocket error', error.message);
        probeAccessAfterRealtimeFailure();
        scheduleRealtimeHealthRecovery();
    });
    socket.on('close', () => {
        realtimeHealthy = false;
        void addSyncLogEntry('ws_close', 'WebSocket disconnected');
        if (!realtimeStopRequested) {
            probeAccessAfterRealtimeFailure();
            scheduleRealtimeHealthRecovery();
        }
    });
    await socket.open();
    if (generation !== realtimeGeneration && eventSocket === socket) await closeSocket();
}

async function closeRealtime(): Promise<void> {
    releaseRealtimeLease();
    await closeSocket();
}

async function closeSocket(): Promise<void> {
    if (!eventSocket) return;
    const socket = eventSocket;
    eventSocket = null;
    realtimeStopRequested = true;
    realtimeHealthy = false;
    clearRealtimeHealthRecovery();
    socket.close();
    await realtimeEventQueue.idle();
    realtimeStopRequested = false;
}

export async function sync(trigger: SyncTrigger = 'manual'): Promise<void> {
    if (synchronizationSuspended) return;
    if (syncInProgress) {
        syncRequestedWhileRunning = true;
        return;
    }
    syncInProgress = true;
    syncStatus.isSyncing = true;
    try {
        do {
            syncRequestedWhileRunning = false;
            try {
                await withTiming('sync', 'fullSyncCycle', async () => {
                    await ensureSelectedContext();
                    const context = await requireActiveContext();
                    // One cycle per log across tabs: a tab that waits its turn
                    // finds the earlier cycle's downloads and uploads done.
                    await withTabLock(syncCycleLockName(context), async () => {
                        if (!realtimeHealthy || !eventSocket?.isReady()) await download();
                        if (syncStatus.isOnline) await drainDurableOutbox();
                        syncStatus.lastSyncedAt = new Date();
                        syncStatus.hasCompletedSync = true;
                        markLedgerReachable();
                    });
                }, { trigger });
            } catch (error) {
                markLedgerUnreachable(error);
                if (error instanceof AccessSessionExpiredError) {
                    await suspendForAccessSessionExpiry(error);
                    return;
                }
            }
        } while (syncRequestedWhileRunning && syncStatus.isOnline);
    } finally {
        syncInProgress = false;
        syncIdleWaiters.splice(0).forEach((resolve) => resolve());
        syncStatus.isSyncing = false;
        if (!synchronizationSuspended) {
            await updatePendingCount();
            await scheduleRetryWakeup();
        }
    }
}

export async function runSyncCoordinator(trigger: SyncTrigger): Promise<void> {
    if (synchronizationSuspended) return;
    // Another tab changed the data while this one was hidden.
    if (remoteChangePending && pageVisible()) {
        scheduleRemoteRefresh();
    }
    if (!syncStatus.isOnline) {
        await updatePendingCount();
        return;
    }
    if (
        trigger !== 'manual' &&
        !pageVisible()
    ) {
        await updatePendingCount();
        clearRetryWakeup();
        return;
    }

    const beforeCatchUp = catchUpRevision;
    await sync(trigger);
    if (!synchronizationSuspended && pageVisible()) {
        await initializeRealtime(catchUpRevision !== beforeCatchUp && !syncStatus.hasError ? caughtUpScope : null);
    }
}

export function signalLocalChange(): void {
    notifyEventsChanged();
    void updatePendingCount();
    announceChange('commit');
    if (import.meta.env.VITE_E2E === '1') return;
    if (synchronizationSuspended || typeof window === 'undefined' || !syncStatus.isOnline) return;
    if (uploadDebounceTimeout) clearTimeout(uploadDebounceTimeout);
    uploadDebounceTimeout = setTimeout(() => {
        uploadDebounceTimeout = null;
        void runSyncCoordinator('local_commit');
    }, UPLOAD_DEBOUNCE_MS);
}

onLocalCommandCommitted(() => signalLocalChange());

export async function startRealtime(): Promise<void> {
    await initializeRealtime();
}

export async function stopRealtime(): Promise<void> {
    clearRetryWakeup();
    await closeRealtime();
}

export async function shutdownSynchronization(): Promise<void> {
    synchronizationSuspended = true;
    syncRequestedWhileRunning = false;
    clearRetryWakeup();
    if (uploadDebounceTimeout) clearTimeout(uploadDebounceTimeout);
    uploadDebounceTimeout = null;
    await closeRealtime();
    if (syncInProgress) {
        await new Promise<void>((resolve) => syncIdleWaiters.push(resolve));
    }
}

export async function handleOnline(): Promise<void> {
    syncStatus.isOnline = true;
    if (suspendedForAccessExpiry && requestAccessReauthentication()) return;
    await runSyncCoordinator('online');
}

export async function handleOffline(): Promise<void> {
    syncStatus.isOnline = false;
    syncStatus.isLedgerReachable = false;
    clearRetryWakeup();
    await closeRealtime();
}

export async function resetHeadVersion(): Promise<void> {
    const context = await getActiveContext();
    if (context) {
        await db.updateTable('log_sync_state').set({
            downloaded_head_version: 0,
            projected_head_version: 0,
            last_synced_at: null,
        }).where('tenant_id', '=', context.tenantId)
          .where('log_id', '=', context.logId).execute();
    }
    await delKv('log-head-version');
}


/** Await the active cycle as well as a newly requested one. */
export async function syncAndWait(): Promise<void> {
    await sync();
    if (syncInProgress) await new Promise<void>(resolve => syncIdleWaiters.push(resolve));
}
