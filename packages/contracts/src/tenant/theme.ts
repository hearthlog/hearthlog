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

export interface Oklch {
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

export function oklch(color: string): Oklch {
    const [L, a, b] = oklab(color);
    return {
        L,
        C: Math.hypot(a, b),
        H: wrapHue((Math.atan2(b, a) * 180) / Math.PI),
    };
}

/** OKLCH to sRGB hex, reducing chroma until the colour fits the gamut. */
export function oklchToHex(L: number, C: number, H: number): string {
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

const withLightness = (color: string, lightness: number): string => {
    const { C, H } = oklch(color);
    return oklchToHex(Math.max(0, Math.min(1, lightness)), C, H);
};

const withHue = (color: string, hue: number): string => {
    const { L, C } = oklch(color);
    return oklchToHex(L, C, hue);
};

const DEFAULT_ACCENT = '#b23a34';
const TEXT_CONTRAST = 4.5;
const MARK_CONTRAST = 3;
/** Below this chroma an accent has no usable hue: the site is monochrome and acts in ink. */
const MONOCHROME_CHROMA = 0.02;
/** Loud accents are capped in light mode, so the action cannot outshout status and the charts. */
const LIGHT_MAX_CHROMA = 0.17;
/** Dark mode lifts the accent to this lightness instead of washing it toward white. */
const DARK_ACTION_LIGHTNESS = 0.78;
const DARK_MIN_CHROMA = 0.09;
/** Closer than this (OKLab ΔE), the action and a meaning colour read as one hue side by side. */
const CLASH_DISTANCE = 0.1;

interface Neutrals {
    bg: string;
    surface: string;
    raised: string;
    muted: string;
    well: string;
    hover: string;
    overlay: string;
    sheet: string;
    border: string;
    borderStrong: string;
    field: string;
    ink: string;
    mutedText: string;
    faintText: string;
}

/**
 * Warm, low-chroma OKLCH steps (hue 70–80, chroma ≤ 0.013), the same on every site. The accent never tints them,
 * so a tinted surface always means selection. Dark mode shows height as lighter tone.
 */
const NEUTRALS: Record<ResolvedTheme, Neutrals> = {
    light: {
        bg: '#f7f5f2',
        surface: '#fefdfc',
        raised: '#ffffff',
        muted: '#f2f0ec',
        well: '#ece9e4',
        hover: '#f0ede9',
        overlay: '#ffffff',
        sheet: '#ffffff',
        border: '#e2dfda',
        borderStrong: '#cecac3',
        field: '#918b84',
        ink: '#221d18',
        mutedText: '#68625b',
        faintText: '#8b857f',
    },
    dark: {
        bg: '#171412',
        surface: '#1f1c18',
        raised: '#26231f',
        muted: '#23201c',
        well: '#13110f',
        hover: '#2a2622',
        overlay: '#2f2b26',
        sheet: '#2f2b26',
        border: '#38332f',
        borderStrong: '#49443f',
        field: '#736e67',
        ink: '#ece9e4',
        mutedText: '#b0aaa1',
        faintText: '#847f78',
    },
};

export type StatusRole = 'positive' | 'negative' | 'warning' | 'info';

/** Each status colour and its soft fill. Shared by every site, so a meaning looks the same everywhere. */
const STATUS: Record<ResolvedTheme, Record<StatusRole, readonly [string, string]>> = {
    light: {
        positive: ['#337344', '#e1f5e4'],
        negative: ['#a8372a', '#ffe9e5'],
        warning: ['#976213', '#fbedd1'],
        info: ['#39688e', '#e4f0fb'],
    },
    dark: {
        positive: ['#7ccd8e', '#1a3520'],
        negative: ['#f2897c', '#47211c'],
        warning: ['#edbb64', '#403012'],
        info: ['#88bfe6', '#1a3040'],
    },
};

/** The OKLCH hues a status colour may turn to, when the action sits too close, and still mean the same. */
const STATUS_FAMILIES: Record<StatusRole, readonly [number, number]> = {
    negative: [15, 35],
    warning: [55, 90],
    positive: [135, 165],
    info: [225, 255],
};

/** Ember marks today and now, the same on every site. It is never a tenant colour, and never text. */
const NOW: Record<ResolvedTheme, readonly [string, string]> = {
    light: ['#dd6f23', '#feeadb'],
    dark: ['#f59d4f', '#4a2a12'],
};

/** Health's Eat, Move and Body are fixed like status, so a meal looks the same on every site. */
const HEALTH_DOMAINS: Record<ResolvedTheme, Record<'eat' | 'move' | 'body', string>> = {
    light: { eat: '#b36139', move: '#2e8178', body: '#795a90' },
    dark: { eat: '#e3966a', move: '#6cbcb1', body: '#b695cf' },
};

/**
 * The colour itself when it clears `ratio` against every background; otherwise the first OKLCH lightness, in steps
 * of 0.01, that does (darker in light mode, lighter in dark), at the same hue and chroma. Never a mix toward black
 * or white.
 */
function withContrast(color: string, backgrounds: readonly string[], ratio: number, mode: ResolvedTheme): string {
    const passes = (candidate: string): boolean => backgrounds.every((bg) => contrastRatio(candidate, bg) >= ratio);
    if (passes(color)) return color;
    const { L, C, H } = oklch(color);
    const direction = mode === 'light' ? -1 : 1;
    for (let step = 1; step <= 100; step++) {
        const lightness = L + direction * step * 0.01;
        if (lightness < 0 || lightness > 1) break;
        const candidate = oklchToHex(lightness, C, H);
        if (passes(candidate)) return candidate;
    }
    return mode === 'light' ? '#000000' : '#ffffff';
}

/** Text on a fill: white in light mode and the canvas colour in dark mode, unless the other one reads better. */
function readableOn(fill: string, mode: ResolvedTheme): string {
    const preferred = mode === 'light' ? '#ffffff' : NEUTRALS.dark.bg;
    if (contrastRatio(preferred, fill) >= TEXT_CONTRAST) return preferred;
    const other = mode === 'light' ? NEUTRALS.light.ink : '#ffffff';
    return contrastRatio(other, fill) > contrastRatio(preferred, fill) ? other : preferred;
}

/** Hover moves a fill away from its text: darker under light text, lighter under dark text. */
function hoverOf(fill: string, mode: ResolvedTheme): string {
    const { L } = oklch(fill);
    return withLightness(fill, luminance(readableOn(fill, mode)) > luminance(fill) ? L - 0.06 : L + 0.05);
}

interface AccentRoles {
    monochrome: boolean;
    action: string;
    actionText: string;
    actionHover: string;
    /** Links and selected labels: the action, darkened (lightened in dark mode) until it reads on every surface. */
    text: string;
    soft: string;
    focus: string;
}

function accentRoles(accent: string, mode: ResolvedTheme): AccentRoles {
    const n = NEUTRALS[mode];
    const surfaces = [n.bg, n.surface, n.raised, n.muted, n.hover, n.well, n.overlay];
    const { L, C, H } = oklch(accent);
    if (C < MONOCHROME_CHROMA) {
        // A gray accent has no hue to keep: the site acts in ink and selects in the well tone.
        return {
            monochrome: true,
            action: n.ink,
            actionText: readableOn(n.ink, mode),
            actionHover: hoverOf(n.ink, mode),
            text: n.ink,
            soft: n.well,
            focus: n.ink,
        };
    }
    const action = mode === 'light'
        ? withContrast(C > LIGHT_MAX_CHROMA ? oklchToHex(L, LIGHT_MAX_CHROMA, H) : accent, [n.surface], TEXT_CONTRAST, mode)
        : withContrast(oklchToHex(DARK_ACTION_LIGHTNESS, Math.max(C, DARK_MIN_CHROMA), H), [n.bg], TEXT_CONTRAST, mode);
    const soft = mode === 'light'
        ? oklchToHex(0.94, Math.min(C, 0.04), H)
        : oklchToHex(0.3, Math.min(C, 0.05), H);
    return {
        monochrome: false,
        action,
        actionText: readableOn(action, mode),
        actionHover: hoverOf(action, mode),
        text: withContrast(action, [...surfaces, soft], TEXT_CONTRAST, mode),
        soft,
        focus: withContrast(action, surfaces, MARK_CONTRAST, mode),
    };
}

/** A meaning colour that sat within ΔE 0.10 of the action, and what it became. */
export interface ThemeClash {
    role: StatusRole | 'now';
    /** OKLab ΔE between the action and the role's own colour. */
    distance: number;
    from: string;
    to: string;
}

const hueGap = (a: number, b: number): number => {
    const gap = Math.abs(wrapHue(a) - wrapHue(b));
    return Math.min(gap, 360 - gap);
};

/**
 * A status colour reads as text on the surfaces and on its own soft fill. One the action sits too close to turns
 * to the end of its family farther from the action's hue, keeping its lightness and chroma.
 */
function resolveStatus(role: StatusRole, mode: ResolvedTheme, action: string, clashes: ThemeClash[]): readonly [string, string] {
    const n = NEUTRALS[mode];
    const readable = (color: string, soft: string): string =>
        withContrast(color, [n.bg, n.surface, n.raised, soft], TEXT_CONTRAST, mode);
    const [own, ownSoft] = STATUS[mode][role];
    const color = readable(own, ownSoft);
    const distance = colorDistance(action, color);
    if (distance >= CLASH_DISTANCE) return [color, ownSoft];
    const [from, to] = STATUS_FAMILIES[role];
    const actionHue = oklch(action).H;
    const hue = hueGap(from, actionHue) >= hueGap(to, actionHue) ? from : to;
    const soft = withHue(ownSoft, hue);
    const turned = readable(withHue(own, hue), soft);
    clashes.push({ role, distance, from: color, to: turned });
    return [turned, soft];
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
    const baseHue = accentLch.C >= MONOCHROME_CHROMA ? accentLch.H : 25;
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

    const accentSeed = accentLch.C >= MONOCHROME_CHROMA
        ? oklchToHex(
              accentLch.L > 0.7 ? 0.62 : accentLch.L,
              Math.max(0.07, Math.min(accentLch.C, LIGHT_MAX_CHROMA)),
              baseHue,
          )
        : DEFAULT_ACCENT;
    // Establish the light-mode identity first. Pale accents such as bravo's
    // sand become a legible shade of the same hue, while extreme chroma is
    // capped so a tenant accent cannot overpower the companion family.
    const issuedLight = tuneContrast(accentSeed, 'light', NEUTRALS.light.surface, NEUTRALS.light.raised);

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

/** One light from above. Every shadow's opacity scales with this; 1 is the default depth. */
const ELEVATION_STRENGTH = 1;

/**
 * The elevation scale: well (-1), page (1), raised (2), float (3), sheet (4). Every level above the canvas has a
 * hairline; light mode adds a warm-ink shadow, deep only for what floats. Dark mode shows height as lighter tone,
 * so page and raised are the hairline alone. The sidebar's current-section card has its own, a step above raised.
 */
function elevationVariables(mode: ResolvedTheme): Record<string, string> {
    const dark = mode === 'dark';
    const edge = `0 0 0 1px ${NEUTRALS[mode].border}`;
    const shade = (alpha: number): string =>
        `rgba(${dark ? '0, 0, 0' : '34, 29, 24'}, ${Math.min(alpha * ELEVATION_STRENGTH, 0.7).toFixed(3)})`;
    return {
        '--stor-well-shadow': 'none',
        '--stor-elevation-1': dark ? edge : `${edge}, 0 1px 2px ${shade(0.04)}`,
        '--stor-elevation-2': dark ? edge : `${edge}, 0 1px 1px ${shade(0.06)}`,
        '--stor-elevation-pressed': edge,
        '--stor-elevation-3': `${edge}, 0 12px 32px -8px ${shade(dark ? 0.5 : 0.18)}`,
        '--stor-elevation-4': `${edge}, 0 24px 64px -16px ${shade(dark ? 0.6 : 0.28)}`,
        '--stor-nav-card-shadow': dark ? edge : `${edge}, 0 1px 2px ${shade(0.06)}, 0 6px 16px -10px ${shade(0.2)}`,
    };
}

/** The tenant's derived palette for one mode: its accent roles, any clash it resolved, and the CSS variables. */
export interface ThemePalette {
    mode: ResolvedTheme;
    accent: string;
    monochrome: boolean;
    action: string;
    actionText: string;
    accentText: string;
    soft: string;
    focus: string;
    clashes: ThemeClash[];
    variables: Record<string, string>;
}

export function themePaletteFor(accent = DEFAULT_ACCENT, mode: ResolvedTheme = 'light'): ThemePalette {
    const dark = mode === 'dark';
    const n = NEUTRALS[mode];
    const roles = accentRoles(accent, mode);
    const clashes: ThemeClash[] = [];
    const [positive, positiveSoft] = resolveStatus('positive', mode, roles.action, clashes);
    const [negative, negativeSoft] = resolveStatus('negative', mode, roles.action, clashes);
    const [warning, warningSoft] = resolveStatus('warning', mode, roles.action, clashes);
    const [info, infoSoft] = resolveStatus('info', mode, roles.action, clashes);
    let [now, nowSoft] = NOW[mode];
    const nowDistance = colorDistance(roles.action, now);
    if (nowDistance < CLASH_DISTANCE) {
        // Ember beside an ember-like action would stop meaning "now": the mark draws in ink instead.
        clashes.push({ role: 'now', distance: nowDistance, from: now, to: n.ink });
        now = n.ink;
    }
    const charts = chartPalette(accent, mode, n.surface, n.raised);
    const health = HEALTH_DOMAINS[mode];
    const variables: Record<string, string> = {
        '--stor-accent': roles.action,
        '--stor-chart-issued': charts.issued,
        '--stor-chart-received': charts.received,
        '--stor-chart-income-tax': charts.incomeTax,
        '--stor-chart-social-insurance': charts.socialInsurance,
        '--stor-chart-medical-insurance': charts.medicalInsurance,
        '--stor-health-eat': health.eat,
        '--stor-health-move': health.move,
        '--stor-health-body': health.body,
        '--stor-bg': n.bg,
        // The sidebar sits on the canvas; the page panel beside it is the surface.
        '--stor-sidebar': n.bg,
        '--stor-surface': n.surface,
        '--stor-surface-muted': n.muted,
        '--stor-surface-raised': n.raised,
        '--stor-surface-hover': n.hover,
        '--stor-surface-well': n.well,
        '--stor-surface-overlay': n.overlay,
        '--stor-surface-sheet': n.sheet,
        ...elevationVariables(mode),
        // Aliases: the older shadow names point at the scale.
        '--stor-panel-shadow': 'var(--stor-elevation-1)',
        '--stor-sidebar-shadow': 'none',
        '--stor-shadow-sm': 'var(--stor-elevation-2)',
        '--stor-shadow-md': 'var(--stor-elevation-3)',
        '--stor-shadow-lg': 'var(--stor-elevation-4)',
        '--stor-header-shadow': dark ? '0 8px 24px rgba(0, 0, 0, 0.16)' : '0 8px 24px rgba(34, 29, 24, 0.04)',
        '--stor-tooltip': n.ink,
        '--stor-tooltip-text': n.bg,
        '--stor-selected': roles.soft,
        '--stor-border': n.border,
        '--stor-border-strong': n.borderStrong,
        '--stor-field-border': n.field,
        '--stor-ink': n.ink,
        '--stor-muted-text': n.mutedText,
        '--stor-faint-text': n.faintText,
        '--stor-accent-text': roles.text,
        '--stor-action': roles.action,
        '--stor-action-text': roles.actionText,
        '--stor-action-hover': roles.actionHover,
        '--stor-focus': roles.focus,
        '--stor-accent-strong': roles.text,
        '--stor-accent-soft': roles.soft,
        '--stor-overlay': dark ? 'rgba(0, 0, 0, 0.28)' : 'rgba(34, 29, 24, 0.12)',
        '--stor-now': now,
        '--stor-now-soft': nowSoft,
        '--stor-positive': positive,
        '--stor-positive-soft': positiveSoft,
        '--stor-negative': negative,
        '--stor-negative-text': readableOn(negative, mode),
        '--stor-negative-soft': negativeSoft,
        '--stor-warning': warning,
        '--stor-warning-soft': warningSoft,
        '--stor-info': info,
        '--stor-info-soft': infoSoft,
        '--stor-info-border': mix(info, infoSoft, 0.4),
        '--stor-chart-axis': n.mutedText,
        '--stor-chart-fill': `color-mix(in srgb, ${roles.action}, transparent ${dark ? 84 : 87}%)`,
        '--stor-code-key': dark ? '#ff9aae' : '#be1238',
        '--stor-code-string': dark ? '#77d79a' : '#15803d',
        '--stor-code-number': dark ? '#8fc9f4' : '#0369a1',
        '--stor-code-literal': dark ? '#d5a6ff' : '#7e22ce',
        '--stor-theme-color': n.bg,
    };
    return {
        mode,
        accent,
        monochrome: roles.monochrome,
        action: roles.action,
        actionText: roles.actionText,
        accentText: roles.text,
        soft: roles.soft,
        focus: roles.focus,
        clashes,
        variables,
    };
}

export function themeVariablesFor(accent = DEFAULT_ACCENT, mode: ResolvedTheme = 'light'): Record<string, string> {
    return themePaletteFor(accent, mode).variables;
}

export function themeVariablesCss(variables: Readonly<Record<string, string>>): string {
    return Object.entries(variables).map(([name, value]) => `${name}:${value}`).join(';');
}
