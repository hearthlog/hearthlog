import { derived, get } from 'svelte/store';
import { workspaceReadiness } from './readiness.js';

export interface CommandAvailability {
    available: boolean;
    unavailableReason: string | null;
}

export const commandAvailability = derived(workspaceReadiness, (workspace): CommandAvailability => ({
    available: workspace.ready,
    unavailableReason: workspace.ready ? null : 'Wait for local data to open.',
}));

export function runCommandAction(action: () => void): boolean {
    if (!get(commandAvailability).available) return false;
    action();
    return true;
}

export function commandActionsAvailable(): boolean {
    return get(commandAvailability).available;
}
