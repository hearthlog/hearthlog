import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeatureId } from '../../../contracts/src/features/registry.js';
import type { IntegrationKind } from '../../../contracts/src/integrations/kinds.js';
import { loadModules } from '../compose/compose-modules.js';
import { resolveSite, TenantConfigError } from './tenant-config.js';
import { integrationsVariable } from './wrangler-config.js';

const resolveForTest = (defaults: Parameters<typeof resolveSite>[0], site: Parameters<typeof resolveSite>[1]) =>
    resolveSite(defaults, site, 'example.workers.dev');

/** Integration kinds and their features come from the modules (Health's steps); these tests run in `pnpm test:integration`. */
const needsModules = { skip: loadModules().length === 0 && 'needs the modules: pnpm test:integration' };
const STEPS = 'steps' as IntegrationKind;
const ids = (...values: string[]) => values as FeatureId[];

const LOG_ID = '3f1b6d8e-2a44-4c7e-9c1d-0e5a7b9c2d11';
const site = {
    id: 'alpha',
    authorizedEmails: ['owner@example.com'],
    features: ids('activities'),
};

test('only integrations with a client id reach the Worker variable', needsModules, () => {
    const resolved = resolveForTest(undefined, {
        ...site,
        features: [...site.features],
        integrations: [
            { id: 'iphone-steps', kind: STEPS, logId: LOG_ID.toUpperCase(), clientId: 'abcdef0123456789.access' },
            { id: 'later', kind: STEPS, logId: LOG_ID },
        ],
    });
    assert.deepEqual(JSON.parse(integrationsVariable(resolved)), [
        { id: 'iphone-steps', kind: 'steps', logId: LOG_ID, clientId: 'abcdef0123456789.access' },
    ]);
});

test('an integration needs its feature, a UUID log and a unique id and client', needsModules, () => {
    const base = { ...site, features: [...site.features] };
    const integration = { id: 'iphone-steps', kind: STEPS, logId: LOG_ID };
    assert.throws(
        () => resolveForTest(undefined, { ...base, features: ids('finance'), integrations: [integration] }),
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
