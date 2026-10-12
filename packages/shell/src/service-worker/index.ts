/// <reference lib="webworker" />
// SvelteKit bundles this reserved entry as a module worker; the precache list
// comes from $app/manifest instead of a build-time Workbox injection.

import { version } from '$app/env';
import { assets, immutable, prerendered } from '$app/manifest';
import { self } from '$app/service-worker';
import { workerAssets } from 'virtual:worker-assets';
import { clientsClaim, type RouteHandlerCallback } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import {
    cleanupOutdatedCaches,
    createHandlerBoundToURL,
    precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkOnly } from 'workbox-strategies';

import { ACCESS_REAUTH_QUERY_PARAM } from '@hearthlog/runtime/access/session.js';
import { PRECACHE_EXTRA_PATHS, precacheEntries } from './offline-bundle.js';

const APP_SHELL_URL = '/index.html';

self.skipWaiting();
clientsClaim();
precacheAndRoute(precacheManifest());
cleanupOutdatedCaches();

// Hashed build output is content-addressed; static files and prerendered pages
// are revisioned with the deployment version. The SPA fallback shell is added
// explicitly for offline navigation.
function precacheManifest() {
    const withRevision = (revision: string | null) => ({ path }: { path: string }) => ({ path, revision });
    return precacheEntries([
        ...immutable.map(withRevision(null)),
        ...workerAssets.map(withRevision(null)),
        ...assets.map(withRevision(version)),
        ...prerendered.map(withRevision(version)),
        ...PRECACHE_EXTRA_PATHS.map((path) => ({ path, revision: version })),
    ], import.meta.env.VITE_STOR_TENANT);
}

const appShell = createHandlerBoundToURL(APP_SHELL_URL);

const navigationHandler: RouteHandlerCallback = async (options) => {
    try {
        return await fetch(options.request);
    } catch {
        return appShell(options);
    }
};

registerRoute(new NavigationRoute(navigationHandler, {
    // Cloudflare Access login/logout must always reach the edge. Serving a
    // cached shell (or an offline fallback) for /cdn-cgi/* leaves the user
    // on a dead session with a logout button that appears to do nothing.
    // Recovery navigations are excluded for the same reason: they must reach
    // the edge, and the browser has to follow Access's cross-origin login
    // redirect natively instead of the route replaying a redirected response.
    denylist: [
        /\/api\//,
        /\/logs\/.*\/events\/stream/,
        /\/cdn-cgi\//,
        new RegExp(`[?&]${ACCESS_REAUTH_QUERY_PARAM}=`),
    ],
}));

const immutableAssetStrategy = new CacheFirst({
    cacheName: 'assets-cache',
    plugins: [
        {
            cacheWillUpdate: async ({ response }: { response: Response }) =>
                response.ok && !isHtmlResponse(response) ? response : null,
        },
        new ExpirationPlugin({
            maxEntries: 200,
            maxAgeSeconds: 60 * 60 * 24 * 90,
            purgeOnQuotaError: true,
        }),
    ],
});

registerRoute(
    ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/_app/immutable/'),
    async (options) => {
        const response = await immutableAssetStrategy.handle(options);
        if (!isHtmlResponse(response)) return response;
        return new Response('Not found', {
            status: 404,
            headers: {
                'Cache-Control': 'no-store',
                'Content-Type': 'text/plain; charset=utf-8',
                'X-Content-Type-Options': 'nosniff',
            },
        });
    },
);

registerRoute(
    ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/api/'),
    // Local SQLite plus the app shell provide offline operation. Caching a
    // protected API response risks retaining an Access login page as data.
    new NetworkOnly(),
);

function isHtmlResponse(response: Response): boolean {
    return response.headers.get('Content-Type')?.toLowerCase().includes('text/html') ?? false;
}
