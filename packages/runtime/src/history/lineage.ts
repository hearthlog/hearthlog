import { format } from 'date-fns';
import type { LogLineageIndex, LogSummary } from '../ledger/index.js';

/** A log in the tree. Hidden logs drop out and their forks move up to their place. */
export interface LogNode {
    log: LogSummary;
    depth: number;
    /** The nearest shown ancestor. */
    parentId: string | null;
    children: LogNode[];
}

/** A place in the current log's history where a log starts. */
export interface ForkMarker {
    key: string;
    kind: 'start' | 'branch';
    /** The last version the log shares; the marker sits just above that action. */
    version: number;
    log: LogSummary;
}

function index(logs: readonly LogSummary[], lineage: LogLineageIndex | null) {
    const byId = new Map(logs.map(log => [log.id, log]));
    const childIds = (logId: string): string[] =>
        lineage?.childIdsByLogId[logId] ?? logs.filter(log => log.sourceLogId === logId).map(log => log.id);
    const rootIds = lineage?.rootIds
        ?? logs.filter(log => !log.sourceLogId || !byId.has(log.sourceLogId)).map(log => log.id);
    return { byId, childIds, rootIds };
}

export function logTree(
    logs: readonly LogSummary[],
    lineage: LogLineageIndex | null,
    options: { currentLogId: string | null; showHidden: boolean },
): LogNode[] {
    const { byId, childIds, rootIds } = index(logs, lineage);
    const seen = new Set<string>();
    const build = (ids: readonly string[], depth: number, parentId: string | null): LogNode[] => ids.flatMap(id => {
        const log = byId.get(id);
        if (!log || seen.has(id)) return [];
        seen.add(id);
        const visible = options.showHidden || !log.hiddenAt || log.id === options.currentLogId;
        if (!visible) return build(childIds(id), depth, parentId);
        return [{ log, depth, parentId, children: build(childIds(id), depth + 1, log.id) }];
    });
    return build(rootIds, 0, null);
}

export function flattenTree(nodes: readonly LogNode[]): LogNode[] {
    return nodes.flatMap(node => [node, ...flattenTree(node.children)]);
}

/** The current log's ancestors, oldest first. */
export function logAncestors(logs: readonly LogSummary[], currentLogId: string | null): LogSummary[] {
    const byId = new Map(logs.map(log => [log.id, log]));
    const chain: LogSummary[] = [];
    let next = currentLogId ? byId.get(currentLogId)?.sourceLogId : null;
    while (next && !chain.some(log => log.id === next)) {
        const log = byId.get(next);
        if (!log) break;
        chain.unshift(log);
        next = log.sourceLogId;
    }
    return chain;
}

/**
 * Where the current log began, and where other logs left the part of history
 * it holds: its own forks anywhere, and forks of its ancestors up to the point
 * it shares with them.
 */
export function forkMarkers(
    logs: readonly LogSummary[],
    lineage: LogLineageIndex | null,
    options: { currentLogId: string | null; showHidden: boolean },
): ForkMarker[] {
    const { byId, childIds } = index(logs, lineage);
    const current = options.currentLogId ? byId.get(options.currentLogId) : undefined;
    if (!current) return [];
    const markers: ForkMarker[] = [];
    if (current.sourceLogId) {
        markers.push({ key: 'start', kind: 'start', version: current.sourceVersion ?? 0, log: current });
    }
    let node: LogSummary | undefined = current;
    let bound = Number.POSITIVE_INFINITY;
    let from: string | null = null;
    const visited = new Set<string>();
    while (node && !visited.has(node.id)) {
        visited.add(node.id);
        for (const id of childIds(node.id)) {
            const child = byId.get(id);
            if (!child || id === from || child.sourceVersion === null || child.sourceVersion === undefined) continue;
            if (child.sourceVersion > bound) continue;
            if (child.hiddenAt && !options.showHidden) continue;
            markers.push({ key: `branch:${child.id}`, kind: 'branch', version: child.sourceVersion, log: child });
        }
        if (node.sourceVersion !== null && node.sourceVersion !== undefined) bound = Math.min(bound, node.sourceVersion);
        from = node.id;
        node = node.sourceLogId ? byId.get(node.sourceLogId) : undefined;
    }
    return markers;
}

/** Changes a log made after it forked; for a separate log, all of them. */
export function ownChanges(log: LogSummary): number {
    return Math.max(0, log.headVersion - (log.sourceVersion ?? 0));
}

/** The root's name and the day of the fork point, numbered when taken. */
export function suggestForkName(
    logs: readonly LogSummary[],
    currentLogId: string | null,
    timestamp: number,
): string {
    const root = logAncestors(logs, currentLogId)[0] ?? logs.find(log => log.id === currentLogId);
    const base = `${root?.name ?? 'Log'} · ${format(timestamp, 'MMM d')}`;
    const taken = new Set(logs.map(log => log.name.trim().toLocaleLowerCase()));
    if (!taken.has(base.toLocaleLowerCase())) return base;
    for (let number = 2; ; number++) {
        const candidate = `${base} (${number})`;
        if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
    }
}
