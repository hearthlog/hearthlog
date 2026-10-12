/** A page number or size read from the address; `fallback` when it is missing or not a whole number above zero. */
export function parsePositiveInt(value: string | null, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
