import { describe, expect, it } from 'vitest';

import { announceInvalidation, onInvalidation } from './invalidation.js';

describe('invalidation announcements', () => {
    it('tells every listener the keys, until it stops listening', () => {
        const heard: string[][] = [];
        const stop = onInvalidation((keys) => heard.push([...keys]));
        announceInvalidation(['app:stash', 'app:stash-library']);
        announceInvalidation([]);
        stop();
        announceInvalidation(['app:finance']);
        expect(heard).toEqual([['app:stash', 'app:stash-library']]);
    });

    it('keeps announcing when one listener fails', () => {
        const heard: string[] = [];
        const stopFailing = onInvalidation(() => { throw new Error('broken'); });
        const stop = onInvalidation((keys) => heard.push(...keys));
        announceInvalidation(['app:stash']);
        stopFailing();
        stop();
        expect(heard).toEqual(['app:stash']);
    });
});
