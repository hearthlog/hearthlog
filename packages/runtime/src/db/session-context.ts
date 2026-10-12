/**
 * Tab-local Ledger context.
 *
 * OPFS is shared across tabs, but each tab's JS heap is not. This module is the
 * source of truth for "which log is this tab working on?" so concurrent tabs
 * cannot stomp each other via a single ambient DB row.
 *
 * The active_context table remains a last-used default for cold start only.
 */

export interface ActiveContext {
    tenantId: string;
    principalId: string;
    logId: string;
    ledgerOrigin: string;
}

let sessionContext: ActiveContext | null = null;

export function getSessionContext(): ActiveContext | null {
    return sessionContext;
}

export function setSessionContext(context: ActiveContext | null): void {
    sessionContext = context;
}

export function requireSessionContext(): ActiveContext {
    if (!sessionContext) {
        throw new Error('Local Ledger context has not been initialized in this tab');
    }
    return sessionContext;
}
