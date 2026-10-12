import type { LocalStorePhase } from './local-store.svelte.js';

export type SyncPhase =
    | 'offline'
    | 'idle'
    | 'syncing'
    | 'pending'
    | 'blocked'
    | 'waiting'
    | 'error'
    | 'synced';

export interface SyncStateInput {
    isOnline: boolean;
    isSyncing: boolean;
    hasCompletedSync: boolean;
    hasError: boolean;
    waitingForLedger?: boolean;
    pendingUploads: number;
    needsAttention: number;
}

export interface SyncPresentation {
    label: string;
    description: string;
    tone: 'neutral' | 'success' | 'warning' | 'danger';
}

export function deriveSyncPhase(input: SyncStateInput): SyncPhase {
    if (!input.isOnline) return 'offline';
    if (input.needsAttention > 0) return 'blocked';
    if (input.hasError && input.waitingForLedger) return 'waiting';
    if (input.hasError) return 'error';
    if (input.isSyncing) return 'syncing';
    if (input.pendingUploads > 0) return 'pending';
    if (input.hasCompletedSync) return 'synced';
    return 'idle';
}

export function describeAppDataState(input: {
    localStorePhase: LocalStorePhase;
    syncPhase: SyncPhase;
    pendingUploads: number;
    needsAttention: number;
    lastSyncedAt: Date | null;
    syncErrorMessage?: string | null;
    localStoreErrorMessage?: string | null;
}): SyncPresentation {
    if (input.localStorePhase === 'booting') {
        return {
            label: 'Preparing local data',
            description: 'Checking the local database',
            tone: 'neutral',
        };
    }
    if (input.localStorePhase === 'failed') {
        return {
            label: 'Local data unavailable',
            description: input.localStoreErrorMessage || 'The local database could not be opened',
            tone: 'danger',
        };
    }
    if (input.localStorePhase === 'degraded') {
        return {
            label: 'Local data limited',
            description: input.localStoreErrorMessage || 'No event log is selected',
            tone: 'warning',
        };
    }

    switch (input.syncPhase) {
        case 'offline':
            return {
                label: 'Offline',
                description: 'Changes stay on this device',
                tone: 'warning',
            };
        case 'blocked':
            return {
                label: `${input.needsAttention} need attention`,
                description: 'Some local changes could not sync',
                tone: 'danger',
            };
        case 'waiting':
            return {
                label: input.pendingUploads > 0 ? 'Waiting to upload' : 'Ledger unreachable',
                description: 'Changes stay on this device and sync when Ledger responds',
                tone: 'warning',
            };
        case 'error':
            return {
                label: 'Sync error',
                description: input.syncErrorMessage || 'Ledger could not be reached',
                tone: 'danger',
            };
        case 'syncing':
            return {
                label: 'Syncing',
                description: input.pendingUploads > 0
                    ? `Uploading ${input.pendingUploads} local ${input.pendingUploads === 1 ? 'change' : 'changes'}`
                    : 'Checking Ledger for changes',
                tone: 'neutral',
            };
        case 'pending':
            return {
                label: `${input.pendingUploads} pending`,
                description: 'Local changes are waiting to upload',
                tone: 'warning',
            };
        case 'synced':
            return {
                label: 'Synced',
                description: input.lastSyncedAt
                    ? `Updated ${input.lastSyncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                    : 'Ledger is up to date',
                tone: 'success',
            };
        case 'idle':
        default:
            return {
                label: 'Not synced yet',
                description: 'Waiting for the first Ledger check',
                tone: 'neutral',
            };
    }
}

