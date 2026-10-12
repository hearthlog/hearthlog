/**
 * Shared number and money formatting.
 *
 * One Czech locale for every figure in the app, a true minus sign (U+2212),
 * and decimals only when an amount has a fractional part, so summaries read
 * `42 180 Kč` while `1 234,50 Kč` keeps its haléře.
 */

export const MINUS = '−';

const cache = new Map<string, Intl.NumberFormat>();

function formatter(options: Intl.NumberFormatOptions): Intl.NumberFormat {
    const key = JSON.stringify(options);
    let cached = cache.get(key);
    if (!cached) {
        cached = new Intl.NumberFormat('cs-CZ', options);
        cache.set(key, cached);
    }
    return cached;
}

function fractionDigits(value: number, decimals: 'auto' | 'always' | 'never'): number {
    if (decimals === 'always') return 2;
    if (decimals === 'never') return 0;
    return Number.isInteger(Math.round(value * 100) / 100) ? 0 : 2;
}

function withSign(text: string, value: number, signed: boolean): string {
    const unsigned = text.replace(/^[-−]/, '');
    if (value < 0 && unsigned !== text) return `${MINUS}${unsigned}`;
    if (signed && value > 0) return `+${unsigned}`;
    return unsigned;
}

export interface AmountOptions {
    /** `auto` shows two decimals only for fractional amounts. */
    decimals?: 'auto' | 'always' | 'never';
    /** Prefix positive values with `+`. */
    signed?: boolean;
}

/** `42 180`, `−480`, `+1 234,50` — an amount without its currency unit. */
export function formatAmount(value: number, { decimals = 'auto', signed = false }: AmountOptions = {}): string {
    const digits = fractionDigits(value, decimals);
    const text = formatter({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
    return withSign(text, value, signed);
}

/** `42 180 Kč`, `−480 Kč` — an amount with its currency. */
export function formatMoney(value: number, options: AmountOptions & { currency?: string } = {}): string {
    const { currency = 'CZK', decimals = 'auto', signed = false } = options;
    const digits = fractionDigits(value, decimals);
    const text = formatter({ style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
    return withSign(text, value, signed);
}

/** `6 420`, `79,3` — plain counts and measurements in the app locale. */
export function formatNumber(value: number, maximumFractionDigits = 0): string {
    return withSign(formatter({ maximumFractionDigits }).format(value), value, false);
}

/** `80,0`, `−1,4`, `+0,3` — always `digits` decimals, so a column of weights lines up. */
export function formatFixed(value: number, digits = 1, { signed = false }: { signed?: boolean } = {}): string {
    const text = formatter({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
    // A value that rounds to zero carries no sign.
    if (/^[-−]?0(?:[.,]0+)?$/.test(text)) return text.replace(/^[-−]/, '');
    return withSign(text, value, signed);
}

/** Human file size for stored originals; em dash without a size. */
export function formatFileSize(bytes: number): string {
    if (!bytes) return '—';
    const units = ['B', 'KiB', 'MiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
