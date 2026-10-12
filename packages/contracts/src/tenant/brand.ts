/**
 * The brand mark: a folded ribbon in the shape of an "s". Every tenant title
 * contains an "s", so the mark replaces that letter inside the name.
 *
 * Pure module shared by the app, the tenant generator, and the icon generator.
 */

/** Crop of the 512 artboard around the ribbon (width 310, height 435). */
export const BRAND_MARK_VIEWBOX = '100 40 310 435';
export const BRAND_MARK_ASPECT = 310 / 435;
/** Colour of the original mark; used where a tenant has no accent. */
export const BRAND_MARK_DEFAULT_COLOR = '#10484B';

const RIBBON_PATH =
    'M303 62C337 45 377 60 391 93C405 126 391 162 360 180L282 223L349 250C387 266 405 295 396 326C390 347 376 363 354 375L209 451C175 469 136 454 121 421C106 388 120 352 152 335L229 292L162 265C125 250 107 221 116 190C122 169 136 153 158 141Z';
const FOLD_PATHS = [
    'M174 123C170 147 180 163 205 173L337 226',
    'M175 286L307 339C332 349 342 365 338 389',
];

/** Inner SVG markup of the mark with its fold lines cut out (transparent). */
function markBody(fill: string): string {
    return (
        `<defs><mask id="r" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">` +
        `<rect width="512" height="512" fill="#fff"/>` +
        FOLD_PATHS.map(
            (d) => `<path d="${d}" stroke="#000" stroke-width="10" stroke-linecap="round" fill="none"/>`,
        ).join('') +
        `</mask></defs><path fill="${fill}" mask="url(#r)" d="${RIBBON_PATH}"/>`
    );
}

/** Standalone SVG of the mark, cropped to the ribbon. */
export function brandMarkSvg(fill: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BRAND_MARK_VIEWBOX}">${markBody(fill)}</svg>`;
}

/**
 * Square SVG tile: the mark centred on a background, scaled to `scale` of the
 * tile height. Used for favicons and app icons.
 */
export function brandTileSvg(options: {
    background: string;
    fill: string;
    scale?: number;
    radius?: number;
}): string {
    const { background, fill, scale = 0.72, radius = 0 } = options;
    // The ribbon's own bounds are roughly x 106–405 and y 45–469.
    const k = (512 * scale) / 424;
    const tx = 256 - 255.5 * k;
    const ty = 256 - 257 * k;
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
        `<rect width="512" height="512" rx="${radius}" fill="${background}"/>` +
        `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(4)})">${markBody(fill)}</g></svg>`
    );
}

/** `url("data:…")` of the mark in black, for use as a CSS `mask-image`. */
export function brandMarkMaskUrl(): string {
    return `url("data:image/svg+xml,${encodeURIComponent(brandMarkSvg('#000'))}")`;
}

export interface Wordmark {
    before: string;
    after: string;
}

/**
 * Splits a title around its first "s" so the mark can stand in for the
 * letter. Returns `null` for titles without one.
 */
export function wordmarkParts(title: string): Wordmark | null {
    const index = title.search(/s/i);
    if (index < 0) return null;
    return { before: title.slice(0, index), after: title.slice(index + 1) };
}

/**
 * Colour of a tenant's mark in icons and the favicon. Tenants with an accent
 * use their (contrast-checked) action colour; the rest keep the original teal.
 */
export function brandColor(accent: string | undefined, action: string): string {
    return accent ? action : BRAND_MARK_DEFAULT_COLOR;
}
