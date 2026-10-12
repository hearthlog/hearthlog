/**
 * The write fence of a tenant move.
 *
 * While an application is being exported and imported elsewhere, writes to it
 * must stop, or the copy would miss them. `tenant_migrating` is a pause: the
 * Ledger answers 503 with `Retry-After`, which the app's outbox already treats
 * as transient, so queued work waits and lands exactly once afterwards.
 * `moved` is final: the application lives elsewhere, and the Ledger answers
 * 410 with the destination, so an old client can say so and offer to export
 * its pending work. Reads stay open in both modes.
 *
 * The fence is enforced here on the server; a banner in the frontend cannot
 * stop an old cached client.
 */

import { LedgerError, validationError } from "./errors";

export type FenceMode = "tenant_migrating" | "moved";

export interface Fence {
    mode: FenceMode;
    /** Where the application lives now; only for `moved`. */
    destination: string | null;
}

/** What an administrator sets: `off` lifts the fence. */
export interface FenceRequest {
    mode: FenceMode | "off";
    destination?: string | null;
}

export const RETRY_AFTER_SECONDS = 30;

export function parseFence(mode: unknown, destination: unknown): Fence | null {
    if (mode !== "tenant_migrating" && mode !== "moved") return null;
    return { mode, destination: typeof destination === "string" && destination ? destination : null };
}

export function validateFenceRequest(request: FenceRequest): Fence | null {
    if (request.mode === "off") {
        if (request.destination) throw validationError("destination only goes with the moved mode");
        return null;
    }
    if (request.mode === "tenant_migrating") {
        if (request.destination) throw validationError("destination only goes with the moved mode");
        return { mode: "tenant_migrating", destination: null };
    }
    let url: URL;
    try {
        url = new URL(String(request.destination));
    } catch {
        throw validationError("moved needs the destination origin");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw validationError("destination must be an HTTPS origin");
    }
    return { mode: "moved", destination: url.origin };
}

/** The error a fenced write gets. */
export function fenceError(fence: Fence): LedgerError {
    if (fence.mode === "tenant_migrating") {
        return new LedgerError(503, {
            error: "Unavailable",
            code: "tenant_migrating",
            message: "This workspace is being moved; writes resume shortly",
            retryAfterSeconds: RETRY_AFTER_SECONDS,
        });
    }
    return new LedgerError(410, {
        error: "Gone",
        code: "tenant_moved",
        message: "This workspace has moved",
        ...(fence.destination ? { destination: fence.destination } : {}),
    });
}
