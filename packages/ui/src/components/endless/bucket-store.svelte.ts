import { SvelteMap } from 'svelte/reactivity';

/**
 * Reads a batch of buckets, keys sorted, in one go (one SQL session). A key
 * missing from the result stays unloaded and is asked for again later.
 */
export type BucketLoader<T> = (keys: string[]) => Promise<Map<string, T>>;

/**
 * Loaded buckets of an endless list, keyed like its axis. The list asks for
 * the buckets that scroll into view. A refresh re-reads the buckets in view
 * and forgets the rest, so they load again when they come back. Old data
 * stays on screen until new data arrives, and a batch that a refresh or reset
 * overtook is dropped.
 */
export class BucketStore<T> {
    readonly buckets = new SvelteMap<string, T>();
    readonly #pending = new Set<string>();
    readonly #load: BucketLoader<T>;
    readonly #failure: string;
    readonly #beforePublish = new Set<() => void>();
    #generation = 0;

    /** `failure` is the warning logged when a batch cannot be read. */
    constructor(load: BucketLoader<T>, failure: string) {
        this.#load = load;
        this.#failure = failure;
    }

    get(key: string): T | undefined {
        return this.buckets.get(key);
    }

    /** Lets a list capture its old DOM geometry before a loaded batch replaces it. */
    beforePublish(listener: () => void): () => void {
        this.#beforePublish.add(listener);
        return () => { this.#beforePublish.delete(listener); };
    }

    /** Loads the given buckets that are neither loaded nor on their way. */
    ensure(keys: string[]): void {
        const missing = keys.filter((key) => !this.buckets.has(key) && !this.#pending.has(key));
        if (missing.length > 0) void this.#read(missing, this.#generation);
    }

    /** Re-reads the buckets in view after a save or sync and drops the others. */
    refresh(keysInView: string[]): void {
        this.#generation += 1;
        this.#pending.clear();
        const keep = new Set(keysInView);
        for (const key of [...this.buckets.keys()]) {
            if (!keep.has(key)) this.buckets.delete(key);
        }
        if (keysInView.length > 0) void this.#read(keysInView, this.#generation);
    }

    /** Forgets everything, for example when the day changes. */
    reset(): void {
        this.#generation += 1;
        this.#pending.clear();
        this.buckets.clear();
    }

    async #read(keys: string[], generation: number): Promise<void> {
        const sorted = [...keys].sort();
        for (const key of sorted) this.#pending.add(key);
        try {
            const loaded = await this.#load(sorted);
            if (generation !== this.#generation) return;
            for (const listener of this.#beforePublish) listener();
            for (const key of sorted) {
                const value = loaded.get(key);
                if (value !== undefined) this.buckets.set(key, value);
            }
        } catch (error) {
            console.warn(this.#failure, error);
        } finally {
            if (generation === this.#generation) for (const key of sorted) this.#pending.delete(key);
        }
    }
}
