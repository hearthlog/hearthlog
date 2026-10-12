import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSite, TenantConfigError } from './tenant-config.js';
import { integrationsVariable } from './wrangler-config.js';

const resolveForTest = (defaults: Parameters<typeof resolveSite>[0], site: Parameters<typeof resolveSite>[1]) =>
    resolveSite(defaults, site, 'example.workers.dev');

const LOG_ID = '3f1b6d8e-2a44-4c7e-9c1d-0e5a7b9c2d11';
const site = {
    id: 'alpha',
    authorizedEmails: ['owner@example.com'],
    features: ['activities'] as const,
};

test('only integrations with a client id reach the Worker variable', () => {
    const resolved = resolveForTest(undefined, {
        ...site,
        features: [...site.features],
        integrations: [
            { id: 'iphone-steps', kind: 'steps', logId: LOG_ID.toUpperCase(), clientId: 'abcdef0123456789.access' },
            { id: 'later', kind: 'steps', logId: LOG_ID },
        ],
    });
    assert.deepEqual(JSON.parse(integrationsVariable(resolved)), [
        { id: 'iphone-steps', kind: 'steps', logId: LOG_ID, clientId: 'abcdef0123456789.access' },
    ]);
});

test('an integration needs its feature, a UUID log and a unique id and client', () => {
    const base = { ...site, features: [...site.features] };
    const integration = { id: 'iphone-steps', kind: 'steps' as const, logId: LOG_ID };
    assert.throws(
        () => resolveForTest(undefined, { ...base, features: ['finance'], integrations: [integration] }),
        TenantConfigError,
    );
    assert.throws(() => resolveForTest(undefined, { ...base, integrations: [{ ...integration, logId: 'main' }] }), TenantConfigError);
    assert.throws(() => resolveForTest(undefined, { ...base, integrations: [integration, integration] }), TenantConfigError);
    assert.throws(
        () =>
            resolveForTest(undefined, {
                ...base,
                integrations: [
                    { ...integration, clientId: 'abcdef0123456789.access' },
                    { ...integration, id: 'other', clientId: 'abcdef0123456789.access' },
                ],
            }),
        TenantConfigError,
    );
});
