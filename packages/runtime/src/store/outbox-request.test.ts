import { describe, expect, it } from 'vitest';

import { hashRequest, MAX_BATCH_SIZE, prepareAppendRequest, type PendingBatchEvent } from './outbox-request.js';

function event(id: string, entityId: string, payload: Record<string, unknown> = {}): PendingBatchEvent {
    return {
        id,
        entityId,
        type: 'TEST_EVENT',
        timestamp: 1,
        payload,
        localSequence: Number(id.replace(/\D/g, '')) || 1,
    };
}

describe('prepareAppendRequest', () => {
    it('builds a new-entity chain with omitted, 1, and 2 bases', () => {
        const request = prepareAppendRequest(
            [event('event-1', 'entity-a'), event('event-2', 'entity-a'), event('event-3', 'entity-a')],
            new Map(),
            'request-1',
        );

        expect(request.events.map((item) => item.baseEntityVersion)).toEqual([undefined, 1, 2]);
    });

    it('builds independent existing-entity chains in request order', () => {
        const request = prepareAppendRequest(
            [
                event('event-1', 'entity-a'),
                event('event-2', 'entity-b'),
                event('event-3', 'entity-a'),
                event('event-4', 'entity-b'),
            ],
            new Map([['entity-a', 7], ['entity-b', 2]]),
            'request-2',
        );

        expect(request.events.map((item) => item.baseEntityVersion)).toEqual([7, 2, 8, 3]);
    });

    it('accepts as many events as one Ledger append allows', () => {
        const events = (count: number) => Array.from({ length: count }, (_, index) => event(`event-${index + 1}`, `entity-${index + 1}`));

        expect(MAX_BATCH_SIZE).toBe(512);
        expect(prepareAppendRequest(events(MAX_BATCH_SIZE), new Map(), 'request-5').events).toHaveLength(MAX_BATCH_SIZE);
        expect(() => prepareAppendRequest(events(MAX_BATCH_SIZE + 1), new Map(), 'request-6')).toThrow(`limited to ${MAX_BATCH_SIZE} events`);
    });
});

describe('hashRequest', () => {
    it('is stable when nested payload object keys are reordered', async () => {
        const left = prepareAppendRequest(
            [event('event-1', 'entity-a', { z: 1, nested: { b: 2, a: 1 } })],
            new Map(),
            'request-3',
        );
        const right = prepareAppendRequest(
            [event('event-1', 'entity-a', { nested: { a: 1, b: 2 }, z: 1 })],
            new Map(),
            'request-3',
        );

        await expect(hashRequest(left)).resolves.toBe(await hashRequest(right));
    });

    it('preserves event ordering in the hash', async () => {
        const first = prepareAppendRequest(
            [event('event-1', 'entity-a'), event('event-2', 'entity-b')],
            new Map(),
            'request-4',
        );
        const reversed = prepareAppendRequest(
            [event('event-2', 'entity-b'), event('event-1', 'entity-a')],
            new Map(),
            'request-4',
        );

        expect(await hashRequest(first)).not.toBe(await hashRequest(reversed));
    });
});
