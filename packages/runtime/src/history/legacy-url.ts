/** Accepted only to redirect old snapshot bookmarks into Log history. */
export const TIME_TRAVEL_QUERY_PARAM = 'asOfVersion';

export function getAsOfVersion(url: URL): number | null {
    const raw = url.searchParams.get(TIME_TRAVEL_QUERY_PARAM);
    if (!raw) return null;
    const version = Number(raw);
    return Number.isSafeInteger(version) && version > 0 ? version : null;
}
