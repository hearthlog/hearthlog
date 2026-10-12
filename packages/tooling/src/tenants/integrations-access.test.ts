import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    integrationsAppDomain,
    planIntegrationsApp,
    planServiceAuthPolicy,
    type ExistingAccessPolicy,
} from '../deploy/cloudflare-access.js';

const site = { id: 'alpha', title: 'alpha', hostname: 'https://alpha.example.workers.dev', authorizedEmails: ['a@example.com'] };

const policy = (id: string, tokenIds: string[], decision = 'non_identity'): ExistingAccessPolicy => ({
    id,
    name: 'Service integrations (service auth)',
    decision,
    include: tokenIds.map((tokenId) => ({ service_token: { token_id: tokenId } })),
});

test('a site without integrations gets no integrations application', () => {
    assert.equal(planIntegrationsApp(site, []), null);
    assert.equal(planIntegrationsApp({ ...site, integrations: [] }, []), null);
});

test('the integrations application is scoped to its own path and adopted once it exists', () => {
    const withIntegrations = { ...site, integrations: ['iphone-steps'] };
    assert.equal(integrationsAppDomain(site.hostname), 'alpha.example.workers.dev/api/integrations/*');
    assert.deepEqual(planIntegrationsApp(withIntegrations, []), {
        kind: 'create-integrations-app',
        siteId: 'alpha',
        hostname: 'alpha.example.workers.dev',
        domain: 'alpha.example.workers.dev/api/integrations/*',
        name: 'alpha integrations',
    });
    const existing = [{ id: 'app-1', name: 'x', domain: 'ALPHA.example.workers.dev/api/integrations/*', aud: 'aud-1' }];
    assert.deepEqual(planIntegrationsApp(withIntegrations, existing), {
        kind: 'adopt-integrations-app',
        siteId: 'alpha',
        appId: 'app-1',
        aud: 'aud-1',
    });
});

test('the Service Auth policy admits exactly the wanted tokens', () => {
    assert.deepEqual(planServiceAuthPolicy([], []), { kind: 'none' });
    assert.deepEqual(planServiceAuthPolicy(['t1'], []), { kind: 'create', tokenIds: ['t1'] });
    assert.deepEqual(planServiceAuthPolicy(['t1'], [policy('p1', ['t1'])]), { kind: 'none' });
    assert.deepEqual(planServiceAuthPolicy(['t2', 't1'], [policy('p1', ['t1'])]), {
        kind: 'update',
        policyId: 'p1',
        tokenIds: ['t1', 't2'],
        dropPolicyIds: [],
    });
    // A removed integration loses access, and extra managed policies are folded away.
    assert.deepEqual(planServiceAuthPolicy([], [policy('p1', ['t1']), policy('p2', ['t2'])]), {
        kind: 'update',
        policyId: 'p1',
        tokenIds: [],
        dropPolicyIds: ['p2'],
    });
});

test('policies this tool does not manage are left alone', () => {
    const allow: ExistingAccessPolicy = { id: 'a', name: 'Site access (allow)', decision: 'allow', include: [{ email: { email: 'a@example.com' } }] };
    assert.deepEqual(planServiceAuthPolicy(['t1'], [allow]), { kind: 'create', tokenIds: ['t1'] });
    assert.deepEqual(planServiceAuthPolicy([], [allow]), { kind: 'none' });
});

test('only the retired calendar-feed application is planned for removal', async () => {
    const { planFeedBypassRemoval } = await import('../deploy/cloudflare-access.js');
    const apps = [
        { id: 'site', name: 'alpha', domain: 'alpha.example.workers.dev', aud: 'a' },
        { id: 'feed', name: 'alpha calendar feeds', domain: 'ALPHA.example.workers.dev/api/calendar-feed/*', aud: 'b' },
        { id: 'integrations', name: 'alpha integrations', domain: 'alpha.example.workers.dev/api/integrations/*', aud: 'c' },
    ];
    assert.deepEqual(planFeedBypassRemoval(site, apps).map((app) => app.id), ['feed']);
    assert.deepEqual(planFeedBypassRemoval(site, apps.slice(0, 1)), []);
});
