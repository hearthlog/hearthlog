/**
 * Coordination between tabs that share one local database.
 *
 * Tabs keep their own session state but write the same SQLite file, so three
 * things need an agreement: who owns the live connection to Ledger, that sync
 * and migrations do not overlap, and that a change one tab made reaches the
 * others. Web Locks decide the first two, a BroadcastChannel carries the third.
 * Without those APIs (server rendering, old browsers) every function degrades to
 * a single tab's behavior.
 */

interface LockRequestOptions {
    mode?: 'exclusive';
    ifAvailable?: boolean;
    signal?: AbortSignal;
}

export interface LockManagerLike {
    request<T>(
        name: string,
        options: LockRequestOptions,
        callback: (lock: unknown | null) => T | Promise<T>,
    ): Promise<T>;
}

export interface TabScope {
    tenantId: string;
    logId: string;
}

/** What changed, so a tab refreshes only what it must. */
export type TabChangeKind =
    /** A local command was committed; pending counts and pages change. */
    | 'commit'
    /** Events from Ledger were ingested or acknowledged. */
    | 'ingest'
    /** The read model was rebuilt; in-memory caches are stale. */
    | 'rebuild'
    /** Entity type definitions or the schema changed; the registry is stale. */
    | 'schema';

export interface TabChange extends TabScope {
    kind: TabChangeKind;
}

export function scopeKey(scope: TabScope): string {
    return `${scope.tenantId}:${scope.logId}`;
}

export const realtimeLockName = (scope: TabScope) => `stor:realtime:${scopeKey(scope)}`;
export const syncCycleLockName = (scope: TabScope) => `stor:sync:${scopeKey(scope)}`;
export const SCHEMA_LOCK_NAME = 'stor:schema';

function browserLocks(): LockManagerLike | null {
    if (typeof navigator === 'undefined' || !('locks' in navigator)) return null;
    return navigator.locks as unknown as LockManagerLike;
}

/** Run a task while no other tab holds the lock; waits its turn. */
export async function withTabLock<T>(
    name: string,
    task: () => Promise<T>,
    locks: LockManagerLike | null = browserLocks(),
): Promise<T> {
    if (!locks) return task();
    return locks.request(name, { mode: 'exclusive' }, task);
}

/**
 * Wait for a lock and keep it until the returned function is called. Calling it
 * before the lock is granted withdraws the request. `onAcquired` runs once the
 * lock is this tab's, and the lock is released if the tab closes.
 */
export function holdTabLock(
    name: string,
    onAcquired: () => void | Promise<void>,
    locks: LockManagerLike | null = browserLocks(),
): () => void {
    if (!locks) {
        void Promise.resolve(onAcquired());
        return () => undefined;
    }
    const withdraw = new AbortController();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    locks.request(name, { mode: 'exclusive', signal: withdraw.signal }, async () => {
        await onAcquired();
        await held;
    }).catch((error: unknown) => {
        // Withdrawing a queued request rejects it; nothing else may fail here.
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
            console.error('[Tabs] Lock request failed', error);
        }
    });
    return () => {
        withdraw.abort();
        release();
    };
}

const CHANNEL_NAME = 'stor:tab-changes';

export interface TabChannel {
    post(change: TabChange): void;
    subscribe(listener: (change: TabChange) => void): () => void;
    close(): void;
}

function isTabChange(value: unknown): value is TabChange {
    if (!value || typeof value !== 'object') return false;
    const change = value as Partial<TabChange>;
    return typeof change.tenantId === 'string'
        && typeof change.logId === 'string'
        && (change.kind === 'commit' || change.kind === 'ingest'
            || change.kind === 'rebuild' || change.kind === 'schema');
}

/** A channel never delivers to the tab that posted, so a handler cannot echo itself. */
export function createTabChannel(name = CHANNEL_NAME): TabChannel {
    if (typeof BroadcastChannel === 'undefined') {
        return { post() {}, subscribe: () => () => undefined, close() {} };
    }
    const channel = new BroadcastChannel(name);
    // Node keeps the process alive for an open channel; browsers have no unref.
    (channel as unknown as { unref?: () => void }).unref?.();
    const listeners = new Set<(change: TabChange) => void>();
    channel.onmessage = (message: MessageEvent<unknown>) => {
        if (!isTabChange(message.data)) return;
        for (const listener of listeners) listener(message.data);
    };
    return {
        post: (change) => channel.postMessage(change),
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close() {
            listeners.clear();
            channel.close();
        },
    };
}

let shared: TabChannel | null = null;
// Kept on globalThis so a hot reload does not leave two open channels.
const globalForChannel = globalThis as unknown as { storTabChannel?: TabChannel };

function sharedChannel(): TabChannel {
    shared ??= globalForChannel.storTabChannel ??= createTabChannel();
    return shared;
}

export function postTabChange(change: TabChange): void {
    try {
        sharedChannel().post(change);
    } catch (error) {
        // A closed channel must never fail the write that triggered the post.
        console.warn('[Tabs] Could not notify other tabs', error);
    }
}

export function onTabChange(listener: (change: TabChange) => void): () => void {
    return sharedChannel().subscribe(listener);
}
