/**
 * The order of the history panel: the newest rows (actions and bursts), then older history folded into months, with
 * fork points placed among them by version. A fork point at version v sits just above action v; one that falls inside
 * a closed burst sits below it, and one in folded history sits above the month that holds it.
 */

export type TimelineEntry<R, M, F> =
    | { kind: 'row'; key: string; row: R; startsDay: boolean }
    | { kind: 'marker'; key: string; marker: M }
    | { kind: 'fold'; key: string; fold: F };

export function layoutTimeline<
    R extends { id: string; version: number | null; timestamp: number },
    M extends { key: string; version: number },
    F extends { key: string; firstVersion: number | null; lastVersion: number | null },
>(input: {
    rows: readonly R[];
    markers: readonly M[];
    folds: readonly F[];
    /** Every newest row is loaded (no further page), so fork points below them can show. */
    complete: boolean;
}): TimelineEntry<R, M, F>[] {
    const foldTop = input.folds.reduce((top, fold) => Math.max(top, fold.lastVersion ?? -1), -1);
    const byVersion = [...input.markers].sort((a, b) => b.version - a.version);
    const flat = input.folds.length ? byVersion.filter((marker) => marker.version > foldTop) : byVersion;
    const folded = input.folds.length ? byVersion.filter((marker) => marker.version <= foldTop) : [];
    const entries: TimelineEntry<R, M, F>[] = [];
    const marker = (value: M) => entries.push({ kind: 'marker', key: `marker:${value.key}`, marker: value });

    let next = 0;
    let day = '';
    for (const row of input.rows) {
        while (next < flat.length && row.version !== null && row.version <= flat[next]!.version) marker(flat[next++]!);
        const rowDay = localDay(row.timestamp);
        entries.push({ kind: 'row', key: row.id, row, startsDay: rowDay !== day });
        day = rowDay;
    }
    if (input.complete) while (next < flat.length) marker(flat[next++]!);
    if (!input.complete && input.folds.length) return entries;

    let foldNext = 0;
    for (const fold of input.folds) {
        while (foldNext < folded.length && fold.firstVersion !== null && fold.firstVersion <= folded[foldNext]!.version) {
            marker(folded[foldNext++]!);
        }
        entries.push({ kind: 'fold', key: `fold:${fold.key}`, fold });
    }
    while (foldNext < folded.length) marker(folded[foldNext++]!);
    return entries;
}

function localDay(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
