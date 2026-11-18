import { rebuildIfSchemaChanged } from '../event/rebuild.js';
import { eventLogFilename } from '../store/event-log.svelte.js';
import { activateLogContext } from '../store/local-context.js';
import {
    markLocalStoreBooting,
    markLocalStoreDegraded,
    markLocalStoreFailed,
    markLocalStoreReady,
    setLocalStoreStorage,
    type LocalStorePhase,
} from '../store/local-store.svelte.js';
import { getLocalSchemaVersion } from './index.js';
import { retryPendingCommandProjections } from '../commands/index.js';
import { launch } from '../store/launch-history.js';
import { currentStorageType } from './storage-status.js';
import { preferredOpfsVfs } from './opfs-vfs.js';

export interface LocalStoreBootstrapResult {
    activeLogId: string | null;
    schemaRebuilt: boolean;
    schemaVersion: number;
    phase: LocalStorePhase;
}

let bootstrapPromise: Promise<LocalStoreBootstrapResult> | null = null;

/** Records where SQLite really opened; a memory database survives no restart, so the developer page warns. */
async function recordStorage(): Promise<void> {
    const storageType = await currentStorageType();
    setLocalStoreStorage(storageType);
    launch.note({ storage: storageType, requestedVfs: preferredOpfsVfs() });
    if (storageType === 'memory') {
        launch.path('full-download', 'SQLite could not open the database file and runs in memory, so nothing from earlier launches is there.');
    }
}

async function runBootstrap(): Promise<LocalStoreBootstrapResult> {
    markLocalStoreBooting();
    const started = typeof performance === 'undefined' ? 0 : performance.now();
    await eventLogFilename.ready();
    await recordStorage();

    const activeLogId = eventLogFilename.value;
    if (!activeLogId) {
        const schemaVersion = await getLocalSchemaVersion();
        markLocalStoreDegraded({
            message: 'No event log is selected',
            schemaVersion,
        });
        return {
            activeLogId: null,
            schemaRebuilt: false,
            schemaVersion,
            phase: 'degraded',
        };
    }

    await activateLogContext(activeLogId);
    const checked = typeof performance === 'undefined' ? 0 : performance.now();
    const schemaRebuilt = await rebuildIfSchemaChanged();
    if (schemaRebuilt) {
        launch.step('Schema rebuild', checked);
        launch.path('schema-rebuild', 'The stored schema version, projected tables or module projections did not match this build (a new build, or the first launch on this device), so the read model was rebuilt from stored events.');
    }
    await retryPendingCommandProjections();
    launch.step('Startup checks', started);

    const result: LocalStoreBootstrapResult = {
        activeLogId,
        schemaRebuilt,
        schemaVersion: await getLocalSchemaVersion(),
        phase: 'ready',
    };
    markLocalStoreReady({
        activeLogId,
        schemaVersion: result.schemaVersion,
        schemaRebuilt,
    });
    return result;
}

/**
 * Initializes the selected local Ledger scope exactly once per tab. Route loaders
 * await this through the root layout before issuing scoped projection queries.
 * Failed attempts are not cached so a navigation or explicit retry can recover.
 */
export function bootstrapLocalStore(): Promise<LocalStoreBootstrapResult> {
    bootstrapPromise ??= runBootstrap().catch((error) => {
        bootstrapPromise = null;
        markLocalStoreFailed(error);
        throw error;
    });
    return bootstrapPromise;
}
