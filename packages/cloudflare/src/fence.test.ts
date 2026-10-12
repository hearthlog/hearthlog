import { describe, expect, it, vi } from 'vitest';

import { fencedWrite, readFence } from './fence';

const ledger = (respond: () => Response | Promise<Response>) => ({
    LEDGER: { fetch: vi.fn(async () => respond()) } as unknown as Env['LEDGER'],
    LEDGER_AUTH_TOKEN: 'app-token',
});
const session = (fence?: unknown) => Response.json({ appId: 'a', principalId: 'p', ...(fence ? { fence } : {}) });
const write = new Request('https://stor.example/api/gallery-files/v1/x', { method: 'PUT' });
const read = new Request('https://stor.example/api/gallery-files/v1/x');

describe('gateway write fence', () => {
    it('pauses writes with a retryable 503 and leaves reads alone', async () => {
        const env = ledger(() => session({ mode: 'tenant_migrating', destination: null }));
        const refused = await fencedWrite(write, env);
        expect(refused?.status).toBe(503);
        expect(refused?.headers.get('Retry-After')).toBe('30');
        expect(await refused?.json()).toMatchObject({ code: 'tenant_migrating' });
        expect(await fencedWrite(read, env)).toBeNull();
    });

    it('answers a moved workspace with 410 and the destination', async () => {
        const refused = await fencedWrite(write, ledger(() => session({ mode: 'moved', destination: 'https://new.example.com' })));
        expect(refused?.status).toBe(410);
        expect(await refused?.json()).toMatchObject({ code: 'tenant_moved', destination: 'https://new.example.com' });
        const unauthorized = await fencedWrite(write, ledger(() => new Response(null, { status: 410 })));
        expect(unauthorized?.status).toBe(410);
    });

    it('lets writes through when nothing is fenced, and when the Ledger cannot be asked', async () => {
        expect(await fencedWrite(write, ledger(() => session()))).toBeNull();
        expect(await fencedWrite(write, ledger(() => { throw new Error('binding down'); }))).toBeNull();
        expect(await fencedWrite(write, ledger(() => new Response(null, { status: 500 })))).toBeNull();
    });

    it('asks the Ledger at most once in a few seconds', async () => {
        const env = ledger(() => session({ mode: 'tenant_migrating' }));
        await readFence(env, 1_000);
        await readFence(env, 3_000);
        expect(env.LEDGER.fetch).toHaveBeenCalledTimes(1);
        await readFence(env, 7_000);
        expect(env.LEDGER.fetch).toHaveBeenCalledTimes(2);
    });
});
