import { availableParallelism } from "node:os";

/**
 * Resolve a bounded worker-pool size. The default leaves one CPU available for
 * the orchestrator and caps parallel Cloudflare/build work at four workers.
 */
export function defaultConcurrency(): number {
    return Math.min(4, Math.max(1, availableParallelism() - 1));
}

export function parseConcurrency(
    value: string | undefined,
    fallback = defaultConcurrency(),
): number {
    if (value === undefined || value.trim() === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
        throw new Error("Concurrency must be an integer between 1 and 32");
    }
    return parsed;
}

/** Run independent work with a fixed-size pool while preserving result order. */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (items.length === 0) return [];
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error("Concurrency must be a positive integer");
    }

    const results = new Array<R>(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            results[index] = await task(items[index], index);
        }
    }

    const workerResults = await Promise.allSettled(
        Array.from(
            { length: Math.min(concurrency, items.length) },
            () => worker(),
        ),
    );
    const failure = workerResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
    return results;
}

export async function settleWithConcurrency<T>(
    items: readonly T[],
    concurrency: number,
    task: (item: T, index: number) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
    return await mapWithConcurrency(items, concurrency, async (item, index) => {
        try {
            await task(item, index);
            return { status: "fulfilled", value: undefined } as const;
        } catch (reason) {
            return { status: "rejected", reason } as const;
        }
    });
}
