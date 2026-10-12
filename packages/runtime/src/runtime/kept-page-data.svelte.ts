import { untrack } from 'svelte';
import type { PageResource } from './page-data.svelte.js';

/**
 * The data a page last showed, kept on screen while the next load runs, so a
 * save or a change of address swaps the page atomically instead of flashing
 * skeletons. Skeletons show only before the first paint. Call it while the
 * component initialises.
 */
export function keepPageData<T>(resource: () => PageResource<T>) {
    let kept = $state.raw<T | null>(null);
    /** Counts applied loads; endless lists read the blocks on screen again when it changes. */
    let revision = $state(0);

    $effect(() => {
        const current = resource();
        if (current.loading) return;
        const next = current.data;
        untrack(() => {
            kept = next;
            revision += 1;
        });
    });

    return {
        get data(): T {
            return kept ?? resource().data;
        },
        /** True only until the first load has been applied. */
        get loading(): boolean {
            return kept === null && resource().loading;
        },
        get revision(): number {
            return revision;
        },
        /** What `providePageResource` hands to `CommandOnly`, `DataValue` and `PageDataStatus`. */
        get display(): { loading: boolean; error: unknown; measurement: PageResource<T>['measurement'] } {
            const current = resource();
            return { loading: kept === null && current.loading, error: current.error, measurement: current.measurement };
        },
    };
}
