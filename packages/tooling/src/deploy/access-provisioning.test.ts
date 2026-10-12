import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

import { CloudflareAccessClient } from './cloudflare-access.js';
import { resolveInfrastructure, type InfrastructureDefinition, type TenantFile } from '../tenants/tenant-config.js';

function accessMock(current: Record<string, unknown>) {
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    const request: typeof fetch = async (input, init) => {
        if (init?.method === 'PUT' || init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            writes.push({ path: String(input), body });
            // Observed organization PUT contract: auth_domain cannot be omitted.
            if (String(input).endsWith('/access/organizations') &&
                body.auth_domain !== current.auth_domain) {
                return Response.json({ success: false, errors: [
                    { code: 11004, message: 'access.api.error.invalid_auth_domain' },
                ] }, { status: 400 });
            }
            if (String(input).endsWith('/access/organizations') && !body.auth_domain) {
                return Response.json({ success: false, errors: [
                    { code: 11004, message: 'access.api.error.invalid_auth_domain' },
                ] }, { status: 400 });
            }
        }
        return Response.json({ success: true, result: current });
    };
    return { client: new CloudflareAccessClient('test-token', 'account', request), writes };
}

test('reconciles existing application duration while preserving access settings and policy identities', async () => {
    const { client, writes } = accessMock({
        id: 'app', aud: 'audience', type: 'self_hosted', name: 'Hearthlog', domain: 'st.example.com',
        session_duration: '24h', allowed_idps: ['idp'], http_only_cookie_attribute: true,
        policies: [{ id: 'policy', precedence: 2, decision: 'allow', include: [{ email: { email: 'owner@example.com' } }] }],
    });
    assert.equal(await client.reconcileSessionDuration('apps/app', '168h', false), true);
    assert.equal(writes[0].body.session_duration, '168h');
    assert.deepEqual(writes[0].body.allowed_idps, ['idp']);
    assert.equal(writes[0].body.http_only_cookie_attribute, true);
    assert.deepEqual(writes[0].body.policies, [{ id: 'policy', precedence: 2 }]);
    assert.equal('id' in writes[0].body, false);
    assert.equal('aud' in writes[0].body, false);
});

test('preserves the required organization identity without replaying other response fields', async () => {
    const { client, writes } = accessMock({
        auth_domain: 'team.cloudflareaccess.com', name: 'Team', session_duration: '24h',
        allow_authenticate_via_warp: false, mfa_config: null,
        id: 'organization', created_at: '2026-01-01T00:00:00Z', is_ui_read_only: false,
        user_seat_expiration_inactive_time: '0s',
    });
    await client.reconcileSessionDuration('organizations', '168h', false, 'https://team.cloudflareaccess.com');
    assert.deepEqual(writes[0].body, {
        auth_domain: 'team.cloudflareaccess.com', name: 'Team', session_duration: '168h',
    });
    await assert.rejects(
        client.reconcileSessionDuration('organizations', '168h', false, 'https://other.cloudflareaccess.com'),
        /does not match/,
    );
    assert.equal(writes.length, 1);
});

test('session reconciliation is idempotent and dry runs never write', async () => {
    const unchanged = accessMock({ session_duration: '168h' });
    assert.equal(await unchanged.client.reconcileSessionDuration('apps/app', '168h', false), false);
    assert.equal(unchanged.writes.length, 0);
    const drift = accessMock({ session_duration: '24h' });
    await drift.client.reconcileSessionDuration('organizations', '168h', true);
    await drift.client.reconcileSessionDuration('apps/app', '168h', true);
    await drift.client.reconcileSessionDuration('apps/app/policies/policy', '168h', true);
    assert.equal(drift.writes.length, 0);
});

test('policy lifetime updates preserve authorization rules', async () => {
    const include = [{ email: { email: 'owner@example.com' } }];
    const require = [{ login_method: { id: 'idp' } }];
    const { client, writes } = accessMock({ id: 'policy', decision: 'allow', include, require, session_duration: '1h' });
    await client.reconcileSessionDuration('apps/app/policies/policy', '168h', false);
    assert.deepEqual(writes[0].body, { decision: 'allow', include, require, session_duration: '168h' });
});

test('new application lifetime is included at creation', async () => {
    const { client, writes } = accessMock({ id: 'app', aud: 'aud', domain: 'st.example.com', name: 'Hearthlog' });
    await client.createApp('Hearthlog', 'st.example.com', '168h');
    assert.equal(writes[0].body.session_duration, '168h');
});

test('tenant config rejects invalid and out-of-range session durations', async () => {
    const raw = JSON.parse(await readFile(new URL('../../../../tenants.json', import.meta.url), 'utf8')) as TenantFile & { infrastructure: InfrastructureDefinition };
    for (const key of ['accessSessionDuration', 'accessGlobalSessionDuration'] as const) {
        for (const value of ['0h', '721h', '7d', '168h ', 'NaNh']) {
            assert.throws(() => resolveInfrastructure({ ...raw, infrastructure: { ...raw.infrastructure, [key]: value } }), /whole hours/);
        }
        resolveInfrastructure({ ...raw, infrastructure: { ...raw.infrastructure, [key]: '720h' } });
    }
});
