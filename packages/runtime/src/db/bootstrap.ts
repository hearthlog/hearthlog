import { rebuildIfSchemaChanged } from '../event/rebuild.js';
import { eventLogFilename } from '../store/event-log.svelte.js';
import { activateLogContext } from '../store/local-context.js';
import {
    markLocalStoreBooting,
    markLocalStoreDegraded,
    markLocalStoreFailed,
    markLocalStoreReady,
    type LocalStorePhase,
} from '../store/local-store.svelte.js';
import { getLocalSchemaVersion } from './index.js';
import { retryPendingCommandProjections } from '../commands/index.js';

export interface LocalStoreBootstrapResult {
    activeLogId: string | null;
    schemaRebuilt: boolean;
    schemaVersion: number;
    phase: LocalStorePhase;
}

let bootstrapPromise: Promise<LocalStoreBootstrapResult> | null = null;

async function runBootstrap(): Promise<LocalStoreBootstrapResult> {
    markLocalStoreBooting();
    await eventLogFilename.ready();

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
    const schemaRebuilt = await rebuildIfSchemaChanged();
    await retryPendingCommandProjections();

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
