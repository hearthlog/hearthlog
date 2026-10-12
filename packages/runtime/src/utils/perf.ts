/**
 * Performance Monitoring Utilities
 *
 * Provides structured logging for timing critical operations.
 * Persists recent timings locally so the developer console can show
 * a measurable performance baseline across reloads.
 */

// ============================================================================
// Types
// ============================================================================

export type PerfCategory =
    | 'sync'
    | 'projection'
    | 'rebuild'
    | 'realtime'
    | 'db'
    | 'network'
    | 'ui'
    | 'startup';

export type PerfBaselineMetric =
    | 'firstContentfulPaint'
    | 'shellInteractive'
    | 'dataReady'
    | 'pageContentReady'
    | 'firstSyncComplete'
    | 'realtimeEventHandlingTime'
    | 'invalidationCost'
    | 'entityPageLoadTime';

export type PerfMetadata = Record<string, unknown> & {
    baselineMetric?: PerfBaselineMetric;
};

type PerfMetadataInput = PerfMetadata | (() => PerfMetadata | undefined);

export interface PerfEntry {
    id: string;
    category: PerfCategory;
    operation: string;
    durationMs: number;
    timestamp: number;
    metadata?: PerfMetadata;
    baselineMetric?: PerfBaselineMetric;
    isSlow: boolean;
}

export interface TimerResult {
    durationMs: number;
    isSlow: boolean;
}

export interface PerfMetricSummary {
    metric: PerfBaselineMetric;
    group?: string;
    label: string;
    description: string;
    sampleCount: number;
    latestMs: number | null;
    averageMs: number | null;
    p95Ms: number | null;
    slowCount: number;
    latestTimestamp: number | null;
}

// ============================================================================
// Configuration
// ============================================================================

const PERF_STORAGE_KEY = 'perf:entries';
const MAX_PERSISTED_ENTRIES = 250;

export const BASELINE_METRICS: readonly PerfBaselineMetric[] = [
    'firstContentfulPaint',
    'shellInteractive',
    'dataReady',
    'pageContentReady',
    'firstSyncComplete',
    'realtimeEventHandlingTime',
    'invalidationCost',
    'entityPageLoadTime',
];

const BASELINE_METRIC_DETAILS: Record<
    PerfBaselineMetric,
    { label: string; description: string }
> = {
    firstContentfulPaint: {
        label: 'First Contentful Paint',
        description: 'Browser-reported first visible content, including the initial branded frame.',
    },
    shellInteractive: {
        label: 'Shell Interactive',
        description: 'Elapsed from document navigation until real navigation is mounted and painted.',
    },
    dataReady: {
        label: 'Local Data Ready',
        description: 'Elapsed from document navigation until local schema and the selected read view are ready.',
    },
    pageContentReady: {
        label: 'Page data rendered',
        description: 'Required page-loader data has rendered. Initial loads include app startup; navigation and refresh samples start with that action. Streamed regions can appear earlier.',
    },
    firstSyncComplete: {
        label: 'First Sync Complete',
        description: 'Captured when the initial sync attempt finishes during app startup.',
    },
    realtimeEventHandlingTime: {
        label: 'Realtime Handling',
        description: 'Measures per-event processing cost for live WebSocket updates.',
    },
    invalidationCost: {
        label: 'Invalidation',
        description: 'Time from a refresh request through deferred queries and their rendered update.',
    },
    entityPageLoadTime: {
        label: 'Entity Page Load',
        description: 'Measures the client-side entity detail route data load.',
    },
};

/**
 * Thresholds for slow operation detection (in milliseconds).
 * Operations exceeding these thresholds will be logged as warnings.
 */
const SLOW_THRESHOLDS: Record<PerfCategory, number> = {
    sync: 1000,
    projection: 200,
    rebuild: 2000,
    realtime: 100,
    db: 500,
    network: 3000,
    ui: 300,
    startup: 3000,
};

const perfSubscribers = new Set<(entries: PerfEntry[]) => void>();

let persistedEntries = loadPersistedEntries();

/**
 * Check if performance logging is enabled.
 * Enabled by default. Disable with: localStorage.setItem('perf', 'false')
 */
