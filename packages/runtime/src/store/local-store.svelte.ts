export type LocalStorePhase = 'booting' | 'ready' | 'degraded' | 'failed';

export interface LocalStoreStatus {
    phase: LocalStorePhase;
    activeLogId: string | null;
    schemaVersion: number | null;
    schemaRebuilt: boolean;
    errorMessage: string | null;
    readyAt: Date | null;
}

export const localStoreStatus = $state<LocalStoreStatus>({
    phase: 'booting',
    activeLogId: null,
    schemaVersion: null,
    schemaRebuilt: false,
    errorMessage: null,
    readyAt: null,
});

export function markLocalStoreBooting(): void {
    localStoreStatus.phase = 'booting';
    localStoreStatus.errorMessage = null;
}

export function markLocalStoreReady(input: {
    activeLogId: string;
    schemaVersion: number;
    schemaRebuilt: boolean;
}): void {
    localStoreStatus.phase = 'ready';
    localStoreStatus.activeLogId = input.activeLogId;
    localStoreStatus.schemaVersion = input.schemaVersion;
    localStoreStatus.schemaRebuilt = input.schemaRebuilt;
    localStoreStatus.errorMessage = null;
    localStoreStatus.readyAt = new Date();
}

export function markLocalStoreDegraded(input: {
    message: string;
    schemaVersion: number;
}): void {
    localStoreStatus.phase = 'degraded';
    localStoreStatus.activeLogId = null;
    localStoreStatus.schemaVersion = input.schemaVersion;
    localStoreStatus.schemaRebuilt = false;
    localStoreStatus.errorMessage = input.message;
    localStoreStatus.readyAt = new Date();
}

export function markLocalStoreFailed(error: unknown): void {
    localStoreStatus.phase = 'failed';
    localStoreStatus.errorMessage = error instanceof Error
        ? error.message
        : 'The local database could not be opened';
    localStoreStatus.readyAt = null;
}

