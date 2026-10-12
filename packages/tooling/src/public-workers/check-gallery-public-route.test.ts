import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGalleryPublicRoute } from './check-gallery-public-route.js';

const origin = 'https://gallery.example.com';
const headers = { 'X-Robots-Tag': 'noindex, nofollow, noarchive' };

test('accepts only the public Worker responses on both routes', async () => {
    const paths: string[] = [];
    await checkGalleryPublicRoute(origin, async (url) => {
        paths.push(url);
        return url.endsWith('/robots.txt')
            ? new Response('User-agent: *\nDisallow: /\n', { status: 200, headers })
            : new Response('Not found', { status: 404, headers });
    });
    assert.deepEqual(paths, [`${origin}/g/00000000-0000-4000-8000-000000000000`, `${origin}/robots.txt`]);
});

test('rejects the Cloudflare placeholder despite a successful robots response', async () => {
    await assert.rejects(
        checkGalleryPublicRoute(origin, async () => new Response('There is nothing here yet', { status: 200 })),
        /route did not reach the Worker/,
    );
});

test('rejects a missing gallery route not served by the Worker', async () => {
    await assert.rejects(
        checkGalleryPublicRoute(origin, async (url) => url.endsWith('/robots.txt')
            ? new Response('User-agent: *\nDisallow: /\n', { status: 200, headers })
            : new Response('error code: 1042', { status: 404 })),
        /route did not reach the Worker/,
    );
});

test('rejects a substituted robots response after the gallery route responds', async () => {
    await assert.rejects(
        checkGalleryPublicRoute(origin, async (url) => url.endsWith('/robots.txt')
            ? new Response('Cloudflare robots', { status: 200 })
            : new Response('Not found', { status: 404, headers })),
        /Worker is not serving/,
    );
});
