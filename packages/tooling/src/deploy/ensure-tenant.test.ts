import assert from 'node:assert/strict';
import test from 'node:test';

import { collectSecrets, isBucketAlreadyExistsError } from './ensure-tenant.js';

/**
 * The deploy matrix runs `ensure-tenant` once per site in parallel, so
 * concurrent processes race to create the shared R2 buckets. Losers must treat
 * Cloudflare's "already exists and you own it" answer as success.
 */
test('treats a raced R2 bucket create as already provisioned', () => {
	assert.equal(
		isBucketAlreadyExistsError(
			'The bucket you tried to create already exists, and you own it. [code: 10004]',
		),
		true,
	);
	assert.equal(
		isBucketAlreadyExistsError(
			'[code: 10004] The bucket you tried to create already exists, and you own it.',
		),
		true,
	);
});

test('does not swallow real R2 failures', () => {
	assert.equal(
		isBucketAlreadyExistsError(
			"The bucket you tried to create already exists, and you don't own it. [code: 10004]",
		),
		false,
	);
	assert.equal(
		isBucketAlreadyExistsError('already exists'),
		false,
		'a bare phrase without code and ownership stays a failure',
	);
	assert.equal(
		isBucketAlreadyExistsError('Authentication error [code: 10000]'),
		false,
	);
	assert.equal(isBucketAlreadyExistsError(''), false);
});

test('the administrator proxy gets the token of the Ledger the gateway is bound to, not the operator\'s shared one', async () => {
    const before = process.env.LEDGER_ADMIN_TOKEN;
    process.env.LEDGER_ADMIN_TOKEN = 'shared-ledger-token';
    try {
        const infrastructure = { accessTeamDomain: 'https://team.example.com' };
        const admin = { id: 'st', admin: true, integrations: [] };
        const own = await collectSecrets(admin, infrastructure, 'gateway-token', undefined, undefined, 'own-ledger-token');
        assert.equal(own.LEDGER_ADMIN_TOKEN, 'own-ledger-token');
        assert.equal(own.LEDGER_AUTH_TOKEN, 'gateway-token');
        // No Ledger contacted (--skip-ledger): the operator's variable is the fallback.
        assert.equal((await collectSecrets(admin, infrastructure, null, undefined, undefined)).LEDGER_ADMIN_TOKEN, 'shared-ledger-token');
        // A site without the proxy never receives an administrator token.
        assert.equal('LEDGER_ADMIN_TOKEN' in await collectSecrets({ ...admin, admin: false }, infrastructure, null, undefined, undefined, 'own-ledger-token'), false);
    } finally {
        if (before === undefined) delete process.env.LEDGER_ADMIN_TOKEN;
        else process.env.LEDGER_ADMIN_TOKEN = before;
    }
});
