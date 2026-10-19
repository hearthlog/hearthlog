import { describe, expect, it } from 'vitest';

import {
    colorDistance,
    contrastRatio,
    oklch,
    oklchToHex,
    themePaletteFor,
    type ResolvedTheme,
    type StatusRole,
} from './theme';

const MODES: ResolvedTheme[] = ['light', 'dark'];
const STATUS_ROLES: StatusRole[] = ['positive', 'negative', 'warning', 'info'];
const FAMILIES: Record<StatusRole, [number, number]> = {
    negative: [15, 35],
    warning: [55, 90],
    positive: [135, 165],
    info: [225, 255],
};

// 24 hues × 3 lightness levels × 2 chroma levels; the high chroma is above the light-mode cap.
const ACCENTS = Array.from({ length: 24 }, (_, index) => index * 15).flatMap((hue) =>
    [0.4, 0.6, 0.8].flatMap((lightness) => [0.06, 0.2].map((chroma) => oklchToHex(lightness, chroma, hue))),
);

// A gray accent resolves no clash, so its palette holds every meaning colour as it is.
const base = Object.fromEntries(MODES.map((mode) => [mode, themePaletteFor('#808080', mode)])) as Record<ResolvedTheme, ReturnType<typeof themePaletteFor>>;

const hueGap = (a: number, b: number): number => {
    const gap = Math.abs(a - b) % 360;
    return Math.min(gap, 360 - gap);
};

function failures(accent: string, mode: ResolvedTheme): string[] {
    const palette = themePaletteFor(accent, mode);
    const v = palette.variables;
    const problems: string[] = [];
    const check = (label: string, color: string, backgrounds: string[], ratio: number): void => {
        for (const background of backgrounds) {
            const ratioFound = contrastRatio(color, background);
            if (ratioFound < ratio) problems.push(`${label} ${color} on ${background}: ${ratioFound.toFixed(2)}:1`);
        }
    };
    const surfaces = ['--stor-bg', '--stor-surface', '--stor-surface-raised', '--stor-surface-muted', '--stor-surface-hover', '--stor-surface-well', '--stor-surface-overlay', '--stor-surface-sheet'].map((name) => v[name]!);

    // Text
    check('ink', v['--stor-ink']!, [...surfaces, v['--stor-accent-soft']!], 4.5);
    check('muted text', v['--stor-muted-text']!, [...surfaces, v['--stor-accent-soft']!], 4.5);
    check('accent text', v['--stor-accent-text']!, [...surfaces, v['--stor-accent-soft']!], 4.5);
    for (const role of STATUS_ROLES) {
        check(role, v[`--stor-${role}`]!, [v['--stor-bg']!, v['--stor-surface']!, v['--stor-surface-raised']!, v[`--stor-${role}-soft`]!], 4.5);
    }
    // Text on the action, at rest and on hover, and on a filled negative
    check('action text', v['--stor-action-text']!, [v['--stor-action']!, v['--stor-action-hover']!], 4.5);
    check('negative text', v['--stor-negative-text']!, [v['--stor-negative']!], 4.5);
    // Focus
    check('focus', v['--stor-focus']!, surfaces, 3);

    // Every clash got a rule
    const action = palette.action;
    for (const role of STATUS_ROLES) {
        const own = base[mode].variables[`--stor-${role}`]!;
        const clash = palette.clashes.find((entry) => entry.role === role);
        if (colorDistance(action, own) < 0.1) {
            if (!clash) problems.push(`${role} sits ${colorDistance(action, own).toFixed(3)} from the action with no rule`);
            else {
                const hue = oklch(clash.to).H;
                const [from, to] = FAMILIES[role];
                if (clash.to === own || v[`--stor-${role}`] !== clash.to) problems.push(`${role} clash was recorded but not applied`);
                if (Math.min(hueGap(hue, from), hueGap(hue, to)) > 1) problems.push(`${role} turned to ${hue.toFixed(1)}°, outside ${from}–${to}°`);
            }
        } else if (clash || v[`--stor-${role}`] !== own) {
            problems.push(`${role} changed without a clash`);
        }
    }
    const now = base[mode].variables['--stor-now']!;
    const nowClash = palette.clashes.find((entry) => entry.role === 'now');
    if (colorDistance(action, now) < 0.1) {
        if (!nowClash || v['--stor-now'] !== v['--stor-ink']) problems.push('now sits too close to the action and still draws in ember');
    } else if (nowClash || v['--stor-now'] !== now) {
        problems.push('now changed without a clash');
    }
    return problems.map((problem) => `${mode} ${accent}: ${problem}`);
}

describe('tenant theme', () => {
    it('gives the gray reference palette no clashes', () => {
        for (const mode of MODES) {
            expect(base[mode].clashes).toEqual([]);
            expect(base[mode].monochrome).toBe(true);
        }
    });

    it('keeps every derived palette readable and resolves every clash, for 144 accents in both modes', () => {
        expect(new Set(ACCENTS).size).toBe(144);
        const problems = ACCENTS.flatMap((accent) => MODES.flatMap((mode) => failures(accent, mode)));
        expect(problems).toEqual([]);
    });

    it('derives the proposal’s tenant palettes', () => {
        const action = (accent: string, mode: ResolvedTheme) => themePaletteFor(accent, mode).action;
        expect(action('#2b3a67', 'light')).toBe('#2b3a67');
        expect(action('#2b3a67', 'dark')).toBe('#9fb6f2');
        expect(action('#b23a34', 'light')).toBe('#b23a34');
        expect(action('#b23a34', 'dark')).toBe('#ff968b');
        expect(action('#d4a85a', 'light')).toBe('#976e17');
        expect(action('#d4a85a', 'dark')).toBe('#dcb062');
        expect(themePaletteFor('#b23a34', 'light').variables['--stor-negative']).toBe('#a73447');
        expect(themePaletteFor('#b23a34', 'dark').variables['--stor-now']).toBe('#ece9e4');
        expect(themePaletteFor('#2b3a67', 'dark').variables['--stor-action-text']).toBe('#171412');
    });

    it('makes a gray accent a monochrome site that acts in ink', () => {
        const light = themePaletteFor('#7a7a7a', 'light');
        expect(light.action).toBe(light.variables['--stor-ink']);
        expect(light.soft).toBe(light.variables['--stor-surface-well']);
        expect([...failures('#7a7a7a', 'light'), ...failures('#7a7a7a', 'dark')]).toEqual([]);
    });
});
