import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudflareAccessClient } from './cloudflare-access.js';

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

/** A fetch stub that records requests and answers with the given payload. */
function recordingFetch(
    answer: (call: RecordedCall) => { status?: number; body: unknown },
): { fetchRequest: typeof fetch; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const fetchRequest = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const call: RecordedCall = {
            url: String(input),
            method: init?.method ?? 'GET',
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        };
        calls.push(call);
        const { status = 200, body } = answer(call);
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as typeof fetch;
    return { fetchRequest, calls };
}

const accessBase = 'https://api.cloudflare.com/client/v4/accounts/account-1/access';

function client(fetchRequest: typeof fetch): CloudflareAccessClient {
    return new CloudflareAccessClient('token', 'account-1', fetchRequest);
}

test('listPolicies resolves reusability from the account-level registry', async () => {
    const { fetchRequest, calls } = recordingFetch((call) =>
        call.url === `${accessBase}/apps/app-1/policies`
            ? {
                body: [
                    { id: 'promoted', name: 'Site access (allow)', decision: 'allow', include: [] },
                    { id: 'inline', name: 'Site access (allow)', decision: 'allow', include: [] },
                ],
            }
            : {
                body: [{ id: 'promoted', name: 'shared', decision: 'allow', include: [], reusable: true }],
            },
    );

    const policies = await client(fetchRequest).listPolicies('app-1');

    assert.equal(policies[0]?.reusable, true);
    assert.equal(policies[1]?.reusable, false);
    assert.deepEqual(
        calls.map((call) => call.url),
        [
            `${accessBase}/apps/app-1/policies`,
            `${accessBase}/policies?per_page=100&page=1`,
        ],
    );
});

test('an app-scoped reusable flag is honored even without the registry', async () => {
    const { fetchRequest } = recordingFetch((call) =>
        call.url === `${accessBase}/apps/app-1/policies`
            ? { body: [{ id: 'flagged', name: 'shared', decision: 'allow', include: [], reusable: true }] }
            : { body: [] },
    );

    const policies = await client(fetchRequest).listPolicies('app-1');

    assert.equal(policies[0]?.reusable, true);
});

test('updating a reusable policy uses the account-scoped endpoint', async () => {
    const { fetchRequest, calls } = recordingFetch(() => ({ body: { success: true, result: {} } }));

    await client(fetchRequest).updateAllowPolicy(
        'app-1',
        'policy-1',
        'Site access (allow)',
        ['a@example.com'],
        true,
    );

    assert.equal(calls[0]?.url, `${accessBase}/policies/policy-1`);
    assert.equal(calls[0]?.method, 'PUT');
});

test('updating an app-scoped policy keeps the app-scoped endpoint', async () => {
    const { fetchRequest, calls } = recordingFetch(() => ({ body: { success: true, result: {} } }));

    await client(fetchRequest).updateAllowPolicy(
        'app-1',
        'policy-1',
        'Site access (allow)',
        ['a@example.com'],
    );

    assert.equal(calls[0]?.url, `${accessBase}/apps/app-1/policies/policy-1`);
});

test('deleting a reusable policy uses the account-scoped endpoint', async () => {
    const { fetchRequest, calls } = recordingFetch(() => ({ body: { success: true, result: {} } }));

    await client(fetchRequest).deletePolicy('app-1', 'policy-1', true);

    assert.equal(calls[0]?.url, `${accessBase}/policies/policy-1`);
    assert.equal(calls[0]?.method, 'DELETE');
});

test('a reusable policy session update stays at the account scope and drops response-only fields', async () => {
    const { fetchRequest, calls } = recordingFetch((call) =>
        call.method === 'GET'
            ? {
                body: {
                    success: true,
                    result: {
                        id: 'policy-1',
                        name: 'Site access (allow)',
                        decision: 'allow',
                        include: [{ email: { email: 'a@example.com' } }],
                        reusable: true,
                        account_id: 'account-1',
                        app_count: 2,
                    },
                },
            }
            : { body: { success: true, result: {} } },
    );

    await client(fetchRequest).reconcileSessionDuration('policies/policy-1', '168h', false);

    assert.equal(calls[0]?.url, `${accessBase}/policies/policy-1`);
    assert.equal(calls[1]?.url, `${accessBase}/policies/policy-1`);
    assert.equal(calls[1]?.method, 'PUT');
    assert.deepEqual(calls[1]?.body, {
        name: 'Site access (allow)',
        decision: 'allow',
        include: [{ email: { email: 'a@example.com' } }],
        session_duration: '168h',
    });
});