function isPerfEnabled(): boolean {
    if (typeof window === 'undefined') return true;
    try {
        return localStorage.getItem('perf') !== 'false';
    } catch {
        return true;
    }
}

function isPerfCategory(value: unknown): value is PerfCategory {
    return (
        value === 'sync' ||
        value === 'projection' ||
        value === 'rebuild' ||
        value === 'realtime' ||
        value === 'db' ||
        value === 'network' ||
        value === 'ui' ||
        value === 'startup'
    );
}

function isPerfBaselineMetric(value: unknown): value is PerfBaselineMetric {
    return (
        value === 'firstContentfulPaint' ||
        value === 'shellInteractive' ||
        value === 'dataReady' ||
        value === 'pageContentReady' ||
        value === 'firstSyncComplete' ||
        value === 'realtimeEventHandlingTime' ||
        value === 'invalidationCost' ||
        value === 'entityPageLoadTime'
    );
}

function asPerfMetadata(value: unknown): PerfMetadata | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    return value as PerfMetadata;
}

function toJsonSafeValue(
    value: unknown,
    seen = new WeakSet<object>()
): unknown {
    if (typeof value === 'bigint') {
        return value.toString();
    }

    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
    ) {
        return value;
    }

    if (typeof value === 'undefined' || typeof value === 'function') {
        return undefined;
    }

    if (typeof value === 'symbol') {
        return value.toString();
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }

    if (Array.isArray(value)) {
        if (seen.has(value)) {
            return '[Circular]';
        }

        seen.add(value);
        const safeArray = value.map(
            (item) => toJsonSafeValue(item, seen) ?? null
        );
        seen.delete(value);
        return safeArray;
    }

    if (typeof value === 'object') {
        if (seen.has(value)) {
            return '[Circular]';
        }

        seen.add(value);
        const safeRecord: Record<string, unknown> = {};
        Object.entries(value).forEach(([key, item]) => {
            const safeValue = toJsonSafeValue(item, seen);
            if (typeof safeValue !== 'undefined') {
                safeRecord[key] = safeValue;
            }
        });
        seen.delete(value);
        return safeRecord;
    }

    return String(value);
}

function sanitizeMetadata(
    metadata: PerfMetadata | undefined
): PerfMetadata | undefined {
    return asPerfMetadata(toJsonSafeValue(metadata));
}

function normalizeEntry(value: unknown): PerfEntry | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const record = value as Record<string, unknown>;
    if (
        typeof record.id !== 'string' ||
        typeof record.operation !== 'string' ||
        typeof record.durationMs !== 'number' ||
        typeof record.timestamp !== 'number' ||
        typeof record.isSlow !== 'boolean'
    ) {
        return null;
    }

    const category = record.category;
    if (!isPerfCategory(category)) return null;
    const metadata = asPerfMetadata(record.metadata);
    const baselineMetric = isPerfBaselineMetric(record.baselineMetric)
        ? record.baselineMetric
        : metadata?.baselineMetric;

    return {
        id: record.id,
        category,
        operation: record.operation,
        durationMs: record.durationMs,
        timestamp: record.timestamp,
        metadata,
        baselineMetric,
        isSlow: record.isSlow,
    };
}

function loadPersistedEntries(): PerfEntry[] {
    if (typeof window === 'undefined') {
        return [];
    }

    try {
        const raw = localStorage.getItem(PERF_STORAGE_KEY);
        if (!raw) {
            return [];
        }

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed
            .map((entry) => normalizeEntry(entry))
            .filter((entry): entry is PerfEntry => entry !== null)
            .slice(-MAX_PERSISTED_ENTRIES);
    } catch {
        return [];
    }
}

function persistEntries(): void {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        localStorage.setItem(PERF_STORAGE_KEY, JSON.stringify(persistedEntries));
    } catch {
        // Ignore storage errors; logging still works in-memory.
    }
}

