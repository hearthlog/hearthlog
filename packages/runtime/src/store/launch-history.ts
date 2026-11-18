/**
 * Launch history: one record per cold start of this tab, kept in localStorage (not SQLite, which may be the thing
 * that failed) so the developer page can show what the last launches did with the local database: opened it as it
 * was, rebuilt it after a schema change, installed a snapshot, or downloaded everything into an empty database.
 *
 * The record is written as it fills in, so a launch the OS kills halfway (an iOS PWA sent to the background) still
 * appears, marked unfinished. It finishes after this launch's first download, or after a minute without one.
 */

export type LaunchPath = 'opened' | 'schema-rebuild' | 'snapshot-install' | 'full-download';

export interface LaunchStep {
    name: string;
    /** Milliseconds since the page started loading. */
    startMs: number;
    ms: number;
}

export interface LaunchRecord {
    id: string;
    startedAt: string;
    build: string | null;
    /** SQLocal's storage type: `opfs`, `opfs-wl`, `memory`, or a browser-storage name in e2e. */
    storage: string | null;
    requestedVfs: string | null;
    path: LaunchPath;
    /** Why the path was taken, in plain words, most important first. */
    reasons: string[];
    /** The downloaded log version before this launch's first download. */
    logVersionAtStart: number | null;
    downloaded: number;
    /** Milliseconds from page start until the first download finished; null while unfinished or without one. */
    readyMs: number | null;
    steps: LaunchStep[];
    finished: boolean;
}

export const LAUNCH_HISTORY_KEY = 'hearthlog:launch-history';
export const LAUNCH_HISTORY_LIMIT = 20;
const FINISH_WITHOUT_DOWNLOAD_MS = 60_000;

/** A path only moves to a costlier one: a snapshot install outranks a schema rebuild in the same launch. */
const PATH_RANK: Record<LaunchPath, number> = { opened: 0, 'schema-rebuild': 1, 'snapshot-install': 2, 'full-download': 3 };

interface LaunchStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function defaultStorage(): LaunchStorage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

function now(): number {
    return typeof performance === 'undefined' ? 0 : performance.now();
}

function buildId(): string | null {
    try {
        const commit = typeof __STACK_INFO__ === 'undefined' ? '' : __STACK_INFO__.commit;
        if (commit) return commit;
        return typeof __BUILD_TIMESTAMP__ === 'undefined' ? null : __BUILD_TIMESTAMP__;
    } catch {
        return null;
    }
}

export function readLaunchHistory(storage: LaunchStorage | null = defaultStorage()): LaunchRecord[] {
    try {
        const parsed: unknown = JSON.parse(storage?.getItem(LAUNCH_HISTORY_KEY) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter(isLaunchRecord) : [];
    } catch {
        return [];
    }
}

function isLaunchRecord(value: unknown): value is LaunchRecord {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Partial<LaunchRecord>;
    return typeof record.id === 'string' && typeof record.startedAt === 'string' && typeof record.path === 'string'
        && Array.isArray(record.steps) && Array.isArray(record.reasons);
}

export class LaunchRecorder {
    readonly record: LaunchRecord;
    private finishTimer: ReturnType<typeof setTimeout> | null = null;
    private downloadSeen = false;

    constructor(private readonly storage: LaunchStorage | null = defaultStorage(), startedAt = new Date()) {
        this.record = {
            id: `${startedAt.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            startedAt: startedAt.toISOString(),
            build: buildId(),
            storage: null,
            requestedVfs: null,
            path: 'opened',
            reasons: [],
            logVersionAtStart: null,
            downloaded: 0,
            readyMs: null,
            steps: [],
            finished: false,
        };
    }

    /** The give-up timer starts with the first entry, so importing this module (a build, a test) leaves no timer. */
    private arm(): void {
        if (this.finishTimer || this.record.finished || typeof setTimeout === 'undefined') return;
        this.finishTimer = setTimeout(() => this.finish('No download finished within a minute of starting.'), FINISH_WITHOUT_DOWNLOAD_MS);
    }

    get finished(): boolean {
        return this.record.finished;
    }

    step(name: string, startMs: number, endMs: number = now()): void {
        if (this.record.finished) return;
        this.record.steps.push({ name, startMs: Math.round(startMs), ms: Math.max(0, Math.round(endMs - startMs)) });
        this.save();
    }

    path(path: LaunchPath, reason: string): void {
        if (this.record.finished) return;
        if (PATH_RANK[path] > PATH_RANK[this.record.path]) {
            this.record.path = path;
            this.record.reasons.unshift(reason);
        } else {
            this.record.reasons.push(reason);
        }
        this.save();
    }

    note(fields: Partial<Pick<LaunchRecord, 'storage' | 'requestedVfs' | 'logVersionAtStart' | 'downloaded'>>): void {
        if (this.record.finished) return;
        Object.assign(this.record, fields);
        this.save();
    }

    /** True once, for the launch's first download: only that one describes how the launch started. */
    claimFirstDownload(): boolean {
        if (this.record.finished || this.downloadSeen) return false;
        this.downloadSeen = true;
        return true;
    }

    finish(reason?: string): void {
        if (this.record.finished) return;
        if (this.finishTimer) clearTimeout(this.finishTimer);
        if (reason) this.record.reasons.push(reason);
        else this.record.readyMs = Math.round(now());
        if (this.record.path === 'opened' && this.record.reasons.length === 0) {
            this.record.reasons.push('The stored database matched this build and needed no rebuild.');
        }
        this.record.finished = true;
        this.save();
    }

    private save(): void {
        this.arm();
        if (!this.storage) return;
        try {
            const others = readLaunchHistory(this.storage).filter((entry) => entry.id !== this.record.id);
            const next = [this.record, ...others].slice(0, LAUNCH_HISTORY_LIMIT);
            this.storage.setItem(LAUNCH_HISTORY_KEY, JSON.stringify(next));
        } catch {
            // Storage full or blocked: the history is a diagnostic and never stops a launch.
        }
    }
}

/** This tab's launch. Server rendering and tests get one too; without localStorage it simply keeps nothing. */
export const launch = new LaunchRecorder();
