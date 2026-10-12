import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCalendarPublicConfig } from './calendar-public-config.js';
import { checkCalendarPublicRoute } from './check-calendar-public-route.js';
import { loadTenantConfig, sharedSites } from '../tenants/tenant-config.js';

test('the feed Worker has the feed bucket, one renderer binding per calendar site and no Ledger', async () => {
    const { infrastructure, sites } = await loadTenantConfig();
    const config = buildCalendarPublicConfig(infrastructure, sharedSites(sites).map((site) => site.id));
    assert.equal(config.main, './index.ts');
    assert.equal(config.preview_urls, false);
    assert.deepEqual(config.observability, { enabled: false });
    assert.deepEqual(config.r2_buckets, [{ binding: 'CALENDAR_FEEDS', bucket_name: infrastructure.calendarFeedsBucket }]);
    assert.equal(config.vars.PUBLIC_ORIGIN, infrastructure.calendarPublicOrigin);
    // Sites on their own stack have their own feed Worker.
    const calendarSites = sites.filter((site) => !site.deployment);
    assert.deepEqual(
        config.services.map((service) => [service.service, service.entrypoint]),
        calendarSites.map((site) => [site.id, 'CalendarFeedRenderer']),
    );
    assert.ok(config.services.every((service) => /^SITE_[A-Z0-9_]+$/.test(service.binding)));
    assert.equal(JSON.stringify(config).includes('LEDGER'), false);
    assert.equal('assets' in config, false);
});

const origin = 'https://feeds.example.com';
const headers = { 'X-Robots-Tag': 'noindex, nofollow, noarchive' };

test('the route check accepts only the public Worker answers', async () => {
    const paths: string[] = [];
    await checkCalendarPublicRoute(origin, async (url) => {
        paths.push(url);
        return url.endsWith('/robots.txt')
            ? new Response('User-agent: *\nDisallow: /\n', { status: 200, headers })
            : new Response('Not found', { status: 404, headers });
    });
    assert.deepEqual(paths, [`${origin}/feed/${'A'.repeat(43)}.ics`, `${origin}/robots.txt`]);
    await assert.rejects(
        checkCalendarPublicRoute(origin, async () => new Response('There is nothing here yet', { status: 200 })),
        /did not reach the Worker/,
    );
});
