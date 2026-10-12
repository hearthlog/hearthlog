import { describe, expect, it, vi } from 'vitest';
import { executeLocalReset } from './reset-sequence.js';

describe('local recovery reset', () => {
    it('stops synchronization before deletion and reloads without further database work', async () => {
        const order: string[] = [];
        await executeLocalReset({
            stopSynchronization: vi.fn(async () => { order.push('stop'); }),
            markReset: vi.fn(() => { order.push('mark'); }),
            deleteDatabase: vi.fn(async () => { order.push('delete'); }),
            hardReload: vi.fn(() => { order.push('reload'); }),
        });
        expect(order).toEqual(['stop', 'mark', 'delete', 'reload']);
    });

    it('does not reload when deletion fails', async () => {
        const reload = vi.fn();
        await expect(executeLocalReset({
            stopSynchronization: vi.fn(async () => {}),
            markReset: vi.fn(),
            deleteDatabase: vi.fn(async () => { throw new Error('delete failed'); }),
            hardReload: reload,
        })).rejects.toThrow('delete failed');
        expect(reload).not.toHaveBeenCalled();
    });
});
