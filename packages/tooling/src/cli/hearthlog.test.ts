import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPlan, checkProtected, executorsFor, receiptPath } from './hearthlog.js';

test('every site in tenants.json plans without problems', async () => {
    for (const id of ['st', 'jst']) {
        const plan = await buildPlan(id);
        assert.deepEqual(plan.problems, [], id);
        // Only a site on its own stack deploys a Ledger of its own.
        assert.equal(plan.steps.some((step) => step.id === 'ledger'), plan.topology === 'dedicated', id);
    }
    const jst = await buildPlan('jst');
    assert.ok(jst.resources.some((resource) => resource.name === 'jst-prod-invoice-pdfs'));
});

test('the origin must send a visitor to sign in', async () => {
    const answer = (status: number): typeof fetch => async () => new Response(null, { status });
    await checkProtected('https://x.example', answer(302));
    await checkProtected('https://x.example', answer(403));
    await assert.rejects(checkProtected('https://x.example', answer(200)), /not protected/);
    await assert.rejects(checkProtected('https://x.example', answer(500)), /expected a sign-in/);
});

test('the receipt lives in protected state and the executors never rotate a token', () => {
    assert.match(receiptPath('jst'), /\.wrangler\/tenants\/jst\/receipt\.json$/);
    const source = Object.values(executorsFor('jst', true)).map(String).join('\n');
    assert.doesNotMatch(source, /rotate-token/);
});

test('a run that may not bootstrap stops before creating credentials for a Ledger it holds no token for', async () => {
    // "zz-unprovisioned" has no administrator token anywhere, so the Ledger would have to be bootstrapped.
    const { ledger } = executorsFor('zz-unprovisioned', true, { noBootstrap: true });
    await assert.rejects(
        ledger({ id: 'ledger', summary: '' } as Parameters<typeof ledger>[0]),
        /LEDGER_ADMIN_TOKEN_ZZ_UNPROVISIONED[\s\S]*does not create credentials/,
    );
});
