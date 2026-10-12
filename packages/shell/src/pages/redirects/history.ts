import { redirect } from '@sveltejs/kit';
import type { LoadEvent } from '@sveltejs/kit';
type PageLoad = (event: LoadEvent) => unknown;
import { tenant } from '@hearthlog/contracts/tenant/config';

export const load = (({ url }) => {
    const from = url.searchParams.get('from');
    let target = new URL(tenant.home, url.origin);
    if (from?.startsWith('/') && !from.startsWith('//')) {
        const candidate = new URL(from, url.origin);
        if (candidate.origin === url.origin && candidate.pathname !== '/history') target = candidate;
    }

    const requestedVersion = Number(url.searchParams.get('point'));
    const point = Number.isSafeInteger(requestedVersion) && requestedVersion > 0
        ? String(requestedVersion)
        : 'latest';
    target.hash = `open-history=${point}`;
    redirect(307, `${target.pathname}${target.search}${target.hash}`);
}) satisfies PageLoad;
