import { get as getKv, set as setKv } from '../db/kv.js';
import {
    clearActiveContext,
    getActiveContext,
    setActiveContext,
    type ActiveContext,
} from '../db/index.js';
import { getLedgerClient, loadLedgerConfig, type SessionResponse } from '../ledger/index.js';
import { tenant } from '@hearthlog/contracts/tenant/config';

interface CachedSession extends SessionResponse {
    ledgerOrigin: string;
}

export function getLedgerOrigin(): string {
    const baseUrl = loadLedgerConfig().baseUrl;
    const browserOrigin =
        typeof globalThis.location === 'undefined'
            ? 'http://localhost'
            : globalThis.location.origin;
    const url = new URL(baseUrl, browserOrigin);
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

export async function getLedgerCredentialFingerprint(): Promise<string> {
    const { authToken } = loadLedgerConfig();
    const credentialIdentity = authToken ?? `worker-managed:${getLedgerOrigin()}`;
    const bytes = new TextEncoder().encode(credentialIdentity);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

export async function getLedgerCacheKey(resource: string): Promise<string> {
    // The origin is stable when a tenant's frontend is redeployed. Include the
    // compiled tenant identity so a pre-isolation cache cannot carry a log or
    // session selection into the newly isolated tenant build.
    return `ledger-${resource}:${tenant.id}:${getLedgerOrigin()}:${await getLedgerCredentialFingerprint()}`;
}

export async function resolveLedgerSession(): Promise<CachedSession> {
    const cacheKey = await getLedgerCacheKey('session');
    const cached = await getKv<CachedSession>(cacheKey);
    // Reuse only this namespace's verified session when explicitly offline.
    // An online/unknown hint still follows the normal verification policy.
    if (cached && typeof navigator !== 'undefined' && navigator.onLine === false) {
        return cached;
    }
    const { authToken } = loadLedgerConfig();
    if (cached && authToken) {
        void getLedgerClient().getSession()
            .then((session) => setKv(cacheKey, { ...session, ledgerOrigin: getLedgerOrigin() }))
            .catch(() => undefined);
        return cached;
    }

    try {
        const session = await getLedgerClient().getSession();
        const verified = { ...session, ledgerOrigin: getLedgerOrigin() };
        await setKv(cacheKey, verified);
        return verified;
    } catch (error) {
        if (cached) return cached;
        throw new Error(
            'This Ledger credential must be verified online before its offline data can be opened',
            { cause: error },
        );
    }
}

export async function activateLogContext(logId: string): Promise<ActiveContext> {
    if (!logId) throw new Error('Cannot activate an empty Ledger log ID');
    const session = await resolveLedgerSession();
    const context: ActiveContext = {
        tenantId: session.appId,
        principalId: session.principalId,
        logId,
        ledgerOrigin: session.ledgerOrigin,
    };
    await setActiveContext(context);
    // Reload in-memory dynamic registry for this log (definitions are log-scoped)
    const { loadDynamicEntityTypes } = await import('../event/dynamic-entities.js');
    await loadDynamicEntityTypes();
    return context;
}

export async function deactivateLogContext(): Promise<void> {
    await clearActiveContext();
}

export { getActiveContext };
export { getSessionContext, setSessionContext } from '../db/session-context.js';
