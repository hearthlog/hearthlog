import { invalidate } from '$app/navigation';
import { waitForPageUpdates } from './page-data.svelte.js';
import { measurementMetadata, withTiming } from '../utils/perf.js';

/** Public refreshes include both deferred queries and the resulting paint. */
export async function refreshPageData(...targets: string[]): Promise<void> {
    await withTiming('ui', 'refreshPage', async () => {
        await Promise.all(targets.map(target => invalidate(target)));
        await waitForPageUpdates();
    }, {
        ...measurementMetadata(), kind: 'refresh', baselineMetric: 'invalidationCost',
        route: typeof location === 'undefined' ? '' : `${location.pathname}${location.search}`,
        targetCount: targets.length,
    });
}
