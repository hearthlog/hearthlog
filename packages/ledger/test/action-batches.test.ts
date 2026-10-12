import { describe, expect, it } from 'vitest';
import { actionBatches } from '../src/action-batches';
import type { StoredEvent } from '../src/schemas';
const event = (version: number, action?: StoredEvent['action']): StoredEvent => ({
    id: crypto.randomUUID(), version, type: 'BOOK_ADDED', entityId: `book:${version}`,
    entityVersion: 1, timestamp: 1, payload: {}, ...(action ? { action } : {}),
});
describe('logical backup action boundaries', () => {
    it('reassembles an action across export pages without changing legacy events', () => {
        const id = crypto.randomUUID();
        const pages = [[event(1), event(2, { id, index: 0, size: 2 })],
            [event(3, { id, index: 1, size: 2 }), event(4)]];
        expect([...actionBatches(pages.flat())].map(batch => batch.map(e => e.version)))
            .toEqual([[1], [2, 3], [4]]);
    });
    it('rejects incomplete, reordered and repeated actions before restore', () => {
        const id = crypto.randomUUID();
        const first = event(1, { id, index: 0, size: 2 });
        const last = event(2, { id, index: 1, size: 2 });
        for (const events of [[first], [last, first], [first, last, first, last]]) {
            expect(() => [...actionBatches(events)]).toThrow();
        }
    });
});
