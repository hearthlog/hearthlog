import { describe, expect, it } from 'vitest';

import { withBusyRetry } from './index.js';

const noWait = async () => undefined;

describe('local commit under a busy database', () => {
    it('tries again while another tab holds the write lock, then succeeds', async () => {
        let calls = 0;
        const waits: number[] = [];
        const result = await withBusyRetry(async () => {
            calls += 1;
            if (calls < 3) throw new Error('SQLITE_BUSY: database is locked');
            return 'saved';
        }, [50, 100, 200], async (ms) => { waits.push(ms); });
        expect(result).toBe('saved');
        expect(calls).toBe(3);
        expect(waits).toEqual([50, 100]);
    });

    it('gives up after the last delay and reports the busy error', async () => {
        let calls = 0;
        await expect(withBusyRetry(async () => {
            calls += 1;
            throw new Error('database is locked');
        }, [1, 1], noWait)).rejects.toThrow('database is locked');
        expect(calls).toBe(3);
    });

    it('never repeats a failure that is not a busy database', async () => {
        let calls = 0;
        await expect(withBusyRetry(async () => {
            calls += 1;
            throw new Error('UNIQUE constraint failed');
        }, [1, 1], noWait)).rejects.toThrow('UNIQUE constraint failed');
        expect(calls).toBe(1);
    });
});
