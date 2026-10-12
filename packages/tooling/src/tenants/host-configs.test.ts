import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
    assert.match(hostWorkerDirectory('solo', 'gallery-public'), /\.generated\/sites\/solo\/gallery-public$/);
    await generateHostConfigs('shared');
    await generateHostConfigs('solo');
    assert.equal(read('solo', 'ledger').name, 'solo-prod-ledger');
    assert.deepEqual(read('solo', 'calendar-public').services.map((service: { service: string }) => service.service), ['solo']);
    // A site on its own stack gets a public Gallery Worker only when it ships the Gallery; the shared stack always has one.
    assert.equal(existsSync(hostWorkerConfigPath('solo', 'gallery-public')), false);
    assert.ok(read('shared', 'gallery-public').name);
    assert.equal(read('shared', 'ledger').main, './index.ts');
    assert.ok(!read('shared', 'calendar-public').services.some((service: { service: string }) => service.service === 'solo'));
    await assert.rejects(generateHostConfigs('alpha'), /no tenants\/alpha\/deployment\.json/);
});
