import { afterEach, describe, expect, it, vi } from 'vitest';
import { LedgerClient } from './http-client.js';
import type { LedgerConfig } from './config.js';

const config: LedgerConfig = {
    baseUrl: '/api/ledger',
    timeout: 5000,
    retryPolicy: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 10000, backoffMultiplier: 2 },
    enableRealtime: false,
};

afterEach(() => vi.unstubAllGlobals());

describe('Ledger session and replay capabilities', () => {
    it('shares an in-flight verification and applies its capabilities to subsequent replay', async () => {
        let respond!: (response: Response) => void;
        const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => { respond = resolve; }));
        vi.stubGlobal('fetch', fetch);
        const client = new LedgerClient(config);
        const session = client.getSession();
        const capabilities = Promise.all([
            client.getActionMetadataSupport(), client.getWorkspaceRestoreSupport(), client.getEventExcisionSupport(),
        ]);
        expect(fetch).toHaveBeenCalledOnce();
        respond(Response.json({ appId: 'app', principalId: 'owner', capabilities: ['action-metadata-v1', 'workspace-restore-v1', 'event-excision-v1'] }));
        await expect(session).resolves.toMatchObject({ appId: 'app' });
        await expect(capabilities).resolves.toEqual([true, true, true]);

        fetch.mockImplementation(async () => Response.json({ events: [] }));
        await client.getEventPage('log');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(new Headers(fetch.mock.calls[1][1]?.headers).get('X-Ledger-Replay-Version')).toBe('2');
    });

    it('retries verification after rejection and re-verifies explicit session reads after completion', async () => {
        const fetch = vi.fn().mockResolvedValueOnce(Response.json({ code: 'unauthorized' }, { status: 401 }))
            .mockImplementation(async () => Response.json({ appId: 'app', principalId: 'owner' }));
        vi.stubGlobal('fetch', fetch);
        const client = new LedgerClient(config);
        const results = await Promise.allSettled([client.getSession(), client.getWorkspaceRestoreSupport()]);
        expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
        expect(fetch).toHaveBeenCalledOnce();
        await expect(client.getSession()).resolves.toMatchObject({ appId: 'app' });
        await expect(client.getSession()).resolves.toMatchObject({ appId: 'app' });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('keeps sessions and replay capabilities isolated for explicitly configured transports', async () => {
        const fetch = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.endsWith('/events?afterVersion=0&limit=512')
            ? { events: [] }
            : { appId: url.startsWith('https://one.example') ? 'one' : 'two', principalId: 'owner',
                capabilities: url.startsWith('https://one.example') ? ['workspace-restore-v1', 'event-excision-v1'] : [] }));
        vi.stubGlobal('fetch', fetch);
        const one = new LedgerClient({ ...config, baseUrl: 'https://one.example', authToken: 'test-one' });
        const two = new LedgerClient({ ...config, baseUrl: 'https://two.example', authToken: 'test-two' });
        const sessions = await Promise.all([one.getSession(), two.getSession()]);
        expect(sessions.map((session) => session.appId)).toEqual(['one', 'two']);
        await Promise.all([one.getEventPage('log'), two.getEventPage('log')]);
        expect(fetch).toHaveBeenCalledTimes(4);
        const headers = fetch.mock.calls.map((call) => new Headers(call[1]?.headers));
        expect(headers[2].get('Authorization')).toBe('Bearer test-one');
        expect(headers[2].get('X-Ledger-Replay-Version')).toBe('2');
        expect(headers[3].get('Authorization')).toBe('Bearer test-two');
        expect(headers[3].get('X-Ledger-Replay-Version')).toBeNull();
    });
});
