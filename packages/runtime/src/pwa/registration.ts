import {
    checkOfflineReadiness,
    markOfflineReadinessFailed,
    markOfflineReadinessInstalling,
} from '../store/offline-readiness.svelte.js';
import { notify, type NotificationAction } from '@hearthlog/ui/state/notifications.svelte.js';

const BOOTSTRAP_WAIT_MS = 3_000;
const IDLE_WAIT_MS = 1_000;
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

type RegisterPwa = () => void | Promise<void>;

export interface PwaRegistrationSchedulerDependencies {
    register: RegisterPwa;
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
    requestIdleCallback?: (
        callback: () => void,
        options: { timeout: number },
    ) => number;
    requestAnimationFrame?: (callback: () => void) => number;
}

type PwaUpdateNotifier = (
    message: string,
    action?: NotificationAction,
) => unknown;

export function createPwaUpdatePrompt(
    notifyInfo: PwaUpdateNotifier,
    reload: () => void,
): () => void {
    let shown = false;

    return () => {
        if (shown) return;
        shown = true;
        notifyInfo('A new version of the app is available.', {
            label: 'Reload',
            run: reload,
        });
    };
}

function waitForBootstrap(
    bootstrapPromise: Promise<unknown>,
    dependencies: PwaRegistrationSchedulerDependencies,
): Promise<void> {
    return new Promise((resolve) => {
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            dependencies.clearTimeout(timeoutId);
            resolve();
        };
        const timeoutId = dependencies.setTimeout(finish, BOOTSTRAP_WAIT_MS);
        void bootstrapPromise.then(finish, finish);
    });
}

function waitForIdle(dependencies: PwaRegistrationSchedulerDependencies): Promise<void> {
    return new Promise((resolve) => {
        if (dependencies.requestIdleCallback) {
            dependencies.requestIdleCallback(resolve, { timeout: IDLE_WAIT_MS });
            return;
        }
        if (dependencies.requestAnimationFrame) {
            dependencies.requestAnimationFrame(resolve);
            return;
        }
        resolve();
    });
}

export function createPwaRegistrationScheduler(
    dependencies: PwaRegistrationSchedulerDependencies,
): (bootstrapPromise: Promise<unknown>) => Promise<void> {
    let scheduled: Promise<void> | null = null;

    return (bootstrapPromise) => {
        scheduled ??= waitForBootstrap(bootstrapPromise, dependencies)
            .then(() => waitForIdle(dependencies))
            .then(() => dependencies.register());
        return scheduled;
    };
}

async function registerPwa(): Promise<void> {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    markOfflineReadinessInstalling();

    try {
        const showUpdatePrompt = createPwaUpdatePrompt(
            notify.info,
            () => window.location.reload(),
        );
        const handleWorkerActivated = () => {
            showUpdatePrompt();
            void checkOfflineReadiness();
        };

        // A controller present before registration means any new worker is an
        // update; otherwise the first install is the offline-ready moment.
        const hadController = Boolean(navigator.serviceWorker.controller);
        const registration = await navigator.serviceWorker.register('/service-worker.js', {
            type: 'module',
            scope: '/',
        });

        registration.addEventListener('updatefound', () => {
            const worker = registration.installing;
            worker?.addEventListener('statechange', () => {
                if (worker.state !== 'activated') return;
                if (hadController) handleWorkerActivated();
                else void checkOfflineReadiness();
            });
        });
        scheduleServiceWorkerUpdateChecks(registration);
        void navigator.serviceWorker.ready.then(() => checkOfflineReadiness());

        // The replacement worker claims this page immediately. The current
        // document already has its chunks in memory, so let the user choose
        // when to reload after the replacement worker has activated.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            void checkOfflineReadiness();
        }, { once: true });
    } catch (error) {
        markOfflineReadinessFailed(error);
    }
}

function scheduleServiceWorkerUpdateChecks(registration: ServiceWorkerRegistration): void {
    const checkForUpdate = () => {
        if (!navigator.onLine || document.visibilityState !== 'visible') return;
        void registration.update().catch((error) => {
            console.debug('[PWA] Service worker update check failed:', error);
        });
    };

    window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', checkForUpdate);
    window.addEventListener('online', checkForUpdate);
}

const requestIdleCallback = typeof window !== 'undefined'
    ? (window as Window & {
          requestIdleCallback?: (
              callback: () => void,
              options: { timeout: number },
          ) => number;
      }).requestIdleCallback?.bind(window)
    : undefined;

const scheduleRegistration = createPwaRegistrationScheduler({
    register: registerPwa,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestIdleCallback,
    requestAnimationFrame: typeof window !== 'undefined'
        ? window.requestAnimationFrame.bind(window)
        : undefined,
});

export function schedulePwaRegistration(bootstrapPromise: Promise<unknown>): Promise<void> {
    return scheduleRegistration(bootstrapPromise);
}
