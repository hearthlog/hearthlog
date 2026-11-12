import type { FeatureId } from '@hearthlog/contracts/features/registry';

export interface HistoryEntry {
    id: string;
    label: string;
    timestamp: number;
    version: number | null;
    previousVersion: number;
    eventCount: number;
    feature: FeatureId | null;
    /** Who wrote the action, as Ledger recorded it; null for older or local-only actions. */
    actor: string | null;
    status: 'ready' | 'waiting' | 'attention';
    reason: string | null;
    startsDay: boolean;
    total: number;
}

/** A row of the history list: an action, or a place where a log starts. `row` is its 1-based place in the whole list. */
export type HistoryItem =
    | (HistoryEntry & { kind: 'action'; copied: boolean; row: number })
    | { kind: 'marker'; id: string; markerKey: string; total: number; row: number };

/** An action as a point on the log map; on a busy span, the newest action of a slice of time standing for `count`. */
export interface HistoryPoint {
    id: string;
    label: string;
    timestamp: number;
    version: number | null;
    /** How many actions the point stands for; 1 when missing. */
    count?: number;
}

/** A place in the timeline: a burst (or single action) by its waiting flag and `run_start`. */
export interface HistoryCursor {
    pending: number;
    run: number;
}

/**
 * A row of the timeline: an action, or a burst of similar actions shown by its newest one. A burst has `runCount` > 1;
 * its members are listed with `members`.
 */
export type HistoryTimelineRow = HistoryEntry & {
    kind: 'action';
    copied: boolean;
    pending: number;
    runStart: number;
    runCount: number;
    /** When the burst's oldest action happened. */
    runFrom: number;
};

export interface HistoryTimelineOptions {
    search?: string;
    feature?: string;
    searchValues?: boolean;
    /** Only actions at or after this time (the start of the folded months). */
    since?: number | null;
    /** Only actions before this time. */
    until?: number | null;
    /** The page after this row. */
    before?: HistoryCursor | null;
    /** Every row from the top down to and including this one (a jump to an older action). */
    through?: HistoryCursor | null;
    limit?: number;
    sourceVersion?: number | null;
}

export interface HistoryTimelinePage {
    rows: HistoryTimelineRow[];
    /** Where the next page starts, or null at the end. */
    next: HistoryCursor | null;
}

/** A month or day of older history folded into one row. */
export interface HistoryFold {
    /** `YYYY-MM` or `YYYY-MM-DD`, local time. */
    key: string;
    count: number;
    /** First and last action time in it. */
    from: number;
    to: number;
    /** Sections involved, most active first. */
    features: string[];
    /** Accepted versions it spans, to place fork points; null when it holds none. */
    firstVersion: number | null;
    lastVersion: number | null;
}

/** Where an action sits in the timeline, to bring it into view. */
export interface HistoryLocation {
    id: string;
    timestamp: number;
    pending: number;
    runStart: number;
    /** The newest action of its burst, which stands for it while the burst is closed. */
    runTop: string;
}

export interface HistoryListOptions {
    search?: string;
    feature?: string;
    limit?: number;
    /** Keep loading until this action is in the list. */
    through?: string | null;
    /** Start the window a little above this action instead of at the newest one (a jump into older history). */
    around?: string | null;
    /** Also match the saved values of each action's events, not only its name; slower on large logs. */
    searchValues?: boolean;
    /** Actions at or below this version were copied from the source log. */
    sourceVersion?: number | null;
    /** Fork points to place between actions; left out while searching or filtering. */
    markers?: { key: string; version: number }[];
    /** Name only the actions made of these events, so a save can label itself without ranking the whole log. */
    eventIds?: readonly string[];
}

export interface HistoryField {
    key: string;
    label: string;
    before: unknown;
    after: unknown;
}

export interface HistoryRecord {
    key: string;
    label: string;
    kind: 'added' | 'changed' | 'removed' | 'saved';
    fields: HistoryField[];
}

export interface ForkReview {
    keptActions: number;
    laterActions: number;
    features: string;
    localHead: number;
}
