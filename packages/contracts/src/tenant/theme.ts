export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

/** Resolved before first paint by both the tenant generator and runtime. */
const rgb = (hex: string): number[] => hex.slice(1).match(/.{2}/g)!.map((part) => parseInt(part, 16));
const hex = (channels: number[]): string => '#' + channels.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
const mix = (color: string, base: string, amount: number): string =>
    hex(rgb(color).map((n, i) => n * amount + rgb(base)[i] * (1 - amount)));

const linearChannel = (n: number): number => {
    const c = n / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = (color: string): number =>
    rgb(color).map(linearChannel).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);

export function contrastRatio(a: string, b: string): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
}

/**
 * Perceptual distance between two colours (OKLab ΔE). Roughly 0.02 is the
 * just-noticeable difference for large patches, so values above ~0.1 read as
 * clearly different hues even side by side.
 */
export function colorDistance(a: string, b: string): number {
    const [l1, a1, b1] = oklab(a);
    const [l2, a2, b2] = oklab(b);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

interface Oklch {
    L: number;
    C: number;
    H: number;
}

function oklab(color: string): [number, number, number] {
    const [r, g, b] = rgb(color).map(linearChannel) as [number, number, number];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
}

function oklabChannelsToRgb(L: number, a: number, b: number): number[] {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ ** 3;
    const m = m_ ** 3;
    const s = s_ ** 3;
    const linear = [
        +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    return linear.map((channel) =>
        (channel <= 0.0031308
            ? 12.92 * channel
            : 1.055 * channel ** (1 / 2.4) - 0.055) * 255,
    );
}

const wrapHue = (hue: number): number => ((hue % 360) + 360) % 360;

function oklch(color: string): Oklch {
    const [L, a, b] = oklab(color);
    return {
        L,
        C: Math.hypot(a, b),
        H: wrapHue((Math.atan2(b, a) * 180) / Math.PI),
    };
}

/** OKLCH to sRGB hex, reducing chroma until the colour fits the gamut. */
function oklchToHex(L: number, C: number, H: number): string {
    const radians = (wrapHue(H) * Math.PI) / 180;
    const channels = (chroma: number): number[] =>
        oklabChannelsToRgb(
            L,
            chroma * Math.cos(radians),
            chroma * Math.sin(radians),
        );
    const direct = channels(C);
    if (direct.every((channel) => channel >= 0 && channel <= 255)) {
        return hex(direct);
    }
    let low = 0;
    let high = C;
    for (let step = 0; step < 24; step++) {
        const mid = (low + high) / 2;
        if (channels(mid).every((channel) => channel >= 0 && channel <= 255)) {
            low = mid;
        } else {
            high = mid;
        }
    }
    return hex(channels(low));
}

function accessibleShade(color: string, backgrounds: string[], ratio: number, toward: '#000000' | '#ffffff'): string {
    for (let step = 0; step <= 100; step++) {
        const candidate = mix(color, toward, 1 - step / 100);
        if (backgrounds.every((bg) => contrastRatio(candidate, bg) >= ratio)) return candidate;
    }
    return toward;
}

function readableOn(background: string): '#151719' | '#ffffff' {
    return contrastRatio('#151719', background) >= 4.5 ? '#151719' : '#ffffff';
}

type ChartPalette = Record<
    | 'issued'
    | 'received'
    | 'incomeTax'
    | 'socialInsurance'
    | 'medicalInsurance',
    string
>;

const CHART_MIN_CONTRAST = 3.05;

type ChartPaletteFamily = Omit<ChartPalette, 'issued'> & {
    darkLightnessShift: Omit<Record<keyof ChartPalette, number>, 'issued'>;
};

/**
 * Curated, deliberately quiet colour families. The tenant accent selects a
 * family; only lightness and chroma are adjusted for the active surfaces.
 * This keeps the relationships predictable instead of searching the entire
 * hue wheel for a mathematically distant result.
 */
const chartPaletteFamilies = {
    claySlate: {
        received: '#56788d',
        incomeTax: '#9c5c3e',
        socialInsurance: '#4a7ca6',
        medicalInsurance: '#a06aa5',
        darkLightnessShift: {
            received: 0.2,
            incomeTax: 0.18,
            socialInsurance: 0.15,
            medicalInsurance: 0.23,
        },
    },
    sandSlate: {
        received: '#52788a',
        incomeTax: '#95623f',
        socialInsurance: '#4a7ca6',
        medicalInsurance: '#a06aa5',
        darkLightnessShift: {
            received: 0.2,
            incomeTax: 0.18,
            socialInsurance: 0.15,
            medicalInsurance: 0.23,
        },
    },
    sagePlum: {
        received: '#82728e',
        incomeTax: '#9c5c3e',
        socialInsurance: '#4a7ca6',
        medicalInsurance: '#a06aa5',
        darkLightnessShift: {
            received: 0.2,
            incomeTax: 0.18,
            socialInsurance: 0.15,
            medicalInsurance: 0.23,
        },
    },
    oceanCopper: {
        received: '#ab754f',
        incomeTax: '#9c5c3e',
        socialInsurance: '#7b79b1',
        medicalInsurance: '#19636b',
        darkLightnessShift: {
            received: 0.2,
            incomeTax: 0.18,
            socialInsurance: 0.18,
            medicalInsurance: 0.18,
        },
    },
    plumTeal: {
        received: '#5b8189',
        incomeTax: '#9c5c3e',
        socialInsurance: '#4a7ca6',
        medicalInsurance: '#a06aa5',
        darkLightnessShift: {
            received: 0.2,
            incomeTax: 0.18,
            socialInsurance: 0.15,
            medicalInsurance: 0.23,
        },
    },
} satisfies Record<string, ChartPaletteFamily>;

function chartPaletteFamily(hue: number): ChartPaletteFamily {
    const normalized = wrapHue(hue);
    if (normalized < 50 || normalized >= 345) return chartPaletteFamilies.claySlate;
    if (normalized < 105) return chartPaletteFamilies.sandSlate;
    if (normalized < 190) return chartPaletteFamilies.sagePlum;
    if (normalized < 285) return chartPaletteFamilies.oceanCopper;
    return chartPaletteFamilies.plumTeal;
}

/**
 * `issued` preserves the tenant accent's hue and character. The remaining
 * semantic roles come from the closest curated family, then receive small
 * perceptual adjustments for light or dark mode. Every result is finally
 * tuned just enough to clear 3:1 against both chart panels.
 */
function chartPalette(
    accent: string,
    mode: ResolvedTheme,
    surface: string,
    raised: string,
): ChartPalette {
    const accentLch = oklch(accent);
    // A near-gray accent has no usable identity hue; the default clay family
    // provides a stable, recognisable fallback.
    const baseHue = accentLch.C >= 0.02 ? accentLch.H : 25;
    const family = chartPaletteFamily(baseHue);

    const tuneContrast = (
        seed: string,
        targetMode: ResolvedTheme,
        targetSurface: string,
        targetRaised: string,
    ): string => {
        let { L, C, H } = oklch(seed);
        for (let step = 0; step < 120; step++) {
            const candidate = oklchToHex(L, C, H);
            if (
                contrastRatio(candidate, targetSurface) >= CHART_MIN_CONTRAST &&
                contrastRatio(candidate, targetRaised) >= CHART_MIN_CONTRAST
            ) {
                return candidate;
            }
            L = Math.max(0, Math.min(1, L + (targetMode === 'dark' ? 0.006 : -0.006)));
        }
        return targetMode === 'dark' ? '#ffffff' : '#000000';
    };

    const accentSeed = accentLch.C >= 0.02
        ? oklchToHex(
              accentLch.L > 0.7 ? 0.62 : accentLch.L,
              Math.max(0.07, Math.min(accentLch.C, 0.17)),
              baseHue,
          )
        : '#b23a34';
    // Establish the light-mode identity first. Pale accents such as bravo's
    // sand become a legible shade of the same hue, while extreme chroma is
    // capped so a tenant accent cannot overpower the companion family.
    const issuedLight = tuneContrast(accentSeed, 'light', '#ffffff', '#ffffff');

    const adapt = (seed: string, darkLightnessShift: number): string => {
        if (mode === 'light') return tuneContrast(seed, mode, surface, raised);
        const { L, C, H } = oklch(seed);
        const darkSeed = oklchToHex(Math.min(0.9, L + darkLightnessShift), C * 0.92, H);
        return tuneContrast(darkSeed, mode, surface, raised);
    };

    return {
        issued: adapt(issuedLight, 0.2),
        received: adapt(family.received, family.darkLightnessShift.received),
        incomeTax: adapt(family.incomeTax, family.darkLightnessShift.incomeTax),
        socialInsurance: adapt(
            family.socialInsurance,
            family.darkLightnessShift.socialInsurance,
        ),
        medicalInsurance: adapt(
            family.medicalInsurance,
            family.darkLightnessShift.medicalInsurance,
        ),
    };
}

/**
 * Health gives each part of the day a colour: Eat, Move and Body take three
 * roles of the tenant's chart family, so they are contrast-checked already and
 * follow the accent. Status colours (warning, positive) keep their own meaning.
 */
function healthDomainVariables(charts: ChartPalette): Record<string, string> {
    return {
        '--stor-health-eat': charts.incomeTax,
        '--stor-health-move': charts.socialInsurance,
        '--stor-health-body': charts.medicalInsurance,
    };
}

/** One light from above. Every shadow scales with this; 1 is the default depth. */
const ELEVATION_STRENGTH = 1;

/**
 * The elevation scale: well (-1), panel (1), raised (2), menu (3), sheet (4). Light mode shows height
 * as shadow. Dark mode shows it as lighter surfaces plus a top rim, so the shadows only add contact.
 */
function elevationVariables(mode: ResolvedTheme): Record<string, string> {
    const dark = mode === 'dark';
    const shade = dark ? '0, 0, 0' : '16, 42, 67';
    const alpha = (n: number): string => Math.min(n * ELEVATION_STRENGTH * (dark ? 2.2 : 1), 0.7).toFixed(3);
    const drop = (n: number): string => `rgba(${shade}, ${alpha(n)})`;
    const ring = (n: number): string => (dark ? `rgba(255, 255, 255, ${(n * 0.9 * ELEVATION_STRENGTH).toFixed(3)})` : drop(n));
    const rim = dark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(255, 255, 255, 0.9)';
    const rimSoft = dark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(255, 255, 255, 0.55)';
    return {
        '--stor-well-shadow': `inset 0 1px 2px ${drop(0.1)}`,
        '--stor-elevation-1': `0 0 0 1px ${ring(0.05)}, 0 1px 2px ${drop(0.06)}, 0 10px 28px -14px ${drop(0.16)}, inset 0 1px 0 ${rimSoft}`,
        '--stor-elevation-2': `0 0 0 1px ${ring(0.07)}, 0 1px 1px ${drop(0.08)}, 0 3px 8px -2px ${drop(0.12)}, inset 0 1px 0 ${rim}`,
        '--stor-elevation-pressed': `0 0 0 1px ${ring(0.08)}, inset 0 1px 2px ${drop(0.1)}`,
        '--stor-elevation-3': `0 0 0 1px ${ring(0.07)}, 0 4px 10px -2px ${drop(0.1)}, 0 20px 44px -10px ${drop(0.24)}, inset 0 1px 0 ${rim}`,
        '--stor-elevation-4': `0 0 0 1px ${ring(0.06)}, 0 10px 24px ${drop(0.1)}, 0 36px 90px -16px ${drop(0.34)}, inset 0 1px 0 ${rim}`,
    };
}

export function themeVariablesFor(accent = '#b23a34', mode: ResolvedTheme = 'light'): Record<string, string> {
    if (mode === 'dark') {
        const canvas = mix(accent, '#121c26', 0.04);
        const sidebar = mix(accent, '#1b2a37', 0.06);
        const surface = mix(accent, '#21313f', 0.05);
        const subtle = mix(accent, '#243746', 0.05);
        const raised = mix(accent, '#293b4b', 0.05);
        const well = mix(accent, '#16222d', 0.04);
        const overlay = mix(accent, '#2d4052', 0.05);
        const sheet = mix(accent, '#324759', 0.05);
        const selected = mix(accent, '#263e50', 0.24);
        const surfaces = [canvas, sidebar, surface, subtle, raised, well, overlay, sheet, selected];
        const action = accessibleShade(accent, surfaces, 4.5, '#ffffff');
        const focus = accessibleShade(accent, surfaces, 3, '#ffffff');
        const charts = chartPalette(accent, 'dark', surface, raised);
        return {
            '--stor-accent': accent,
            '--stor-chart-issued': charts.issued,
            '--stor-chart-received': charts.received,
            '--stor-chart-income-tax': charts.incomeTax,
            '--stor-chart-social-insurance': charts.socialInsurance,
            '--stor-chart-medical-insurance': charts.medicalInsurance,
            ...healthDomainVariables(charts),
            '--stor-bg': canvas,
            '--stor-sidebar': sidebar,
            '--stor-surface': surface,
            '--stor-surface-muted': subtle,
            '--stor-surface-raised': raised,
            '--stor-surface-hover': mix(accent, '#2f3b4a', 0.03),
            '--stor-surface-well': well,
            '--stor-surface-overlay': overlay,
            '--stor-surface-sheet': sheet,
            ...elevationVariables('dark'),
            // Aliases: the older shadow names point at the scale.
            '--stor-panel-shadow': 'var(--stor-elevation-1)',
            '--stor-sidebar-shadow': 'var(--stor-elevation-1)',
            '--stor-shadow-sm': 'var(--stor-elevation-2)',
            '--stor-shadow-md': 'var(--stor-elevation-3)',
            '--stor-shadow-lg': 'var(--stor-elevation-4)',
            '--stor-header-shadow': '0 8px 24px rgba(0, 0, 0, 0.16)',
            '--stor-tooltip': '#3a4d60',
            '--stor-tooltip-text': '#edf4f9',
            '--stor-selected': selected,
            '--stor-border': mix(accent, '#3a5367', 0.15),
            '--stor-field-border': accessibleShade('#8a8d91', surfaces, 3, '#ffffff'),
            '--stor-ink': '#edf4f9',
            '--stor-muted-text': accessibleShade('#b5c8d7', surfaces, 4.5, '#ffffff'),
            '--stor-accent-text': action,
            '--stor-action': action,
            '--stor-action-text': readableOn(action),
            '--stor-action-hover': mix(action, '#ffffff', 0.84),
            '--stor-focus': focus,
            '--stor-accent-strong': action,
            '--stor-accent-soft': selected,
            '--stor-overlay': '#090b0d47',
            '--stor-positive': '#65d391',
            '--stor-positive-soft': '#163c2a',
            '--stor-negative': '#ff918d',
            '--stor-negative-text': readableOn('#ff918d'),
            '--stor-negative-soft': '#472321',
            '--stor-warning': '#f2c66d',
            '--stor-warning-soft': '#44351c',
            '--stor-info': '#9bd5fa',
            '--stor-info-soft': '#172f43',
            '--stor-info-border': '#47738c',
            '--stor-chart-axis': '#a9adb2',
            '--stor-chart-fill': `color-mix(in srgb, ${action}, transparent 84%)`,
            '--stor-code-key': '#ff9aae',
            '--stor-code-string': '#77d79a',
            '--stor-code-number': '#8fc9f4',
            '--stor-code-literal': '#d5a6ff',
            '--stor-theme-color': canvas,
        };
    }

    // One step darker than the panels' white so a panel lifts off the page by tone as well as shadow.
    const canvas = mix(accent, '#edf0f4', 0.025);
    const sidebar = mix(accent, '#ffffff', 0.025);
    // Muted and hover surfaces derive from the canvas, not the accent, so a
    // tinted surface always means selection.
    const subtle = mix(canvas, '#ffffff', 0.45);
    const well = mix(canvas, '#e0e6ed', 0.5);
    const selected = mix(accent, '#ffffff', 0.12);
    const surfaces = ['#ffffff', canvas, sidebar, subtle, well, selected];
    const action = accessibleShade(accent, surfaces, 4.5, '#000000');
    const text = accessibleShade(mix(accent, '#15364b', 0.78), surfaces, 4.5, '#000000');
    const charts = chartPalette(accent, 'light', '#ffffff', '#ffffff');
    return {
        '--stor-accent': accent,
        '--stor-chart-issued': charts.issued,
        '--stor-chart-received': charts.received,
        '--stor-chart-income-tax': charts.incomeTax,
        '--stor-chart-social-insurance': charts.socialInsurance,
        '--stor-chart-medical-insurance': charts.medicalInsurance,
        ...healthDomainVariables(charts),
        '--stor-bg': canvas,
        '--stor-sidebar': sidebar,
        '--stor-surface': '#ffffff',
        '--stor-surface-muted': subtle,
        '--stor-surface-raised': '#ffffff',
        '--stor-surface-hover': mix(canvas, '#ffffff', 0.8),
        '--stor-surface-well': well,
        '--stor-surface-overlay': '#ffffff',
        '--stor-surface-sheet': '#ffffff',
        ...elevationVariables('light'),
        // Aliases: the older shadow names point at the scale.
        '--stor-panel-shadow': 'var(--stor-elevation-1)',
        '--stor-sidebar-shadow': 'var(--stor-elevation-1)',
        '--stor-shadow-sm': 'var(--stor-elevation-2)',
        '--stor-shadow-md': 'var(--stor-elevation-3)',
        '--stor-shadow-lg': 'var(--stor-elevation-4)',
        '--stor-header-shadow': '0 8px 24px rgba(16, 42, 67, 0.04)',
        '--stor-tooltip': '#1b2d3d',
        '--stor-tooltip-text': '#ffffff',
        '--stor-selected': selected,
        '--stor-border': mix(accent, '#dce5ed', 0.06),
        '--stor-field-border': accessibleShade(mix(accent, '#999999', 0.18), surfaces, 3, '#000000'),
        '--stor-ink': '#1b2d3d',
        '--stor-muted-text': accessibleShade('#5c6c7c', surfaces, 4.5, '#000000'),
        '--stor-accent-text': text,
        '--stor-action': action,
        '--stor-action-text': readableOn(action),
        '--stor-action-hover': mix(action, '#000000', 0.84),
        '--stor-focus': action,
        '--stor-accent-strong': text,
        '--stor-accent-soft': selected,
        '--stor-overlay': '#14283b1f',
        '--stor-positive': '#15803d',
        '--stor-positive-soft': '#dcfce7',
        '--stor-negative': '#b91c1c',
        '--stor-negative-text': readableOn('#b91c1c'),
        '--stor-negative-soft': '#fee2e2',
        '--stor-warning': '#a16207',
        '--stor-warning-soft': '#fef3c7',
        '--stor-info': '#0369a1',
        '--stor-info-soft': '#f0f9ff',
        '--stor-info-border': '#7dd3fc',
        '--stor-chart-axis': '#78716c',
        '--stor-chart-fill': `color-mix(in srgb, ${accent}, transparent 87%)`,
        '--stor-code-key': '#be1238',
        '--stor-code-string': '#15803d',
        '--stor-code-number': '#0369a1',
        '--stor-code-literal': '#7e22ce',
        '--stor-theme-color': canvas,
    };
}

export function themeVariablesCss(variables: Readonly<Record<string, string>>): string {
    return Object.entries(variables).map(([name, value]) => `${name}:${value}`).join(';');
}
