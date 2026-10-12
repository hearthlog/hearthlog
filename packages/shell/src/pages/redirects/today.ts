import { redirect } from '@sveltejs/kit';
import type { LoadEvent } from '@sveltejs/kit';
type PageLoad = (event: LoadEvent) => unknown;


/** Today was removed; old links and installed shortcuts open the start section. */
export const load = (() => {
    redirect(308, '/');
}) satisfies PageLoad;
