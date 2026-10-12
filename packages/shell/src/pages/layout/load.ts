import type { LoadEvent } from '@sveltejs/kit';
type PageLoad = (event: LoadEvent) => unknown;
import { redirect } from '@sveltejs/kit';
import { tenant } from '@hearthlog/contracts/tenant/config';
import { tenantRouteRedirect, moduleRedirect } from '@hearthlog/contracts/tenant/route-access';
import { getAsOfVersion, TIME_TRAVEL_QUERY_PARAM } from '@hearthlog/runtime/history/legacy-url.js';
import { notify } from '@hearthlog/ui/state/notifications.svelte.js';
import { prepareWorkspace } from '@hearthlog/runtime/runtime/workspace.js';


export const load = (({ url }) => {
    const movedTarget = moduleRedirect(url, tenant.features);
    if (movedTarget) redirect(307, movedTarget);
    const target = tenantRouteRedirect(url.pathname, tenant);
    if (target) redirect(307, target);
    if (url.searchParams.has(TIME_TRAVEL_QUERY_PARAM)) {
        const version = getAsOfVersion(url);
        const clean = new URL(url);
        clean.searchParams.delete(TIME_TRAVEL_QUERY_PARAM);
        if (version) {
            const from = `${clean.pathname}${clean.search}${clean.hash}`;
            redirect(307, `/history?${new URLSearchParams({ point: String(version), from })}`);
        }
        notify.error('That history version is invalid.');
        redirect(307, `${clean.pathname}${clean.search}${clean.hash}`);
    }
    return { workspace: prepareWorkspace(url) };
}) satisfies PageLoad;
