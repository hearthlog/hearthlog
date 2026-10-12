import { deferPage } from '@hearthlog/runtime/runtime/page-data.svelte.js';
import type { LoadEvent } from '@sveltejs/kit';
type PageLoad = (event: LoadEvent) => unknown;
import { queryDatabase } from '@hearthlog/runtime/db/read-repositories.js';

const loadData = async ({ depends }: Parameters<PageLoad>[0]) => {

    const entityTypes = await queryDatabase((repositories) =>
        repositories.entities.getEntityCatalog());
    return {
        entityTypes,
    };
};

export const load = ((event) => {
    event.depends('app:entity-types');
    return deferPage(event, { entityTypes: [] } as Awaited<ReturnType<typeof loadData>>, () => loadData(event));
}) satisfies PageLoad;
