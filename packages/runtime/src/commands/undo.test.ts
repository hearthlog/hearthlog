import { describe, expect, it } from 'vitest';

import type { ExtendedAppEvent } from '../event/types.js';
import { undoEvents, undoTargets } from './undo.js';

function event(type: string, payload: Record<string, unknown>): ExtendedAppEvent {
    return { id: `event-${type}`, type, timestamp: 1, payload } as unknown as ExtendedAppEvent;
}

describe('undoTargets', () => {
    it('reverses an addition of standard records with their removal', () => {
        expect(undoTargets([
            event('CALENDAR_EVENT_ADDED', { id: 'a', title: 'Dentist' }),
            event('CALENDAR_EVENT_ADDED', { id: 'b', title: 'Rent' }),
        ])).toEqual([
            { type: 'CALENDAR_EVENT_REMOVED', id: 'a' },
            { type: 'CALENDAR_EVENT_REMOVED', id: 'b' },
        ]);
    });

    it('offers no undo for edits, removals or a mixed action', () => {
        expect(undoTargets([event('CALENDAR_EVENT_UPDATED', { id: 'a', title: 'Later' })])).toBeNull();
        expect(undoTargets([event('CALENDAR_EVENT_REMOVED', { id: 'a' })])).toBeNull();
        expect(undoTargets([
            event('CALENDAR_EVENT_ADDED', { id: 'a' }),
            event('CALENDAR_EVENT_UPDATED', { id: 'b', title: 'Later' }),
        ])).toBeNull();
    });

    it('offers no undo for events outside the standard entities or without a record id', () => {
        expect(undoTargets([event('SOMETHING_ELSE_ADDED', { id: 'a' })])).toBeNull();
        expect(undoTargets([event('CALENDAR_EVENT_ADDED', { title: 'No id' })])).toBeNull();
        expect(undoTargets([event('CALENDAR_EVENT_ADDED', { id: '' })])).toBeNull();
        expect(undoTargets([])).toBeNull();
    });
});

describe('undoEvents', () => {
    it('appends one removal per record, stamped when the undo runs', () => {
        const events = undoEvents([{ type: 'CALENDAR_EVENT_REMOVED', id: 'a' }], 42);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'CALENDAR_EVENT_REMOVED', timestamp: 42, payload: { id: 'a' } });
        expect(typeof events[0]!.id).toBe('string');
    });
});
