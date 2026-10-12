import { browser } from '$app/env';
import { goto } from '$app/navigation';
import { page } from '$app/state';

/** Shallow navigation changes page.state; the address bar remains authoritative. */
export function historyRouteUrl(): URL {
    void page.state;
    void page.url;
    return browser ? new URL(window.location.href) : new URL(page.url.href);
}

export function navigateHistory(url: URL, replace = false): void {
    void goto(url, { shallow: true, replace, state: { ...page.state, historyUrl: url.href } });
}
