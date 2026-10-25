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

/** A row of the history list: an action, or a place where a log starts. */
export type HistoryItem =
    | (HistoryEntry & { kind: 'action'; copied: boolean })
    | { kind: 'marker'; id: string; markerKey: string; total: number };

/** An action as a point on the log map. */
export interface HistoryPoint {
    id: string;
    label: string;
    timestamp: number;
    version: number | null;
}

export interface HistoryListOptions {
    search?: string;
    feature?: string;
    limit?: number;
    /** Keep loading until this action is in the list. */
    through?: string | null;
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