function resolveMetadata(metadata?: PerfMetadataInput): PerfMetadata | undefined {
    if (!metadata) {
        return undefined;
    }

    try {
        return typeof metadata === 'function' ? metadata() : metadata;
    } catch (error) {
        console.warn('[Perf] Failed to resolve metadata:', error);
        return undefined;
    }
}

function emitPerfEntries(): void {
    const snapshot = getPerfEntries();
    perfSubscribers.forEach((subscriber) => subscriber(snapshot));
}

function createPerfEntry(
    category: PerfCategory,
    operation: string,
    durationMs: number,
    metadata?: PerfMetadataInput
): PerfEntry {
    const resolvedMetadata = sanitizeMetadata(resolveMetadata(metadata));
    if (resolvedMetadata?.baselineMetric) resolvedMetadata.build = __BUILD_TIMESTAMP__;
    const normalizedDuration = Number.isFinite(durationMs)
        ? Math.max(durationMs, 0)
        : 0;
    const isSlow = normalizedDuration > SLOW_THRESHOLDS[category];

    return {
        id: crypto.randomUUID(),
        category,
        operation,
        durationMs: normalizedDuration,
        timestamp: Date.now(),
        metadata: resolvedMetadata,
        baselineMetric: resolvedMetadata?.baselineMetric,
        isSlow,
    };
}

// ============================================================================
// Logging Utilities
// ============================================================================

