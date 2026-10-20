/**
 * The page's side of a native app's engine: the hidden web view on `ENGINE_PATH` runs the
 * ordinary runtime, and this installs `window.hearthlogNative` for the app to call and posts
 * `native:*` messages back (protocol in `./bridge.ts`). Outside that web view nothing is posted.
 */

import { tenant } from '@hearthlog/contracts/tenant/config';
import { eventLogFilename } from '../store/event-log.svelte.js';
import { accessSessionState, getSyncPhase, runSyncCoordinator, syncStatus } from '../store/sync.svelte.js';
import { setPageVisibilityOverride } from '../runtime/visibility.js';
import { onInvalidation } from '../runtime/invalidation.js';
import {
    booleanArgument,
    createDispatcher,
    stringArgument,
    NATIVE_BRIDGE_VERSION,
    NativeCallError,
    type EngineContext,
    type EngineStatus,
    type NativeEndpoint,
    type NativeHandler,
    type NativeMessage,
} from './bridge.js';
import type { NativeApi } from './api.js';
import { nativeRegistry } from './registry.js';
import { shell } from './shell.js';
import { logs } from '../store/logs.svelte.js';

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
    /** The logs this device knows, newest list from the Ledger when online, and the open one. */
    'engine.logs': () => ({
        currentLogId: eventLogFilename.value || null,
        logs: logs.value.map((log) => ({ id: log.id, name: log.name, headVersion: log.headVersion, lastUpdatedAt: log.lastUpdatedAt })),
    }),
};

/** What the shell gives the engine that the runtime cannot do alone. */
export interface NativeEngineHost {
    /** Opens another log (`switch-log.ts` in the shell); false when there is no such log to open. */
    switchLog?: (logId: string) => Promise<boolean>;
}

/** Changed keys gathered over this long are sent as one `native:changed`. */
const CHANGE_DEBOUNCE_MS = 150;

/**
 * Installs the endpoint and starts reporting. `ready` is the workspace opening (the layout load's
 * `workspace.ready`); `loadApis` loads the enabled modules' native APIs (the composed `(modules)/native`).
 * `native:ready` follows both, or `native:failed` when either cannot finish.
 */
export function startNativeEngine(ready: Promise<unknown>, loadApis: () => Promise<readonly NativeApi[]> = async () => [], host: NativeEngineHost = {}): () => void {
    // A hidden web view is never "visible" to WebKit; the app decides instead.
    setPageVisibilityOverride(engine.active);
    // Module functions join once their code has loaded; until then they answer `unknown_function`.
    const handlers: Record<string, NativeHandler> = {
        ...CORE_HANDLERS,
        /** Opens another of `engine.logs`; answers the new context once its data is read. */
        'engine.switchLog': async (args) => {
            requireReady();
            const logId = stringArgument(args, 'logId');
            if (!host.switchLog) throw new NativeCallError('failed', 'This engine cannot switch logs.');
            if (!(await host.switchLog(logId))) throw new NativeCallError('invalid_arguments', 'No log on this device has that id.');
            return engineContext();
        },
    };
    const call = createDispatcher(handlers);
    Object.defineProperty(window, 'hearthlogNative', {
        value: Object.freeze({ version: NATIVE_BRIDGE_VERSION, call } satisfies NativeEndpoint),
        configurable: true,
        enumerable: false,
    });

    let stopped = false;
    Promise.all([ready, loadApis()]).then(([, apis]) => nativeRegistry(apis, { beforeCall: requireReady })).then(
        (registry) => {
            if (stopped) return;
            Object.assign(handlers, registry.handlers);
            engine.ready = true;
            post({ type: 'native:ready', body: { bridgeVersion: NATIVE_BRIDGE_VERSION, context: engineContext(), apis: registry.versions } });
        },
        (error: unknown) => {
            if (stopped) return;
            post({ type: 'native:failed', body: { message: error instanceof Error ? error.message : 'The local data could not open.' } });
        },
    );

    let changed = new Set<string>();
    let changeTimer: ReturnType<typeof setTimeout> | undefined;
    const stopChanges = onInvalidation((keys) => {
        for (const key of keys) changed.add(key);
        clearTimeout(changeTimer);
        changeTimer = setTimeout(() => {
            const body = { keys: [...changed].sort() };
            changed = new Set();
            post({ type: 'native:changed', body });
        }, CHANGE_DEBOUNCE_MS);
    });

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
        stopChanges();
        clearTimeout(changeTimer);
        stopEffects();
        engine.ready = false;
        setPageVisibilityOverride(null);
        delete (window as { hearthlogNative?: NativeEndpoint }).hearthlogNative;
    };
}
