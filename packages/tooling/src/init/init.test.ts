import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from '../compose/compose-modules.js';
import { renderSite } from './init.js';

/** Tests that need the real modules run in `pnpm test:integration`, which installs them. */
const needsModules = { skip: loadModules().length === 0 && 'needs the modules: pnpm test:integration' };
const files = (options: Parameters<typeof renderSite>[0]) => new Map(renderSite({ available: loadModules(), ...options }));

test('a site with no modules gets the core only: no module dependency, an empty lock, no features', () => {
    const site = files({ directory: 'unused', id: 'plain', modules: [], workspace: true });
    const packageJson = JSON.parse(site.get('package.json')!) as { dependencies: Record<string, string> };
    assert.equal(Object.keys(packageJson.dependencies).some((name) => name.includes('module-')), false);
    assert.deepEqual(JSON.parse(site.get('tenants/plain/modules.lock.json')!).modules, []);
    assert.deepEqual(JSON.parse(site.get('tenants/plain/tenant.json')!).features, []);
});

test('a module is named by package or short name; its features, dependency, and lock entry follow', needsModules, () => {
    for (const name of ['calc', '@hearthlog/module-calc']) {
        const site = files({ directory: 'unused', id: 'calcs', modules: [name], workspace: false });
        assert.deepEqual(JSON.parse(site.get('tenants/calcs/tenant.json')!).features, ['calc']);
        const lock = JSON.parse(site.get('tenants/calcs/modules.lock.json')!) as { modules: Array<{ package: string; manifestSha256: string }> };
        assert.deepEqual(lock.modules.map((entry) => entry.package), ['@hearthlog/module-calc']);
        assert.match(lock.modules[0]!.manifestSha256, /^[0-9a-f]{64}$/);
        const dependencies = (JSON.parse(site.get('package.json')!) as { dependencies: Record<string, string> }).dependencies;
        assert.match(dependencies['@hearthlog/module-calc']!, /^\^\d/);
        assert.equal(dependencies['@hearthlog/generated'], 'link:.generated');
    }
});

test('init refuses an unknown module and an id that is not a safe name', () => {
    assert.throws(() => files({ directory: 'unused', id: 'x', modules: ['nothing'] }), /No installed module is called "nothing"/);
    for (const id of ['', 'Upper', '../escape', '1abc']) assert.throws(() => files({ directory: 'unused', id }), /must be lowercase/);
});