export function formatDuration(ms: number): string {
    if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function logPerf(entry: PerfEntry): void {
    const prefix = `[Perf:${entry.category}]`;
    const duration = formatDuration(entry.durationMs);
    const metaStr = entry.metadata
        ? ` ${JSON.stringify(entry.metadata)}`
        : '';

    if (entry.isSlow) {
        console.warn(`${prefix} ⚠ SLOW: ${entry.operation} took ${duration}${metaStr}`);
    } else if (isPerfEnabled()) {
        console.log(`${prefix} ${entry.operation} completed in ${duration}${metaStr}`);
    }
}

function appendPerfEntry(entry: PerfEntry): PerfEntry {
    persistedEntries = [...persistedEntries, entry].slice(-MAX_PERSISTED_ENTRIES);
    persistEntries();
    emitPerfEntries();
    logPerf(entry);
    return entry;
}

// ============================================================================
// Baseline Summaries
// ============================================================================

function calculatePercentile(
    sortedDurations: number[],
    percentile: number
): number | null {
    if (sortedDurations.length === 0) {
        return null;
    }

    const index = Math.max(
        0,
        Math.ceil(sortedDurations.length * percentile) - 1
    );
    return sortedDurations[index] ?? null;
}

export function getBaselineMetricLabel(metric: PerfBaselineMetric): string {
    return BASELINE_METRIC_DETAILS[metric].label;
}

export function getBaselineMetricDescription(metric: PerfBaselineMetric): string {
    return BASELINE_METRIC_DETAILS[metric].description;
}

export function summarizeBaselineMetrics(
    entries: PerfEntry[]
): PerfMetricSummary[] {
    const groups = new Map<string, PerfEntry[]>();
    for (const entry of entries) {
        if (!entry.baselineMetric) continue;
        const group = `${entry.metadata?.measurementVersion ?? 'legacy'}|${entry.metadata?.kind ?? 'legacy'}|${entry.metadata?.route ?? 'all routes'}`;
        const key = `${entry.baselineMetric}|${group}`;
        groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return BASELINE_METRICS.flatMap((metric) => {
      const matching = [...groups.entries()].filter(([key]) => key.startsWith(`${metric}|`));
      if (!matching.length) matching.push([`${metric}|no samples`, []]);
      return matching.map(([key, groupEntries]) => {
        const samples = groupEntries
            .filter((entry) => !entry.metadata?.outcome || entry.metadata.outcome === 'success')
            .sort((left, right) => right.timestamp - left.timestamp);
        const durations = samples
            .map((entry) => entry.durationMs)
            .sort((left, right) => left - right);
        const totalDuration = durations.reduce(
            (sum, duration) => sum + duration,
            0
        );
        const latest = samples[0];

        return {
            metric,
            group: key.slice(metric.length + 1).replaceAll('|', ' · '),
            label: getBaselineMetricLabel(metric),
            description: getBaselineMetricDescription(metric),
            sampleCount: samples.length,
            latestMs: latest?.durationMs ?? null,
            averageMs:
                durations.length > 0 ? totalDuration / durations.length : null,
            p95Ms: calculatePercentile(durations, 0.95),
            slowCount: samples.filter((entry) => entry.isSlow).length,
            latestTimestamp: latest?.timestamp ?? null,
        };
      });
    });
}

// ============================================================================
// Public Store API
// ============================================================================

export function recordTiming(
    category: PerfCategory,
    operation: string,
    durationMs: number,
    metadata?: PerfMetadataInput
): PerfEntry {
    return appendPerfEntry(
        createPerfEntry(category, operation, durationMs, metadata)
    );
}

export function getPerfEntries(): PerfEntry[] {
    return [...persistedEntries].sort(
        (left, right) => right.timestamp - left.timestamp
    );
}

export function clearPerfEntries(): void {
    persistedEntries = [];
    persistEntries();
    emitPerfEntries();
}

export function subscribeToPerfEntries(
    subscriber: (entries: PerfEntry[]) => void
): () => void {
    perfSubscribers.add(subscriber);
    subscriber(getPerfEntries());

    return () => {
        perfSubscribers.delete(subscriber);
    };
}

// ============================================================================
// Core API
// ============================================================================

/**
 * Times an async operation and logs performance metrics.
 */
export async function withTiming<T>(
    category: PerfCategory,
    operation: string,
    fn: () => Promise<T>,
    metadata?: PerfMetadataInput
): Promise<T> {
    const start = performance.now();

    try {
        const result = await fn();
        recordTiming(category, operation, performance.now() - start, metadata);
        return result;
    } catch (error) {
        const durationMs = performance.now() - start;
        console.error(
            `[Perf:${category}] ❌ ${operation} failed after ${formatDuration(durationMs)}:`,
            error
        );
        throw error;
    }
}

/**
 * Times a synchronous operation and logs performance metrics.
 * Use this for synchronous operations that don't return a promise.
 */
export function withTimingSync<T>(
    category: PerfCategory,
    operation: string,
    fn: () => T,
    metadata?: PerfMetadataInput
): T {
    const start = performance.now();

    try {
        const result = fn();
        recordTiming(category, operation, performance.now() - start, metadata);
        return result;
    } catch (error) {
        const durationMs = performance.now() - start;
        console.error(
            `[Perf:${category}] ❌ ${operation} failed after ${formatDuration(durationMs)}:`,
            error
        );
        throw error;
    }
}

/**
 * Creates a manual timer for operations that span multiple calls.
 */
export function createTimer(category: PerfCategory, operation: string) {
    const start = performance.now();

    return {
        /**
         * Stops the timer and logs the result.
         * @param metadata - Optional metadata to include in the log
         * @returns The duration and whether it was slow
         */
        stop(metadata?: PerfMetadataInput): TimerResult {
            const entry = recordTiming(
                category,
                operation,
                performance.now() - start,
                metadata
            );

            return { durationMs: entry.durationMs, isSlow: entry.isSlow };
        },

        /**
         * Gets the elapsed time without stopping the timer.
         */
        elapsed(): number {
            return performance.now() - start;
        },
    };
}

/**
 * Get the slow threshold for a category (useful for custom checks).
 */
export function getSlowThreshold(category: PerfCategory): number {
    return SLOW_THRESHOLDS[category];
}

/** Stable across client navigation; renewed on each document load. */
const documentId = crypto.randomUUID();
let navigationTiming = { id: documentId, start: 0 };
if (typeof document !== 'undefined') document.documentElement.dataset.performanceDocument = documentId;
export function beginNavigationTiming(): void {
    navigationTiming = { id: crypto.randomUUID(), start: performance.now() };
}
export function getNavigationTiming(): { id: string; start: number } {
    return navigationTiming;
}
export function measurementMetadata(): PerfMetadata {
    return { measurementVersion: 2, documentId, navigationId: navigationTiming.id, kind: 'startup', outcome: 'success' };
}
