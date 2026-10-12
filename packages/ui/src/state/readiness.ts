import { get, writable } from 'svelte/store';

/** Read readiness is separate from both the mounted shell and network sync. */
export const workspaceReadiness = writable({ ready: false, key: '', error: null as unknown });

export function beginWorkspaceTransition(): void {
    workspaceReadiness.update((state) => ({ ...state, ready: false, error: null }));
}

export function completeWorkspaceTransition(key: string): void {
    workspaceReadiness.set({ ready: true, key, error: null });
}

export function failWorkspaceTransition(error: unknown): void {
    workspaceReadiness.update((state) => ({ ...state, ready: false, error }));
}

export function workspaceIsReady(): boolean {
    return get(workspaceReadiness).ready;
}
