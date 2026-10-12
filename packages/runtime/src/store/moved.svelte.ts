import { del, get, set } from '../db/kv.js';
import { isLedgerServiceError } from '../ledger/errors.js';

/**
 * A workspace that moved to another origin. The old origin's Ledger answers
 * writes with 410 `tenant_moved`; this device then stops sending, keeps its
 * queued work, and offers to export it (see pending-work.ts). The flag is kept
 * on the device so a reload does not start sending again.
 */

const KEY = 'stor:workspace-moved';

export interface MovedWorkspace {
    /** The origin the workspace lives at now, when the old one said so. */
    destination: string | null;
    detectedAt: string;
}

export const movedWorkspace = $state<{ value: MovedWorkspace | null }>({ value: null });

/** The destination named by a "moved" answer, or null when the error is anything else. */
export function movedDestination(error: unknown): { destination: string | null } | null {
    if (!isLedgerServiceError(error) || error.statusCode !== 410 || error.code !== 'tenant_moved') return null;
    const destination = (error.response as { destination?: unknown } | undefined)?.destination;
    return { destination: typeof destination === 'string' ? destination : null };
}

export async function markWorkspaceMoved(destination: string | null): Promise<void> {
    if (movedWorkspace.value) return;
    const moved: MovedWorkspace = { destination, detectedAt: new Date().toISOString() };
    movedWorkspace.value = moved;
    await set(KEY, moved).catch(() => undefined);
}

export async function restoreMovedWorkspace(): Promise<void> {
    movedWorkspace.value = await get<MovedWorkspace>(KEY).catch(() => null);
}

/** Sending again after the operator lifted the fence, or when this origin turns out to be the new home. */
export async function clearMovedWorkspace(): Promise<void> {
    movedWorkspace.value = null;
    await del(KEY).catch(() => undefined);
}
