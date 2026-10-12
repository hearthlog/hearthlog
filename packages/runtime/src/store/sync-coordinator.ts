import { isLedgerServiceError } from '../ledger/errors.js';

export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 60_000;
export const RETRY_JITTER_RATIO = 0.25;

export type SyncTrigger =
    | 'startup'
    | 'local_commit'
    | 'online'
    | 'visible'
    | 'retry_deadline'
    | 'ws_error'
    | 'ws_ready'
    | 'manual';

export type RealtimeVersionDisposition = 'duplicate' | 'apply' | 'resynchronize';

export function classifyRealtimeVersion(
    localHead: number,
    incomingVersion: number,
): RealtimeVersionDisposition {
    if (
        !Number.isSafeInteger(localHead) ||
        localHead < 0 ||
        !Number.isSafeInteger(incomingVersion) ||
        incomingVersion <= 0
    ) {
        throw new RangeError('realtime versions must be nonnegative safe integers');
    }
    if (incomingVersion <= localHead) return 'duplicate';
    if (incomingVersion === localHead + 1) return 'apply';
    return 'resynchronize';
}

/**
 * A failure that a later attempt can resolve: no answer from Ledger, a
 * timeout, a server or rate-limit status, or a fork still preparing. Uploads
 * keep retrying these; any other answer repeats every time.
 */
export function isTransientSyncFailure(error: unknown): boolean {
    if (error instanceof TypeError) return true;
    if (!isLedgerServiceError(error)) return false;
    const status = error.statusCode;
    return status === undefined
        || status >= 500
        || status === 408
        || status === 429
        || error.code === 'fork_preparing';
}

export function computeRetryDelayMs(
    retryCount: number,
    random: () => number = Math.random,
): number {
    const exponent = Math.max(0, retryCount - 1);
    const base = Math.min(
        RETRY_MAX_DELAY_MS,
        RETRY_BASE_DELAY_MS * 2 ** exponent,
    );
    const jitter = 1 - RETRY_JITTER_RATIO + random() * RETRY_JITTER_RATIO * 2;
    return Math.round(Math.min(RETRY_MAX_DELAY_MS, base * jitter));
}

export function computeRetryDeadline(
    retryCount: number,
    now = Date.now(),
    random: () => number = Math.random,
): Date {
    return new Date(now + computeRetryDelayMs(retryCount, random));
}

interface LockManagerLike {
    request<T>(
        name: string,
        options: { mode: 'exclusive'; ifAvailable: true },
        callback: (lock: unknown | null) => T | Promise<T>,
    ): Promise<T>;
}

export async function withExclusiveSyncLock(
    name: string,
    task: () => Promise<void>,
    lockManager: LockManagerLike | null = browserLockManager(),
): Promise<boolean> {
    if (!lockManager) {
        await task();
        return true;
    }

    return lockManager.request(
        name,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
            if (!lock) return false;
            await task();
            return true;
        },
    );
}

function browserLockManager(): LockManagerLike | null {
    if (typeof navigator === 'undefined' || !('locks' in navigator)) return null;
    return navigator.locks as unknown as LockManagerLike;
}

export class SerialTaskQueue {
    private tail: Promise<void> = Promise.resolve();

    enqueue(task: () => Promise<void>): Promise<void> {
        const run = this.tail.then(task, task);
        this.tail = run.catch(() => undefined);
        return run;
    }

    idle(): Promise<void> {
        return this.tail;
    }
}

/**
 * Combine requests until a fixed deadline, then run serially. A request made
 * during a running task always gets a later run, so reads cannot miss a write
 * that completed after they started. flush() brings the pending run forward.
 */
export class CoalescedTaskQueue {
    #pending: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } | null = null;
    #timer: ReturnType<typeof setTimeout> | null = null;
    #running = false;

    constructor(private readonly task: () => Promise<void>, private readonly delayMs: number) {}

    schedule(): Promise<void> {
        if (this.#pending) return this.#pending.promise;
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
        this.#pending = { promise, resolve, reject };
        this.#timer = setTimeout(() => {
            this.#timer = null;
            void this.#run();
        }, this.delayMs);
        return promise;
    }

    flush(): Promise<void> {
        const pending = this.schedule();
        if (this.#timer !== null) clearTimeout(this.#timer);
        this.#timer = null;
        void this.#run();
        return pending;
    }

    async #run(): Promise<void> {
        if (this.#running || !this.#pending) return;
        const pending = this.#pending;
        this.#pending = null;
        this.#running = true;
        try {
            await this.task();
            pending.resolve();
        } catch (error) {
            pending.reject(error);
        } finally {
            this.#running = false;
            // Its deadline may have passed while the preceding read was busy.
            if (this.#pending && this.#timer === null) void this.#run();
        }
    }
}
