import { get, writable } from 'svelte/store';
import { createSubscriber } from 'svelte/reactivity';

interface ApplicationViewState {
    effectiveNow: string;
    revision: number;
}

type InternalApplicationViewState = ApplicationViewState & { initialized: boolean };

const initialState: InternalApplicationViewState = {
    effectiveNow: new Date().toISOString(),
    revision: 0,
    initialized: false,
};

// SAFETY: keyed on a private globalThis field that this module alone writes; a
// stale/mismatched value can only come from an incompatible older build.
const globalForApplicationView = globalThis as unknown as {
    storApplicationViewStore?: ReturnType<typeof writable<InternalApplicationViewState>>;
    storApplicationViewWaiters?: Array<(date: Date) => void>;
};
const state = globalForApplicationView.storApplicationViewStore ?? writable(initialState);
globalForApplicationView.storApplicationViewStore = state;
const readyWaiters = globalForApplicationView.storApplicationViewWaiters ?? [];
globalForApplicationView.storApplicationViewWaiters = readyWaiters;

// Lets `$derived(appClock.now())` and effects follow the clock as it advances.
const trackClock = createSubscriber((update) => {
    let initial = true;
    return state.subscribe(() => {
        if (initial) {
            initial = false;
            return;
        }
        update();
    });
});

export const appClock = {
    now(): Date {
        trackClock();
        return new Date(get(state).effectiveNow);
    },
    iso(): string {
        trackClock();
        return get(state).effectiveNow;
    },
    ready(): Promise<Date> {
        const current = get(state);
        if (current.initialized) return Promise.resolve(new Date(current.effectiveNow));
        return new Promise((resolve) => readyWaiters.push(resolve));
    },
};

/** Existing callers use this for internal links; routes no longer carry a read version. */
export function contextualHref(path: string, _currentUrl?: URL): string { return path; }

export function updateApplicationView(input: { effectiveNow: string }): void {
    state.update((current) => ({
        effectiveNow: input.effectiveNow,
        revision: current.revision + 1,
        initialized: true,
    }));
    const now = new Date(input.effectiveNow);
    for (const resolve of readyWaiters.splice(0)) resolve(now);
}

export function beginApplicationViewTransition(): void {
    state.update((current) => ({ ...current, initialized: false }));
}

export function cancelApplicationViewTransition(): void {
    const current = get(state);
    state.set({ ...current, initialized: true });
    const now = new Date(current.effectiveNow);
    for (const resolve of readyWaiters.splice(0)) resolve(now);
}

export function resetApplicationView(): void {
    state.set({ ...initialState, effectiveNow: new Date().toISOString() });
    readyWaiters.splice(0);
}
