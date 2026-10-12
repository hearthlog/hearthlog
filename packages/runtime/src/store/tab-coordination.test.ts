import { describe, expect, it } from 'vitest';

import {
    createTabChannel,
    holdTabLock,
    scopeKey,
    withTabLock,
    type LockManagerLike,
    type TabChange,
} from './tab-coordination.js';

/** The Web Locks contract the code relies on: exclusive, queued, abortable while queued. */
function fakeLocks(): LockManagerLike {
    const tails = new Map<string, Promise<unknown>>();
    return {
        request(name, options, callback) {
            const previous = tails.get(name) ?? Promise.resolve();
            const run = new Promise<never>((resolve, reject) => {
                const abort = () => reject(new DOMException('Request withdrawn', 'AbortError'));
                if (options.signal?.aborted) return abort();
                options.signal?.addEventListener('abort', abort, { once: true });
                previous.then(() => {
                    if (options.signal?.aborted) return;
                    options.signal?.removeEventListener('abort', abort);
                    Promise.resolve(callback({ name })).then(resolve as (value: unknown) => void, reject);
                });
            });
            // The next requester waits for this one to finish or be withdrawn.
            tails.set(name, run.catch(() => undefined));
            return run;
        },
    };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('tab locks', () => {
    it('runs tasks one at a time, in request order', async () => {
        const locks = fakeLocks();
        const order: string[] = [];
        const slow = withTabLock('sync', async () => {
            order.push('a:start');
            await tick();
            order.push('a:end');
        }, locks);
        const fast = withTabLock('sync', async () => { order.push('b'); }, locks);
        await Promise.all([slow, fast]);
        expect(order).toEqual(['a:start', 'a:end', 'b']);
    });

    it('runs directly where Web Locks do not exist', async () => {
        expect(await withTabLock('sync', async () => 'done', null)).toBe('done');
        let acquired = false;
        holdTabLock('realtime', () => { acquired = true; }, null);
        await tick();
        expect(acquired).toBe(true);
    });

    it('hands a held lock to the next tab when the owner lets go', async () => {
        const locks = fakeLocks();
        const events: string[] = [];
        const releaseFirst = holdTabLock('realtime', () => { events.push('first'); }, locks);
        const releaseSecond = holdTabLock('realtime', () => { events.push('second'); }, locks);
        await tick();
        expect(events).toEqual(['first']);

        releaseFirst();
        await tick();
        expect(events).toEqual(['first', 'second']);
        releaseSecond();
    });

    it('withdraws a request that is still queued', async () => {
        const locks = fakeLocks();
        const events: string[] = [];
        const releaseFirst = holdTabLock('realtime', () => { events.push('first'); }, locks);
        const withdrawSecond = holdTabLock('realtime', () => { events.push('second'); }, locks);
        const releaseThird = holdTabLock('realtime', () => { events.push('third'); }, locks);
        await tick();
        withdrawSecond();
        releaseFirst();
        await tick();
        expect(events).toEqual(['first', 'third']);
        releaseThird();
    });
});

describe('tab channel', () => {
    const change: TabChange = { kind: 'ingest', tenantId: 'person', logId: 'personal' };

    it('delivers to other tabs and never back to the sender', async () => {
        const name = `test-${crypto.randomUUID()}`;
        const sender = createTabChannel(name);
        const receiver = createTabChannel(name);
        const fromSender: TabChange[] = [];
        const fromReceiver: TabChange[] = [];
        sender.subscribe((value) => fromSender.push(value));
        receiver.subscribe((value) => fromReceiver.push(value));

        sender.post(change);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fromReceiver).toEqual([change]);
        expect(fromSender).toEqual([]);
        sender.close();
        receiver.close();
    });

    it('ignores messages that are not tab changes', async () => {
        const name = `test-${crypto.randomUUID()}`;
        const raw = new BroadcastChannel(name);
        const receiver = createTabChannel(name);
        const received: TabChange[] = [];
        receiver.subscribe((value) => received.push(value));
        raw.postMessage({ kind: 'nonsense', tenantId: 'a', logId: 'b' });
        raw.postMessage('text');
        raw.postMessage(change);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(received).toEqual([change]);
        raw.close();
        receiver.close();
    });

    it('keys a scope by tenant and log', () => {
        expect(scopeKey({ tenantId: 'person', logId: 'personal' })).toBe('person:personal');
    });
});
