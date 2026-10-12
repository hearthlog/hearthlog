import { describe, expect, it } from 'vitest';

import {
    eventApprovalError,
    CommandValidationError,
} from './validation.js';

describe('event feature approval', () => {
    it('allows events of enabled features', () => {
        expect(
            eventApprovalError('CALENDAR_EVENT_ADDED', new Set(['calendar'])),
        ).toBeNull();
    });

    it('rejects events of features the tenant does not have', () => {
        const error = eventApprovalError(
            'CALENDAR_EVENT_ADDED',
            new Set(['finance']),
        );
        expect(error).toContain('calendar_events');
        expect(error).toContain('"calendar"');
        expect(() => {
            throw new CommandValidationError(error!);
        }).toThrow(CommandValidationError);
    });

    it('lets dynamic and unknown event types pass (gated separately)', () => {
        expect(eventApprovalError('CUSTOMTHING_ADDED', new Set())).toBeNull();
        expect(eventApprovalError('EVENT_TOMBSTONED', new Set())).toBeNull();
    });
});
