import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { generateHostConfigs, hostWorkerConfigPath, hostWorkerDirectory } from './host-configs.js';
import { buildLedgerConfig, LEDGER_BASE } from './ledger-config.js';

const read = (stack: string, worker: 'ledger' | 'calendar-public' | 'gallery-public') =>
    JSON.parse(readFileSync(hostWorkerConfigPath(stack, worker), 'utf8')) as Record<string, any>;

test('the Ledger keeps its Durable Object classes and takes only its name and account from the stack', () => {
    const config = buildLedgerConfig({ ledgerWorker: 'one-ledger' }, 'a'.repeat(32)) as Record<string, any>;
    assert.equal(config.name, 'one-ledger');
    assert.equal(config.account_id, 'a'.repeat(32));
    assert.deepEqual(config.durable_objects.bindings.map((binding: { class_name: string }) => binding.class_name), ['LedgerApp', 'AppRegistry']);
    assert.deepEqual(config.exports, LEDGER_BASE.exports);
    assert.equal('env' in config, false);
    assert.equal('account_id' in buildLedgerConfig({ ledgerWorker: 'one-ledger' }), false);
});

test('the shared stack and a site on its own stack each get their Workers in their own folders', async () => {
    assert.match(hostWorkerDirectory('shared', 'ledger'), /\.generated\/shared\/ledger$/);
    assert.match(hostWorkerDirectory('jst', 'gallery-public'), /\.generated\/sites\/jst\/gallery-public$/);
    await generateHostConfigs('shared');
    await generateHostConfigs('jst');
    assert.equal(read('jst', 'ledger').name, 'jst-prod-ledger');
    assert.deepEqual(read('jst', 'calendar-public').services.map((service: { service: string }) => service.service), ['jst']);
    assert.equal(read('jst', 'gallery-public').r2_buckets[0].bucket_name, 'jst-prod-gallery-public');
    assert.equal(read('shared', 'ledger').main, './index.ts');
    assert.ok(!read('shared', 'calendar-public').services.some((service: { service: string }) => service.service === 'jst'));
    await assert.rejects(generateHostConfigs('alpha'), /no tenants\/alpha\/deployment\.json/);
});
