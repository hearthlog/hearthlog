import { describe, expect, it } from 'vitest';
import { preferredOpfsVfs } from './opfs-vfs.js';

describe('preferredOpfsVfs', () => {
    it('uses opfs-wl on Chromium-based browsers', () => {
        const chrome = { userAgentData: { brands: [{ brand: 'Not.A/Brand' }, { brand: 'Chromium' }, { brand: 'Google Chrome' }] } };
        const edge = { userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }] } };
        expect(preferredOpfsVfs(chrome)).toBe('opfs-wl');
        expect(preferredOpfsVfs(edge)).toBe('opfs-wl');
    });

    it('keeps opfs where userAgentData is missing (Safari, iOS, Firefox)', () => {
        expect(preferredOpfsVfs({})).toBe('opfs');
        expect(preferredOpfsVfs(undefined)).toBe('opfs');
    });

    it('keeps opfs when the brands do not name Chromium', () => {
        expect(preferredOpfsVfs({ userAgentData: { brands: [] } })).toBe('opfs');
        expect(preferredOpfsVfs({ userAgentData: {} })).toBe('opfs');
    });
});
