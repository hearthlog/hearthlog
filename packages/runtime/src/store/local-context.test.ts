import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerConfig } from '../ledger/config.js';
import type { SessionResponse } from '../ledger/types.js';

const state = vi.hoisted(() => ({
    cache: new Map<string, unknown>(),
    tenant: { id: 'st' },
    config: {} as LedgerConfig,
    set: vi.fn(),
}));

vi.mock('../db/kv.js', () => ({
    get: async (key: string) => state.cache.get(key) ?? null,
    set: state.set,
}));
vi.mock('../db/index.js', () => ({
    clearActiveContext: vi.fn(),
    getActiveContext: vi.fn(),
    setActiveContext: vi.fn(),
}));
vi.mock('@hearthlog/contracts/tenant/config', () => ({ tenant: state.tenant }));
vi.mock('../ledger/index.js', async () => {
    const transport = await import('../ledger/http-client.js');
    let client: InstanceType<typeof transport.LedgerClient> | null = null;
    return {
        ...transport,
        loadLedgerConfig: () => state.config,
        getLedgerClient: () => client ??= new transport.LedgerClient(state.config),
    };
});

const cached = {
    appId: 'cached-app',
    principalId: 'cached-principal',
    ledgerOrigin: 'https://st.example/api/ledger',
};
const verified: SessionResponse = { appId: 'verified-app', principalId: 'verified-principal' };

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.cache.clear();
    state.tenant.id = 'st';
    state.config = {
        baseUrl: '/api/ledger',
        timeout: 5000,
        retryPolicy: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 10000, backoffMultiplier: 2 },
        enableRealtime: false,
    };
    state.set.mockImplementation(async (key: string, value: unknown) => {
        state.cache.set(key, value);
    });
    vi.stubGlobal('location', { origin: 'https://st.example' });
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(verified)));
});

afterEach(() => vi.unstubAllGlobals());

describe('Ledger session resolution', () => {
    it.each([undefined, 'test-credential'])(
        'opens verified cached data offline without an HTTP attempt (token: %s)',
        async (authToken) => {
            state.config.authToken = authToken;
            const { getLedgerCacheKey, resolveLedgerSession } = await import('./local-context.js');
            state.cache.set(await getLedgerCacheKey('session'), cached);

            await expect(resolveLedgerSession()).resolves.toEqual(cached);
            expect(fetch).not.toHaveBeenCalled();
            expect(state.set).not.toHaveBeenCalled();
        },
    );

    it.each(['tenant', 'origin', 'credential'])(
        'does not open another %s cache when offline verification fails',
        async (namespace) => {
            const { getLedgerCacheKey, resolveLedgerSession } = await import('./local-context.js');
            state.cache.set(await getLedgerCacheKey('session'), cached);
            if (namespace === 'tenant') state.tenant.id = 'other';
            if (namespace === 'origin') vi.stubGlobal('location', { origin: 'https://other.example' });
            if (namespace === 'credential') state.config.authToken = 'other-credential';
            vi.mocked(fetch).mockRejectedValue(new TypeError('Offline'));

            await expect(resolveLedgerSession()).rejects.toThrow('must be verified online');
            expect(fetch).toHaveBeenCalledOnce();
            expect(state.set).not.toHaveBeenCalled();
        },
    );

    it('requires online verification for a first-device session even while offline', async () => {
        const { resolveLedgerSession } = await import('./local-context.js');
        vi.mocked(fetch).mockRejectedValue(new TypeError('Offline'));

        await expect(resolveLedgerSession()).rejects.toThrow('must be verified online');
        expect(state.cache.size).toBe(0);
        expect(state.set).not.toHaveBeenCalled();
    });

    it.each([true, undefined])('verifies gateway sessions when online state is %s', async (onLine) => {
        vi.stubGlobal('navigator', onLine === undefined ? undefined : { onLine });
        const { getLedgerCacheKey, resolveLedgerSession } = await import('./local-context.js');
        const key = await getLedgerCacheKey('session');
        state.cache.set(key, cached);

        await expect(resolveLedgerSession()).resolves.toEqual({ ...verified, ledgerOrigin: cached.ledgerOrigin });
        expect(fetch).toHaveBeenCalledOnce();
        const [url, request] = vi.mocked(fetch).mock.calls[0];
        expect(url).toBe('/api/ledger/session');
        expect(request?.cache).toBe('no-store');
        expect(request?.credentials).toBe('same-origin');
        expect(new Headers(request?.headers).get('X-Requested-With')).toBe('XMLHttpRequest');
        expect(state.cache.get(key)).toEqual({ ...verified, ledgerOrigin: cached.ledgerOrigin });
    });

    it('still starts Access reauthentication on an expired online session and retains the cache', async () => {
        vi.stubGlobal('navigator', { onLine: true });
        const assign = vi.fn();
        vi.stubGlobal('window', {
            location: { origin: 'https://st.example', href: 'https://st.example/finance', assign },
        });
        vi.mocked(fetch).mockResolvedValue(new Response('Sign in', {
            status: 401,
            headers: { 'content-type': 'text/html' },
        }));
        const { getLedgerCacheKey, resolveLedgerSession } = await import('./local-context.js');
        const key = await getLedgerCacheKey('session');
        state.cache.set(key, cached);

        await expect(resolveLedgerSession()).resolves.toEqual(cached);
        expect(fetch).toHaveBeenCalledOnce();
        expect(assign).toHaveBeenCalledOnce();
        const destination = new URL(assign.mock.calls[0][0]);
        expect(destination.pathname).toBe('/finance');
        expect(destination.searchParams.has('__stor_access_reauth')).toBe(true);
        expect(state.cache.get(key)).toEqual(cached);
        expect(state.set).not.toHaveBeenCalled();
    });
});
