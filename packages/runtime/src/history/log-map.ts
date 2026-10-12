import { format, startOfMonth, addMonths } from 'date-fns';
import type { LogNode } from './lineage.js';

const DAY = 86_400_000;

export interface MapRow {
    node: LogNode;
    y: number;
    x0: number;
    x1: number;
    /** Where the line leaves its parent's row. */
    fork: { x: number; y: number } | null;
    /** The log began before the map does. */
    clipped: boolean;
    label: { x: number; anchor: 'start' | 'end' };
}

export interface LogMapModel {
    width: number;
    height: number;
    axisY: number;
    rows: MapRow[];
    ticks: { x: number; label: string; anchor: 'start' | 'middle' | 'end' }[];
    x: (time: number) => number;
}

function time(value: string | null | undefined): number | null {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
}

function forkTime(node: LogNode): number | null {
    return node.log.sourceLogId
        ? time(node.log.sourceTimestamp) ?? time(node.log.createdAt)
        : time(node.log.createdAt);
}

export interface MapSpan {
    start: number;
    end: number;
}

/**
 * The time the map covers. It ends at the latest activity, which is today for a
 * log in use. Forks cluster near the end, so it covers the month before it,
 * reaching back to the oldest fork within four months; older logs run in from
 * the left edge.
 */
export function mapSpan(nodes: readonly LogNode[], now: number, newestAction: number | null): MapSpan {
    const latest = Math.max(newestAction ?? Number.NEGATIVE_INFINITY, ...nodes.map(node =>
        time(node.log.lastUpdatedAt) ?? time(node.log.createdAt) ?? Number.NEGATIVE_INFINITY));
    // Recent activity counts as today, so the axis reads "Today".
    const end = !Number.isFinite(latest) || latest > now - 2 * DAY ? now : Math.min(latest, now);
    const forks = nodes.filter(node => node.log.sourceLogId).map(forkTime)
        .filter((value): value is number => value !== null && value <= end);
    const start = Math.max(end - 120 * DAY, Math.min(end - 30 * DAY, ...forks));
    return { start: start - (end - start) * 0.03, end: end + (end === now ? 0 : (end - start) * 0.02) };
}

/** One line per log on a shared time axis, in tree order. Pure geometry. */
export function logMap(
    nodes: readonly LogNode[],
    options: { currentLogId: string | null; now: number; span: MapSpan; width?: number; rowGap?: number },
): LogMapModel {
    const width = options.width ?? 360;
    // Rows tighten as logs are added, so the whole tree stays in view.
    const rowGap = options.rowGap ?? Math.max(16, Math.min(26, 104 / Math.max(1, nodes.length - 1)));
    const top = 22;
    const left = 8;
    const right = 8;
    const now = options.now;
    const { start, end } = options.span;
    const x = (value: number) => left + ((Math.min(Math.max(value, start), end) - start) / (end - start)) * (width - left - right);

    const rowY = new Map<string, number>();
    const rows = nodes.map((node, index): MapRow => {
        const y = top + index * rowGap;
        rowY.set(node.log.id, y);
        const began = forkTime(node) ?? start;
        const x0 = x(began);
        const current = node.log.id === options.currentLogId;
        const last = current || node.log.status === 'preparing'
            ? end
            : time(node.log.lastUpdatedAt) ?? time(node.log.createdAt) ?? began;
        const x1 = Math.max(x(last), x0 + 4);
        const parentY = node.parentId ? rowY.get(node.parentId) : undefined;
        const estimate = node.log.name.length * 6.2 + 4;
        return {
            node, y, x0, x1,
            fork: node.log.sourceLogId && parentY !== undefined ? { x: x0, y: parentY } : null,
            clipped: began < start,
            // After the start when it fits, otherwise just before it, clear of the fork line.
            label: x0 + estimate <= width - 4 ? { x: x0 + 2, anchor: 'start' }
                : x0 - estimate >= 4 ? { x: x0 - 6, anchor: 'end' } : { x: 4, anchor: 'start' },
        };
    });

    const axisY = top + Math.max(0, nodes.length - 1) * rowGap + 18;
    const ticks: LogMapModel['ticks'] = [
        { x: left, label: format(start, 'MMM d'), anchor: 'start' },
        { x: width - right, label: end >= now - DAY ? 'Today' : format(end, 'MMM d'), anchor: 'end' },
    ];
    if (end - start > 60 * DAY) {
        for (let month = startOfMonth(addMonths(start, 1)).getTime(); month < end - 20 * DAY; month = addMonths(month, 1).getTime()) {
            const at = x(month);
            if (at > left + 44 && at < width - right - 44) ticks.push({ x: at, label: format(month, 'MMM'), anchor: 'middle' });
        }
    }
    return { width, height: axisY + 16, axisY, rows, ticks, x };
}
