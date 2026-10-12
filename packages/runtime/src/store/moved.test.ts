import { describe, expect, it } from 'vitest';

import { LedgerServiceError } from '../ledger/errors.js';
import { isTransientSyncFailure } from './sync-coordinator.js';
import { movedDestination } from './moved.svelte.js';

describe('a moved workspace', () => {
    it('is recognized from the 410 and names its new home', () => {
        const moved = new LedgerServiceError('This workspace has moved', 410, { code: 'tenant_moved', destination: 'https://new.example.com' }, 'tenant_moved');
        expect(movedDestination(moved)).toEqual({ destination: 'https://new.example.com' });
        expect(movedDestination(new LedgerServiceError('gone', 410, {}, 'tenant_moved'))).toEqual({ destination: null });
        expect(movedDestination(new LedgerServiceError('gone', 410, {}, 'something_else'))).toBeNull();
        expect(movedDestination(new Error('network'))).toBeNull();
    });

    it('is told apart from a pause: a migrating workspace is retried, a moved one is not retried as a failure', () => {
        const paused = new LedgerServiceError('paused', 503, {}, 'tenant_migrating');
        expect(isTransientSyncFailure(paused)).toBe(true);
        expect(movedDestination(paused)).toBeNull();
        expect(isTransientSyncFailure(new LedgerServiceError('gone', 410, {}, 'tenant_moved'))).toBe(false);
    });
});
