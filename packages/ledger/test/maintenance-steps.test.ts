import { describe, expect, it } from 'vitest';
import { MaintenanceSteps } from '../src/maintenance-steps';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

describe('maintenance progress responses', () => {
    it('returns progress while slow work remains alive, coalesces retries, and permits the next step after completion', async () => {
        const kept: Promise<unknown>[] = [];
        const runner = new MaintenanceSteps<number>(work => { kept.push(work); }, 10);
        const slow = deferred<number>();
        let executions = 0;
        const work = () => { executions++; return slow.promise; };
        const responses = await Promise.all(Array.from({ length: 20 }, () => runner.advance('job', work, () => 0)));
        expect(responses).toEqual(Array(20).fill(0));
        expect(executions).toBe(1);
        expect(kept).toHaveLength(1);
        let finished = false;
        void kept[0]!.then(() => { finished = true; });
        expect(finished).toBe(false);
        slow.resolve(1);
        await kept[0];
        expect(await runner.advance('job', async () => { executions++; return 2; }, () => 1)).toBe(2);
        expect(executions).toBe(2);
    });

    it('serializes different operations without blocking their progress responses', async () => {
        const kept: Promise<unknown>[] = [];
        const runner = new MaintenanceSteps<number>(work => { kept.push(work); }, 10);
        const slow = deferred<number>();
        const order: string[] = [];
        const first = runner.advance('one', () => { order.push('one'); return slow.promise; }, () => 0);
        const second = runner.advance('two', async () => { order.push('two'); return 2; }, () => 0);
        expect(await Promise.all([first, second])).toEqual([0, 0]);
        expect(order).toEqual(['one']);
        slow.resolve(1);
        await Promise.all(kept);
        expect(order).toEqual(['one', 'two']);
    });

    it('releases the queue after a failed step', async () => {
        const runner = new MaintenanceSteps<number>(() => undefined, 10);
        await expect(runner.advance('job', async () => { throw new Error('archive unavailable'); }, () => 0)).rejects.toThrow('archive unavailable');
        expect(await runner.advance('job', async () => 1, () => 0)).toBe(1);
    });
});
