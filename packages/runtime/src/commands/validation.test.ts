import { describe, expect, it, vi } from 'vitest';

import type { AddCalendarEventEvent } from '../event/index.js';
import type { ExtendedAppEvent } from '../event/types.js';
import { CommandValidationError, validateCommandEvents } from './validation.js';

vi.mock('@hearthlog/contracts/event/entity-definitions', async (importOriginal) =>
    (await import('../testing/test-entities.js')).withTestEntities(await importOriginal()));

function validAmountEvent(): ExtendedAppEvent {
    return {
        id: 'event-1',
        type: 'TEST_AMOUNT_ADDED',
        timestamp: 1,
        payload: { id: 'amount-1', name: 'Cash', amount: 100 },
    } as unknown as ExtendedAppEvent;
}

describe('validateCommandEvents', () => {
    it('accepts a valid domain event', () => {
        expect(() => validateCommandEvents([validAmountEvent()])).not.toThrow();
    });

    it('rejects missing required fields and invalid numbers before persistence', () => {
        const missing = validAmountEvent();
        (missing.payload as unknown as Record<string, unknown>).name = '';
        expect(() => validateCommandEvents([missing])).toThrow('requires name');

        const invalid = validAmountEvent();
        (invalid.payload as unknown as Record<string, unknown>).amount = Number.NaN;
        expect(() => validateCommandEvents([invalid])).toThrow(CommandValidationError);
    });

    it('rejects duplicate event IDs within a command', () => {
        const event = validAmountEvent();
        expect(() => validateCommandEvents([event, event])).toThrow('Duplicate event ID');
    });

    it('rejects new legacy history mutation commands', () => {
        for (const type of ['EVENT_TOMBSTONED', 'EVENTS_EXCISED', 'WORKSPACE_RESTORED']) {
            const event = { id: `event-${type}`, type, timestamp: 1, payload: {} } as ExtendedAppEvent;
            expect(() => validateCommandEvents([event])).toThrow('history removal and restore commands are retired');
        }
    });

    it('recognizes generated calendar event requirements', () => {
        const event: AddCalendarEventEvent = {
            id: 'event-calendar-1',
            type: 'CALENDAR_EVENT_ADDED',
            timestamp: 1,
            payload: {
                id: 'calendar-1',
                title: 'Launch',
                eventDate: '2026-07-22',
                startTime: '',
                notes: '',
                pinned: true,
            },
        };
        expect(() => validateCommandEvents([event])).not.toThrow();

        event.payload.eventDate = '';
        expect(() => validateCommandEvents([event])).toThrow('requires eventDate');
    });
});
