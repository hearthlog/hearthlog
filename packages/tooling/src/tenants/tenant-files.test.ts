import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { moduleLockProblems } from './module-lock.js';
import { infrastructureFor, loadTenantConfig, TenantConfigError, TENANTS_FILE } from './tenant-config.js';

/** A throwaway repository root: the real infrastructure block, no sites, and whatever tenants/ files a test writes. */
function workspace(sites: unknown[] = []) {
    const root = mkdtempSync(join(tmpdir(), 'stor-tenants-'));
    const real = JSON.parse(readFileSync(TENANTS_FILE, 'utf8')) as { infrastructure: Record<string, unknown> };
    const { gallerySweeper: _sweeper, ...infrastructure } = real.infrastructure;
    writeFileSync(join(root, 'tenants.json'), JSON.stringify({ infrastructure, defaults: { features: [] }, sites }));
    const write = (site: string, file: string, value: unknown) => {
        mkdirSync(join(root, 'tenants', site), { recursive: true });
        writeFileSync(join(root, 'tenants', site, file), JSON.stringify(value));
    };
    return { root, file: join(root, 'tenants.json'), write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const owner = ['owner@example.com'];

test('a site may live in tenants/<id>/tenant.json instead of tenants.json', async () => {
    const space = workspace();
    try {
        space.write('notes', 'tenant.json', { schemaVersion: 1, id: 'notes', authorizedEmails: owner, features: ['calc'] });
        const { sites } = await loadTenantConfig(space.file);
        assert.deepEqual(sites.map((site) => [site.id, site.fromTenantFile, site.features]), [['notes', true, ['calc', 'calendar']]]);
    } finally {
        space.cleanup();
    }
});

test('a site named in both tenants.json and tenants/<id>/tenant.json is rejected, as is a mismatched directory', async () => {
    const both = workspace([{ id: 'notes', authorizedEmails: owner }]);
    try {
        both.write('notes', 'tenant.json', { schemaVersion: 1, id: 'notes', authorizedEmails: owner });
        await assert.rejects(loadTenantConfig(both.file), TenantConfigError);
    } finally {
        both.cleanup();
    }
    const wrong = workspace();
    try {
        wrong.write('notes', 'tenant.json', { schemaVersion: 1, id: 'other', authorizedEmails: owner });
        await assert.rejects(loadTenantConfig(wrong.file), /name of its directory/);
    } finally {
        wrong.cleanup();
    }
});

test('a deployment in its own account brings its own workers.dev domain, Access team, and origins', async () => {
    const space = workspace();
    try {
        space.write('owned', 'tenant.json', { schemaVersion: 1, id: 'owned', authorizedEmails: owner });
        space.write('owned', 'deployment.json', {
            schemaVersion: 1,
            resourcePrefix: 'owned-prod',
            ledger: 'dedicated',
            accountId: 'a'.repeat(32),
            workersDevDomain: 'their.workers.dev',
            authentication: { provider: 'cloudflare-access', teamDomain: 'https://their.cloudflareaccess.com' },
        });
        const { infrastructure, sites } = await loadTenantConfig(space.file);
        const site = sites[0]!;
        assert.equal(site.hostname, 'https://owned.their.workers.dev');
        const own = infrastructureFor(site, infrastructure);
        assert.equal(own.ledgerWorker, 'owned-prod-ledger');
        assert.equal(own.galleryPublicOrigin, 'https://owned-prod-gallery-public.their.workers.dev');
        assert.equal(own.accessTeamDomain, 'https://their.cloudflareaccess.com');
        // Another account's names never leak into the shared stack.
        assert.notEqual(infrastructure.workersDevDomain, 'their.workers.dev');
    } finally {
        space.cleanup();
    }
});

test('a malformed account id or workers.dev domain is rejected', async () => {
    for (const bad of [{ accountId: 'nope' }, { workersDevDomain: 'example.com' }, { authentication: { provider: 'other', teamDomain: 'https://x.example' } }]) {
        const space = workspace();
        try {
            space.write('owned', 'tenant.json', { schemaVersion: 1, id: 'owned', authorizedEmails: owner });
            space.write('owned', 'deployment.json', { schemaVersion: 1, resourcePrefix: 'owned-prod', ledger: 'dedicated', ...bad });
            await assert.rejects(loadTenantConfig(space.file), TenantConfigError);
        } finally {
            space.cleanup();
        }
    }
});

test('the module lock names what a site ships and fails when the site changed', async () => {
    const { sites } = await loadTenantConfig();
    const st = sites.find((site) => site.id === 'st')!;
    assert.deepEqual(await moduleLockProblems({ id: 'st', features: st.features }), []);
    const problems = await moduleLockProblems({ id: 'st', features: ['calc', 'calendar'] });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /stale/);
    assert.match((await moduleLockProblems({ id: 'unlocked', features: ['calendar'] }))[0]!, /missing/);
});

test('a site\'s event policy names the modules it ships and whether it may define entity types', async () => {
    const { siteEventPolicy } = await import('../deploy/event-policy.js');
    const { sites } = await loadTenantConfig();
    const st = sites.find((site) => site.id === 'st')!;
    // A site that lists only Health features ships only Health's contracts and defines no entity types.
    assert.deepEqual(siteEventPolicy({ ...st, features: ['calories', 'bmi', 'activities', 'calendar'], dynamicEntities: false }), { contracts: ['org.stor.health'], dynamicEvents: false, validation: 'enforce' });
    assert.equal(siteEventPolicy(st).dynamicEvents, true);
    assert.ok(siteEventPolicy(st).contracts.includes('org.stor.invoices'));
});

test('a deployment that names its account pins the generated Worker configs to it', async () => {
    const { buildLedgerConfig } = await import('./ledger-config.js');
    const { buildTenantWranglerConfig } = await import('./wrangler-config.js');
    const { infrastructure, sites } = await loadTenantConfig();
    const jst = sites.find((site) => site.id === 'jst')!;
    const pinned = { ...jst, deployment: { ...jst.deployment!, accountId: 'b'.repeat(32) } };
    const own = infrastructureFor(pinned, infrastructure);
    assert.equal(buildLedgerConfig(own, pinned.deployment.accountId).account_id, 'b'.repeat(32));
    assert.equal('account_id' in buildLedgerConfig(own), false);
    assert.equal(buildTenantWranglerConfig(pinned, own).account_id, 'b'.repeat(32));
    assert.equal('account_id' in buildTenantWranglerConfig(jst, infrastructureFor(jst, infrastructure)), false);
});

const OWN_ACCOUNT = {
    schemaVersion: 1,
    resourcePrefix: 'owned-prod',
    ledger: 'dedicated',
    workersDevDomain: 'their.workers.dev',
    authentication: { provider: 'cloudflare-access', teamDomain: 'https://their.cloudflareaccess.com' },
    ledgerAdminEmail: 'owner@example.com',
};

test('a repository whose sites all run on their own stacks needs no tenants.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stor-tenants-'));
    const write = (file: string, value: unknown) => {
        mkdirSync(join(root, 'tenants', 'owned'), { recursive: true });
        writeFileSync(join(root, 'tenants', 'owned', file), JSON.stringify(value));
    };
    try {
        write('tenant.json', { schemaVersion: 1, id: 'owned', authorizedEmails: owner, features: [] });
        write('deployment.json', { ...OWN_ACCOUNT, invoiceRendererOrigin: 'https://renderer.example', accessSessionDuration: '24h' });
        const { infrastructure, sites, stacks } = await loadTenantConfig(join(root, 'tenants.json'));
        const own = infrastructureFor(sites[0]!, infrastructure);
        assert.deepEqual(stacks, [{ id: 'owned', shared: false }]);
        assert.equal(sites[0]!.hostname, 'https://owned.their.workers.dev');
        assert.deepEqual(
            [own.ledgerWorker, own.accessTeamDomain, own.ledgerAdminEmail, own.invoiceRendererOrigin, own.accessSessionDuration],
            ['owned-prod-ledger', 'https://their.cloudflareaccess.com', 'owner@example.com', 'https://renderer.example', '24h'],
        );
        // Without the account values a standalone deployment file is incomplete, and a site on the shared stack has nothing to use.
        const { ledgerAdminEmail: _email, ...incomplete } = OWN_ACCOUNT;
        write('deployment.json', incomplete);
        await assert.rejects(loadTenantConfig(join(root, 'tenants.json')), /ledgerAdminEmail is required/);
        rmSync(join(root, 'tenants', 'owned', 'deployment.json'));
        await assert.rejects(loadTenantConfig(join(root, 'tenants.json')), /no tenants\/owned\/deployment\.json/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('one shared-stack site sweeps the Gallery bucket: the configured one, else the first by id', async () => {
    const { gallerySweeperId } = await import('./tenant-config.js');
    const { sweepsSharedStack } = await import('./wrangler-config.js');
    const stacks = [{ id: 'delta', shared: true }, { id: 'bravo', shared: true }, { id: 'jst', shared: false }];
    assert.equal(gallerySweeperId(stacks, {}), 'bravo');
    assert.equal(gallerySweeperId(stacks, { gallerySweeper: 'delta' }), 'delta');
    assert.equal(sweepsSharedStack(stacks, { gallerySweeper: 'delta' }, { id: 'delta', deployment: null }), true);
    assert.equal(sweepsSharedStack(stacks, { gallerySweeper: 'delta' }, { id: 'bravo', deployment: null }), false);
    const space = workspace([{ id: 'a', authorizedEmails: owner }]);
    try {
        const config = JSON.parse(readFileSync(space.file, 'utf8')) as { infrastructure: Record<string, string> };
        config.infrastructure.gallerySweeper = 'missing';
        writeFileSync(space.file, JSON.stringify({ ...config, defaults: { features: [] }, sites: [{ id: 'a', authorizedEmails: owner }] }));
        await assert.rejects(loadTenantConfig(space.file), /gallerySweeper "missing"/);
    } finally {
        space.cleanup();
    }
});

test('the shared stack names its account, and a malformed one is rejected', async () => {
    const space = workspace();
    try {
        const config = JSON.parse(readFileSync(space.file, 'utf8')) as { infrastructure: Record<string, string> };
        writeFileSync(space.file, JSON.stringify({ ...config, infrastructure: { ...config.infrastructure, accountId: 'c'.repeat(32) } }));
        assert.equal((await loadTenantConfig(space.file)).infrastructure.accountId, 'c'.repeat(32));
        writeFileSync(space.file, JSON.stringify({ ...config, infrastructure: { ...config.infrastructure, accountId: 'nope' } }));
        await assert.rejects(loadTenantConfig(space.file), /accountId must be a 32-character/);
    } finally {
        space.cleanup();
    }
});

test('a build checks only its own site against the modules it holds', async () => {
    const space = workspace();
    const before = process.env.VITE_STOR_TENANT;
    try {
        space.write('mine', 'tenant.json', { schemaVersion: 1, id: 'mine', authorizedEmails: owner, features: ['calc'] });
        space.write('theirs', 'tenant.json', { schemaVersion: 1, id: 'theirs', authorizedEmails: owner, features: ['not-in-this-catalog'], ai: ['unknown-capability'], home: '/somewhere' });
        process.env.VITE_STOR_TENANT = 'mine';
        const { sites } = await loadTenantConfig(space.file);
        assert.deepEqual(sites.map((site) => site.id), ['mine', 'theirs']);
        assert.ok(sites.find((site) => site.id === 'theirs')!.features.includes('not-in-this-catalog' as never));
        // The active site is still checked.
        process.env.VITE_STOR_TENANT = 'theirs';
        await assert.rejects(loadTenantConfig(space.file), /unknown feature id|not-in-this-catalog/);
        // With no site named, every site is checked.
        delete process.env.VITE_STOR_TENANT;
        await assert.rejects(loadTenantConfig(space.file), TenantConfigError);
    } finally {
        if (before === undefined) delete process.env.VITE_STOR_TENANT;
        else process.env.VITE_STOR_TENANT = before;
        space.cleanup();
    }
});

test('a module lock names no version, and is current for its site', async () => {
    const { sites } = await loadTenantConfig();
    const st = sites.find((site) => site.id === 'st')!;
    const { readFileSync } = await import('node:fs');
    const lock = JSON.parse(readFileSync(new URL('../../../../tenants/st/modules.lock.json', import.meta.url), 'utf8')) as { modules: Array<Record<string, unknown>> };
    assert.equal(lock.modules.every((entry) => !('version' in entry)), true, 'new locks name no version');
    assert.deepEqual(await moduleLockProblems({ id: 'st', features: st.features }), []);
});
