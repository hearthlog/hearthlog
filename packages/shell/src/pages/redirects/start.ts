import { browser } from '$app/env';
import { redirect } from '@sveltejs/kit';
import { startTarget } from '@hearthlog/runtime/runtime/start-page.js';
import { tenant } from '@hearthlog/contracts/tenant/config';
import type { LoadEvent } from '@sveltejs/kit';
type PageLoad = (event: LoadEvent) => unknown;


export const load = (({ url }) => {
    redirect(307, startTarget(url, tenant, browser ? localStorage : null));
}) satisfies PageLoad;
