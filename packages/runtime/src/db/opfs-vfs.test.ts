import { describe, expect, it } from 'vitest';
import { describeVfsChoice, preferredOpfsVfs } from './opfs-vfs.js';

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

describe('describeVfsChoice', () => {
    it('names the Chromium browser and its version', () => {
        expect(describeVfsChoice({ userAgentData: { brands: [{ brand: 'Not)A;Brand', version: '99' }, { brand: 'Chromium', version: '142' }, { brand: 'Google Chrome', version: '142' }] } })).toBe('Chromium (Google Chrome 142)');
    });

    it('says why a browser without userAgentData is not Chromium', () => {
        expect(describeVfsChoice({})).toMatch(/^not Chromium/);
    });
});
