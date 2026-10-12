import { recordTiming, measurementMetadata } from '../utils/perf.js';
import { bootstrapLocalStore, type LocalStoreBootstrapResult } from '../db/bootstrap.js';
import { eventLogFilename } from '../store/event-log.svelte.js';
import { activateCurrentReadTarget, beginReadTargetTransition, failReadTargetTransition } from './read-coordinator.js';
import { workspaceIsReady } from '@hearthlog/ui/state/readiness.js';
import { schedulePwaRegistration } from '../pwa/registration.js';

export interface WorkspaceTicket {
    logId: string | null;
    ready: Promise<LocalStoreBootstrapResult>;
}

let ticket: WorkspaceTicket | undefined;
let recordedLocalReady = false;
let activationQueue: Promise<unknown> = Promise.resolve();

/** Called by committed loads only: the app preloads code, never load functions. */
export function prepareWorkspace(url: URL): WorkspaceTicket {
    const logId = eventLogFilename.value;
    if (ticket && (!ticket.logId || ticket.logId === logId)) return ticket;

    beginReadTargetTransition();
    const next: WorkspaceTicket = { logId, ready: undefined! };
    ticket = next;
    const bootstrap = bootstrapLocalStore();
    if (import.meta.env.PROD) void schedulePwaRegistration(bootstrap);
    next.ready = activationQueue.catch(() => undefined).then(async () => {
        const result = await bootstrap;
        if (ticket !== next) throw new DOMException('Navigation superseded', 'AbortError');
        next.logId = eventLogFilename.value;
        if (!next.logId) throw new Error('Select an event log before opening this workspace.');
        await activateCurrentReadTarget();
        if (ticket !== next) {
            beginReadTargetTransition();
            throw new DOMException('Navigation superseded', 'AbortError');
        }
        if (!recordedLocalReady && typeof window !== 'undefined') {
            recordedLocalReady = true;
            recordTiming('startup', 'dataReady', performance.now(), {
                ...measurementMetadata(), baselineMetric: 'dataReady', route: url.pathname,
                schemaRebuilt: result.schemaRebuilt, hasSelectedLog: true,
            });
        }
        return { ...result, activeLogId: next.logId };
    }).catch((error) => {
        if (ticket === next) {
            ticket = undefined;
            failReadTargetTransition(error);
        }
        throw error;
    });
    // A fast rejection must be handled even before Svelte mounts its consumer.
    void bootstrap.catch(() => undefined);
    void next.ready.catch(() => undefined);
    activationQueue = next.ready;
    return next;
}

export async function waitForWorkspace(): Promise<void> {
    if (ticket) await ticket.ready;
    if (!workspaceIsReady()) throw new Error('Local data is not ready.');
}
