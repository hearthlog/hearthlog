import assert from 'node:assert/strict';
import { test } from 'node:test';

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

test('a site on its own stack binds only its own Ledger and buckets', async () => {
    const { infrastructure, sites } = await loadTenantConfig();
    const jst = siteById(sites, 'jst');
    assert.ok(jst.deployment);
    const own = infrastructureFor(jst, infrastructure);
    const config = buildTenantWranglerConfig(jst, own) as {
        services: Array<{ service: string }>;
        r2_buckets: Array<{ bucket_name: string }>;
    };
    assert.deepEqual(config.services.map((service) => service.service), ['jst-prod-ledger']);
    assert.ok(config.r2_buckets.every((bucket) => bucket.bucket_name.startsWith('jst-prod-')));
    const sharedNames = new Set(Object.values(infrastructure));
    assert.ok(config.r2_buckets.every((bucket) => !sharedNames.has(bucket.bucket_name)));
    assert.equal(buildLedgerConfig(own).name, 'jst-prod-ledger');
});

test('shared public Workers leave a site on its own stack out, and its feed Worker binds only it', async () => {
    const { infrastructure, sites } = await loadTenantConfig();
    const shared = buildCalendarPublicConfig(infrastructure, sharedSites(sites).map((site) => site.id));
    assert.ok(!shared.services.some((service) => service.service === 'jst'));
    const own = buildCalendarPublicConfig(infrastructureFor(siteById(sites, 'jst'), infrastructure), ['jst']);
    assert.deepEqual(own.services.map((service) => service.service), ['jst']);
    assert.deepEqual(own.r2_buckets, [{ binding: 'CALENDAR_FEEDS', bucket_name: 'jst-prod-calendar-feeds' }]);
});

test('a deployment file must name resources after its site', () => {
    const site = { id: 'jst' };
    assert.deepEqual(parseSiteDeployment(site, { schemaVersion: 1, resourcePrefix: 'jst-prod', ledger: 'dedicated' }), {
        schemaVersion: 1, resourcePrefix: 'jst-prod', ledger: 'dedicated',
    });
    assert.throws(() => parseSiteDeployment(site, { schemaVersion: 1, resourcePrefix: 'alpha-prod', ledger: 'dedicated' }), TenantConfigError);
    assert.throws(() => parseSiteDeployment(site, { schemaVersion: 1, resourcePrefix: 'jst-prod', ledger: 'shared' }), TenantConfigError);
    assert.throws(() => parseSiteDeployment(site, { schemaVersion: 1, resourcePrefix: 'jst-prod', ledger: 'dedicated', bucket: 'x' }), TenantConfigError);
});

test('a stack whose names collide with the shared stack is rejected', async () => {
    const { infrastructure, sites } = await loadTenantConfig();
    const jst = siteById(sites, 'jst');
    assert.doesNotThrow(() => validateDeploymentIsolation(sites, infrastructure));
    const colliding = { ...infrastructure, invoicePdfsBucket: 'jst-prod-invoice-pdfs' };
    assert.throws(() => validateDeploymentIsolation([jst], colliding), TenantConfigError);
});

test('Calendar is on for every site, listed or not', () => {
    const base = { id: 'plain', authorizedEmails: ['owner@example.com'] };
    assert.deepEqual(resolveForTest(undefined, { ...base, features: [] }).features, ['calendar']);
    assert.deepEqual(resolveForTest(undefined, { ...base, features: ['calories'] }).features, ['calories', 'calendar']);
    assert.deepEqual(resolveForTest(undefined, { ...base, features: ['calendar', 'calories'] }).features, ['calories', 'calendar']);
    assert.throws(() => resolveForTest(undefined, base), TenantConfigError);
});
