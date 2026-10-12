import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    RETRY_MAX_DELAY_MS,
    SerialTaskQueue,
    CoalescedTaskQueue,
    classifyRealtimeVersion,
    computeRetryDeadline,
    computeRetryDelayMs,
    isTransientSyncFailure,
    withExclusiveSyncLock,
} from './sync-coordinator.js';
import { LedgerServiceError } from '../ledger/errors.js';

afterEach(() => vi.useRealTimers());

describe('coalesced sync refreshes', () => {
    it('refreshes at a fixed deadline even while changes keep arriving', async () => {
        vi.useFakeTimers();
        const task = vi.fn(async () => undefined);
        const queue = new CoalescedTaskQueue(task, 150);
        const first = queue.schedule();
        for (let elapsed = 0; elapsed < 100; elapsed += 50) {
            await vi.advanceTimersByTimeAsync(50);
            expect(queue.schedule()).toBe(first);
        }
        expect(task).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(50);
        await first;
        expect(task).toHaveBeenCalledTimes(1);

        const pending = queue.schedule();
        expect(queue.flush()).toBe(pending);
        await pending;
        expect(task).toHaveBeenCalledTimes(2);
    });

    it('runs again after an in-flight read when newer data arrives, without overlapping', async () => {
        vi.useFakeTimers();
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const task = vi.fn(async () => { if (task.mock.calls.length === 1) await held; });
        const queue = new CoalescedTaskQueue(task, 150);
        const first = queue.flush();
        const newer = queue.schedule();
        expect(newer).not.toBe(first);
        await vi.advanceTimersByTimeAsync(300);
        expect(task).toHaveBeenCalledTimes(1);
        expect(queue.flush()).toBe(newer);

        release();
        await Promise.all([first, newer]);
        expect(task).toHaveBeenCalledTimes(2);
    });

    it('reports a failed refresh and still processes the next change', async () => {
        vi.useFakeTimers();
        const failure = new Error('read failed');
        const task = vi.fn<() => Promise<void>>()
            .mockRejectedValueOnce(failure).mockResolvedValue(undefined);
        const queue = new CoalescedTaskQueue(task, 150);
        await expect(queue.flush()).rejects.toBe(failure);
        await expect(queue.flush()).resolves.toBeUndefined();
        expect(task).toHaveBeenCalledTimes(2);
    });
});

describe('retry backoff', () => {
    it('uses exponential delay with bounded jitter', () => {
        expect(computeRetryDelayMs(1, () => 0.5)).toBe(1_000);
        expect(computeRetryDelayMs(2, () => 0.5)).toBe(2_000);
        expect(computeRetryDelayMs(3, () => 0)).toBe(3_000);
        expect(computeRetryDelayMs(20, () => 1)).toBe(RETRY_MAX_DELAY_MS);
    });

    it('caps the delay however long Ledger stays unreachable', () => {
        expect(computeRetryDelayMs(5_000, () => 1)).toBe(RETRY_MAX_DELAY_MS);
    });

    it('retries only failures a later attempt can resolve', () => {
        expect(isTransientSyncFailure(new TypeError('Failed to fetch'))).toBe(true);
        expect(isTransientSyncFailure(new LedgerServiceError('Request timeout after 30000ms'))).toBe(true);
        expect(isTransientSyncFailure(new LedgerServiceError('Unavailable', 503))).toBe(true);
        expect(isTransientSyncFailure(new LedgerServiceError('Slow down', 429))).toBe(true);
        expect(isTransientSyncFailure(new LedgerServiceError('Preparing', 409, undefined, 'fork_preparing'))).toBe(true);
        expect(isTransientSyncFailure(new LedgerServiceError('Too large', 413, undefined, 'request_too_large'))).toBe(false);
        expect(isTransientSyncFailure(new Error('local bug'))).toBe(false);
    });

    it('returns a durable absolute retry deadline', () => {
        expect(computeRetryDeadline(2, 10_000, () => 0.5).getTime()).toBe(12_000);
    });
});

describe('withExclusiveSyncLock', () => {
    it('skips a drain when another tab owns the lock', async () => {
        const task = vi.fn(async () => undefined);
        const locks = {
            request: async <T>(
                _name: string,
                _options: { mode: 'exclusive'; ifAvailable: true },
                callback: (lock: unknown | null) => T | Promise<T>,
            ) => callback(null),
        };

        await expect(withExclusiveSyncLock('log', task, locks)).resolves.toBe(false);
        expect(task).not.toHaveBeenCalled();
    });
});

describe('SerialTaskQueue', () => {
    it('processes realtime events in arrival order', async () => {
        const queue = new SerialTaskQueue();
        const order: number[] = [];
        const first = queue.enqueue(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            order.push(1);
        });
        const second = queue.enqueue(async () => {
            order.push(2);
        });

        await Promise.all([first, second]);
        expect(order).toEqual([1, 2]);
    });

    it('runs ready only after all preceding catch-up events are durably applied', async () => {
        const queue = new SerialTaskQueue();
        let durableHead = 0;
        const order: string[] = [];
        void queue.enqueue(async () => {
            await Promise.resolve();
            durableHead = 1;
            order.push('event-1');
        });
        void queue.enqueue(async () => {
            durableHead = 2;
            order.push('event-2');
        });
        void queue.enqueue(async () => {
            expect(durableHead).toBe(2);
            order.push('ready');
        });

        await queue.idle();
        expect(order).toEqual(['event-1', 'event-2', 'ready']);
    });

    it('keeps shutdown pending until an active realtime task drains', async () => {
        const queue = new SerialTaskQueue();
        let release!: () => void;
        void queue.enqueue(() => new Promise<void>((resolve) => {
            release = resolve;
        }));
        let stopped = false;
        const stopping = queue.idle().then(() => {
            stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        release();
        await stopping;
        expect(stopped).toBe(true);
    });
});

describe('realtime version reconciliation', () => {
    it('drops duplicate self-echoes, applies only the next version, and resyncs gaps', () => {
        expect(classifyRealtimeVersion(4, 4)).toBe('duplicate');
        expect(classifyRealtimeVersion(4, 3)).toBe('duplicate');
        expect(classifyRealtimeVersion(4, 5)).toBe('apply');
        expect(classifyRealtimeVersion(4, 6)).toBe('resynchronize');
    });
});
