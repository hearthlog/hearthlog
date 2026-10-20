/**
 * The page's side of a native app's engine: the hidden web view on `ENGINE_PATH` runs the
 * ordinary runtime, and this installs `window.hearthlogNative` for the app to call and posts
 * `native:*` messages back (protocol in `./bridge.ts`). Outside that web view nothing is posted.
 */

import { tenant } from '@hearthlog/contracts/tenant/config';
import { eventLogFilename } from '../store/event-log.svelte.js';
import { accessSessionState, getSyncPhase, runSyncCoordinator, syncStatus } from '../store/sync.svelte.js';
import { setPageVisibilityOverride } from '../runtime/visibility.js';
import {
    booleanArgument,
    createDispatcher,
    NATIVE_BRIDGE_VERSION,
    NativeCallError,
    type EngineContext,
    type EngineStatus,
    type NativeEndpoint,
    type NativeHandler,
    type NativeMessage,
} from './bridge.js';
import { shell } from './shell.js';

declare global {
    interface Window {
        hearthlogNative?: NativeEndpoint;
    }
}

const engine = $state({ ready: false, active: true });

function post(message: NativeMessage): void {
    if (shell?.role !== 'engine') return;
    try {
        window.webkit?.messageHandlers?.stor?.postMessage(message);
    } catch {
        // The app re-reads `engine.status` when it misses a message.
    }
}

export function engineContext(): EngineContext {
    return {
        tenantId: tenant.id,
        title: tenant.title,
        origin: window.location.origin,
        logId: eventLogFilename.value || null,
        logName: eventLogFilename.name || null,
    };
}

export function engineStatus(): EngineStatus {
    return {
        phase: getSyncPhase(),
        ready: engine.ready,
        active: engine.active,
        isOnline: syncStatus.isOnline,
        isSyncing: syncStatus.isSyncing,
        hasCompletedSync: syncStatus.hasCompletedSync,
        pendingUploads: syncStatus.pendingUploads,
        needsAttention: syncStatus.needsAttention,
        errorMessage: syncStatus.hasError ? syncStatus.errorMessage : null,
        lastSyncedAt: syncStatus.lastSyncedAt ? syncStatus.lastSyncedAt.toISOString() : null,
        signedIn: !accessSessionState.expired,
        logId: eventLogFilename.value || null,
    };
}

function requireReady(): void {
    if (!engine.ready) throw new NativeCallError('not_ready', 'The local data is still opening.');
}

/** The functions every engine has, whatever modules the site runs. */
const CORE_HANDLERS: Readonly<Record<string, NativeHandler>> = {
    'engine.context': () => engineContext(),
    'engine.status': () => engineStatus(),
    'engine.syncNow': async () => {
        requireReady();
        await runSyncCoordinator('manual');
        return engineStatus();
    },
    /** The app is in front (or not): sync and realtime run only while it is, as in a visible tab. */
    'engine.setActive': (args) => {
        engine.active = booleanArgument(args, 'active');
        setPageVisibilityOverride(engine.active);
        return engineStatus();
    },
};

/**
 * Installs the endpoint and starts reporting. `ready` is the workspace opening (the layout load's
 * `workspace.ready`); `native:ready` follows it, or `native:failed` when it cannot open.
 */
export function startNativeEngine(ready: Promise<unknown>): () => void {
    // A hidden web view is never "visible" to WebKit; the app decides instead.
    setPageVisibilityOverride(engine.active);
    const call = createDispatcher(CORE_HANDLERS);
    Object.defineProperty(window, 'hearthlogNative', {
        value: Object.freeze({ version: NATIVE_BRIDGE_VERSION, call } satisfies NativeEndpoint),
        configurable: true,
        enumerable: false,
    });

    let stopped = false;
    ready.then(
        () => {
            if (stopped) return;
            engine.ready = true;
            post({ type: 'native:ready', body: { bridgeVersion: NATIVE_BRIDGE_VERSION, context: engineContext(), apis: {} } });
        },
        (error: unknown) => {
            if (stopped) return;
            post({ type: 'native:failed', body: { message: error instanceof Error ? error.message : 'The local data could not open.' } });
        },
    );

    let last = '';
    const stopEffects = $effect.root(() => {
        $effect(() => {
            const status = engineStatus();
            const json = JSON.stringify(status);
            if (json === last) return;
            last = json;
            post({ type: 'native:status', body: status });
        });
    });

    return () => {
        stopped = true;
        stopEffects();
        engine.ready = false;
        setPageVisibilityOverride(null);
        delete (window as { hearthlogNative?: NativeEndpoint }).hearthlogNative;
    };
}
