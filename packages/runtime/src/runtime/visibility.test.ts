import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { onPageVisibilityChange, pageVisible, setPageVisibilityOverride } from './visibility.js';

/** The unit tests run in Node: a hidden document and a window are enough for this module. */
const page = globalThis as unknown as { window?: EventTarget; document?: EventTarget & { visibilityState: string } };

beforeAll(() => {
    page.window = new EventTarget();
    page.document = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
});

afterEach(() => setPageVisibilityOverride(null));

afterAll(() => {
    delete page.window;
    delete page.document;
});

describe('page visibility', () => {
    it('follows the document until a native app overrides it', () => {
        expect(pageVisible()).toBe(false);
        setPageVisibilityOverride(true);
        expect(pageVisible()).toBe(true);
        setPageVisibilityOverride(null);
        expect(pageVisible()).toBe(false);
        page.document!.visibilityState = 'visible';
        expect(pageVisible()).toBe(true);
        page.document!.visibilityState = 'hidden';
    });

    it('tells listeners when the answer changes, from the override or the document', () => {
        let changes = 0;
        const stop = onPageVisibilityChange(() => changes++);
        setPageVisibilityOverride(true);
        setPageVisibilityOverride(true);
        setPageVisibilityOverride(false);
        page.document!.dispatchEvent(new Event('visibilitychange'));
        stop();
        setPageVisibilityOverride(true);
        expect(changes).toBe(3);
    });
});
