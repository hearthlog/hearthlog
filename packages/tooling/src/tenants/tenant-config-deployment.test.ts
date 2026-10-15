import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FeatureId } from '../../../contracts/src/features/registry.js';
import { loadModules } from '../compose/compose-modules.js';
import { buildCalendarPublicConfig } from '../public-workers/calendar-public-config.js';
import { buildLedgerConfig } from './ledger-config.js';
import {
    infrastructureFor,
    loadTenantConfig,
    parseSiteDeployment,
    resolveSite,
    sharedSites,
    siteById,
    TenantConfigError,
    validateDeploymentIsolation,
} from './tenant-config.js';
import { buildTenantWranglerConfig } from './wrangler-config.js';

const resolveForTest = (defaults: Parameters<typeof resolveSite>[0], site: Parameters<typeof resolveSite>[1]) =>
    resolveSite(defaults, site, 'example.workers.dev');
/** Module features are unknown to a catalog without modules; these tests run in `pnpm test:integration`. */
const needsModules = { skip: loadModules().length === 0 && 'needs the modules: pnpm test:integration' };
const ids = (...values: string[]) => values as FeatureId[];

test('a site on its own stack binds only its own Ledger and buckets', async () => {
    const { infrastructure, sites } = await loadTenantConfig();
    const solo = siteById(sites, 'solo');
    assert.ok(solo.deployment);
    const own = infrastructureFor(solo, infrastructure);
    const config = buildTenantWranglerConfig(solo, own) as {
        services: Array<{ service: string }>;
        r2_buckets: Array<{ bucket_name: string }>;
    };
    assert.deepEqual(config.services.map((service) => service.service), ['solo-prod-ledger']);
    assert.ok(config.r2_buckets.every((bucket) => bucket.bucket_name.startsWith('solo-prod-')));
    const sharedNames = new Set(Object.values(infrastructure));
    assert.ok(config.r2_buckets.every((bucket) => !sharedNames.has(bucket.bucket_name)));
    assert.equal(buildLedgerConfig(own).name, 'solo-prod-ledger');
});

test('shared public Workers leave a site on its own stack out, and its feed Worker binds only it', async () => {
    const { infrastructure, sites } = await loadTenantConfig();
    const shared = buildCalendarPublicConfig(infrastructure, sharedSites(sites).map((site) => site.id));
    assert.ok(!shared.services.some((service) => service.service === 'solo'));
    const own = buildCalendarPublicConfig(infrastructureFor(siteById(sites, 'solo'), infrastructure), ['solo']);
    assert.deepEqual(own.services.map((service) => service.service), ['solo']);
    assert.deepEqual(own.r2_buckets, [{ binding: 'CALENDAR_FEEDS', bucket_name: 'solo-prod-calendar-feeds' }]);
});

test('a deployment file must name resources after its site', () => {
    const site = { id: 'solo' };
    assert.deepEqual(parseSiteDeployment(site, { schemaVersion: 1, resourcePrefix: 'solo-prod', ledger: 'dedicated' }), {
        schemaVersion: 1, resourcePrefix: 'solo-prod', ledger: 'dedicated',
    });
    assert.throws(() => parseSiteDeployment(site, { schemaVersion: 1, resourcePrefix: 'alpha-prod', ledger: 'dedicated' }), TenantConfigError);
    assert.throws(() => parseSiteDeployment(site, { schemaVersion: 1, resourcePrefix: 'solo-prod', ledger: 'shared' }), TenantConfigError);
    assert.throws(() => parseSiteDeployment(site, { schemaVersion: 1, resourcePrefix: 'solo-prod', ledger: 'dedicated', bucket: 'x' }), TenantConfigError);
});

test('a stack whose names collide with the shared stack is rejected', async () => {
    const { infrastructure, sites } = await loadTenantConfig();
    const solo = siteById(sites, 'solo');
    assert.doesNotThrow(() => validateDeploymentIsolation(sites, infrastructure));
    const colliding = { ...infrastructure, calendarFeedsBucket: 'solo-prod-calendar-feeds' };
    assert.throws(() => validateDeploymentIsolation([solo], colliding), TenantConfigError);
});

test('Calendar is on for every site, listed or not', () => {
    const base = { id: 'plain', authorizedEmails: ['owner@example.com'] };
    assert.deepEqual(resolveForTest(undefined, { ...base, features: [] }).features, ['calendar']);
    assert.deepEqual(resolveForTest(undefined, { ...base, features: ['calendar'] }).features, ['calendar']);
    assert.throws(() => resolveForTest(undefined, base), TenantConfigError);
});

test('Calendar comes after the features a site lists', needsModules, () => {
    const base = { id: 'plain', authorizedEmails: ['owner@example.com'] };
    assert.deepEqual(resolveForTest(undefined, { ...base, features: ids('calories') }).features, ['calories', 'calendar']);
    assert.deepEqual(resolveForTest(undefined, { ...base, features: ids('calendar', 'calories') }).features, ['calories', 'calendar']);
});

test('private media configuration is validated and overridden by a dedicated site', async () => {
    const { parseStashMediaConfiguration } = await import('./tenant-config.js');
    assert.deepEqual(parseStashMediaConfiguration({ stashMediaEndpoint: 'https://s3.example.com', stashMediaBucket: 'private-media', stashMediaRegion: 'eu-central-003', stashMediaProxy: '1' }, 'site'), {
        stashMediaEndpoint: 'https://s3.example.com', stashMediaBucket: 'private-media', stashMediaRegion: 'eu-central-003', stashMediaProxy: '1',
    });
    assert.throws(() => parseStashMediaConfiguration({ stashMediaEndpoint: 'http://storage.example.com' }, 'site'), /HTTPS/);
    assert.throws(() => parseStashMediaConfiguration({ stashMediaProxy: 'true' }, 'site'), /0 or 1/);
    const { sites, infrastructure } = await loadTenantConfig();
    const solo = siteById(sites, 'solo');
    const shared = { ...infrastructure, stashMediaEndpoint: 'https://shared.example.com', stashMediaBucket: 'shared-media', stashMediaRegion: 'us-east-1' };
    const deployment = { ...solo.deployment!, stashMediaBucket: 'deployment-media' };
    expectSiteBucket(infrastructureFor({ ...solo, deployment }, shared), 'deployment-media');
    expectSiteBucket(infrastructureFor({ ...solo, deployment, stashMediaBucket: 'site-media' }, shared), 'site-media');
    expectSiteBucket(infrastructureFor({ deployment: null, stashMediaBucket: 'shared-site-media' }, shared), 'shared-site-media');
    function expectSiteBucket(value: typeof infrastructure, bucket: string) {
        assert.equal(value.stashMediaBucket, bucket);
        assert.equal(value.stashMediaEndpoint, 'https://shared.example.com');
    }
});
