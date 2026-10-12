import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadModules } from '../compose/compose-modules.js';
import { exportedDeployment, exportedTenant, exportTenant } from './export-tenant.js';

const SHARED = {
    workersDevDomain: 'acme.workers.dev',
    accessTeamDomain: 'https://acme.cloudflareaccess.com',
    ledgerAdminEmail: 'owner@example.com',
    invoiceRendererOrigin: 'https://renderer.example.com',
    accessSessionDuration: '168h',
    gallerySweeper: 'other',
};

function host(deployment: object): string {
    const root = mkdtempSync(join(tmpdir(), 'export-host-'));
    mkdirSync(join(root, 'tenants', 'one', 'static'), { recursive: true });
    writeFileSync(join(root, 'tenants.json'), JSON.stringify({ infrastructure: SHARED }));
    writeFileSync(join(root, 'tenants', 'one', 'tenant.json'), JSON.stringify({ schemaVersion: 1, id: 'one', title: 'One' }));
    writeFileSync(join(root, 'tenants', 'one', 'modules.lock.json'), JSON.stringify({ schemaVersion: 1, platform: { moduleApi: 1 }, modules: [] }));
    writeFileSync(join(root, 'tenants', 'one', 'static', 'logo.svg'), '<svg/>');
    writeFileSync(join(root, 'tenants', 'one', 'deployment.json'), JSON.stringify(deployment));
    return root;
}

test('the shared account values are written into the exported deployment, the site\'s own values kept', () => {
    const result = exportedDeployment({ schemaVersion: 1, resourcePrefix: 'one-prod', ledgerAdminEmail: 'me@example.com' }, SHARED);
    assert.equal(result.workersDevDomain, 'acme.workers.dev');
    assert.deepEqual(result.authentication, { provider: 'cloudflare-access', teamDomain: 'https://acme.cloudflareaccess.com' });
    assert.equal(result.ledgerAdminEmail, 'me@example.com');
    assert.equal(result.accessSessionDuration, '168h');
    assert.equal('gallerySweeper' in result, false);
    assert.throws(() => exportedDeployment({ schemaVersion: 1 }, undefined), /workersDevDomain/);
});

test('the shared defaults a site relied on are written into its exported definition', () => {
    const result = exportedTenant({ id: 'one', title: 'One' }, { features: ['calc'], home: '/', title: 'shared' });
    assert.deepEqual(result, { id: 'one', title: 'One', features: ['calc'], home: '/' });
});

test('an exported tenant repository holds the tenant\'s files and the starter, and nothing from the host\'s state', async () => {
    const root = host({ schemaVersion: 1, resourcePrefix: 'one-prod', ledger: 'dedicated' });
    mkdirSync(join(root, '.wrangler', 'tenants', 'one'), { recursive: true });
    writeFileSync(join(root, '.wrangler', 'tenants', 'one', '.admin-token'), 'secret');
    const out = join(mkdtempSync(join(tmpdir(), 'export-out-')), 'repo');
    await exportTenant({ root, id: 'one', out, available: loadModules() });
    assert.equal(existsSync(join(out, 'tenants.json')), false);
    assert.equal(existsSync(join(out, '.wrangler')), false);
    assert.equal(readFileSync(join(out, 'tenants', 'one', 'static', 'logo.svg'), 'utf8'), '<svg/>');
    const deployment = JSON.parse(readFileSync(join(out, 'tenants', 'one', 'deployment.json'), 'utf8')) as { workersDevDomain: string };
    assert.equal(deployment.workersDevDomain, 'acme.workers.dev');
    const workflow = readFileSync(join(out, '.github', 'workflows', 'deploy.yml'), 'utf8');
    assert.equal(workflow.includes('paths:'), false);
    assert.match(workflow, /Deploy one/);
    assert.match(readFileSync(join(out, 'README.md'), 'utf8'), /hearthlog plan --site one/);
    await assert.rejects(exportTenant({ root, id: 'one', out, available: loadModules() }), /not empty/);
});

test('a site on the shared stack is refused', async () => {
    const root = host({});
    writeFileSync(join(root, 'tenants', 'one', 'deployment.json'), '{}');
    const bare = mkdtempSync(join(tmpdir(), 'export-host-'));
    mkdirSync(join(bare, 'tenants', 'two'), { recursive: true });
    writeFileSync(join(bare, 'tenants', 'two', 'tenant.json'), '{}');
    await assert.rejects(exportTenant({ root: bare, id: 'two', out: join(bare, 'out') }), /shared stack/);
});
