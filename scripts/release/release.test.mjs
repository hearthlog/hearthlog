import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compare, lockedVersion, makePlan, moveSetting, parseArgs, readJson, satisfies, updateModule } from './model.mjs';
import { acquireLock, Coordinator, Pending, writeJson } from './coordinator.mjs';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'hearthlog-release-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const paths = { core: join(root, 'core'), tenant: join(root, 'tenant'), modules: { photos: join(root, 'photos') } };
    const config = { core: { path: 'core', repo: 'example/core' }, modules: { photos: { path: 'photos', repo: 'private/photos' } }, tenants: { home: { path: 'tenant', repo: 'private/home' } } };
    for (const name of ['sdk', 'tooling', 'czech']) writeJson(join(paths.core, 'packages', name, 'package.json'), { name: `@hearthlog/${name}`, version: '0.1.8' });
    const manifest = { name: '@private/module-photos', version: '1.0.0', peerDependencies: { '@hearthlog/sdk': '>=0.1.0 <0.2.0' }, devDependencies: { '@hearthlog/tooling': '^0.1.8' }, publishConfig: { registry: 'https://npm.pkg.github.com' } };
    const contract = { id: 'photos', version: '1.0.0', package: manifest.name, compatibility: { moduleApi: 1 } };
    writeJson(join(paths.modules.photos, 'package.json'), manifest);
    writeJson(join(paths.modules.photos, 'hearthlog.module.json'), contract);
    writeJson(join(paths.tenant, 'package.json'), { dependencies: { '@hearthlog/sdk': '^0.1.8', '@hearthlog/tooling': '^0.1.8', '@hearthlog/generated': 'link:.generated', [manifest.name]: '^1.0.0' } });
    writeJson(join(paths.tenant, 'tenants', 'home', 'modules.lock.json'), { schemaVersion: 1, platform: { moduleApi: 1 }, modules: [] });
    writeFileSync(join(paths.tenant, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@hearthlog/sdk':\n        specifier: ^0.1.8\n        version: 0.1.8(peer@1.0.0)\n      '@private/module-photos':\n        specifier: ^1.0.0\n        version: 1.0.0(@hearthlog/sdk@0.1.8)\n`);
    return { root, config, paths, manifest, contract };
}

function coordinator(t, overrides = {}) {
    const data = fixture(t);
    const calls = [];
    let time = 0;
    const run = async (program, args, cwd, options) => {
        calls.push({ program, args, cwd, options });
        return overrides.run ? overrides.run(program, args, cwd, options) : { code: 0, stdout: '', stderr: '' };
    };
    const options = parseArgs(['core', '0.1.9', '--tenant', 'home', '--execute']);
    const directory = join(data.root, 'run');
    mkdirSync(directory);
    const dependencies = { run, sleep: async (ms) => { time += ms; }, now: () => time, log: () => {} };
    const instance = new Coordinator(data.config, options, directory, dependencies);
    return { ...data, calls, options, directory, dependencies, instance };
}

test('CLI parses the three operations, repeated modules, and rejects ambiguous input', () => {
    assert.equal(parseArgs(['core', '0.2.0', '--tenant', 'home']).execute, false);
    assert.deepEqual(parseArgs(['core', '0.2.0', '--tenant', 'home', '--module', 'photos@1.1.0']).modules, { photos: '1.1.0' });
    assert.equal(parseArgs(['module', 'photos', '1.1.0', '--tenant', 'home']).kind, 'module');
    assert.equal(parseArgs(['tenant', 'home', '--module', 'photos@1.1.0']).tenant, 'home');
    for (const args of [[], ['core', '0.2.0'], ['tenant', 'home'], ['core', 'latest', '--tenant', 'home'], ['core', '0.2.0-beta.1', '--tenant', 'home'], ['core', '0.2.0', '--tenant', 'home', '--merge'], ['core', '0.2.0', '--tenant', 'home', '--bad'], ['module', 'photos', '1.0.1', '--tenant', 'home', '--module', 'photos@1.0.2']]) {
        assert.throws(() => parseArgs(args));
    }
});

test('stable version ranges honor zero-major caret, exact alternatives, and fail closed', () => {
    assert.equal(compare('0.1.10', '0.1.9'), 1);
    for (const range of ['>=0.1.0 <0.2.0', '^0.1.8', '~0.1.8', '0.1.9', '*', '>= 0.1.0 < 0.2.0', '^0.0.1 || 0.1.9']) assert.equal(satisfies('0.1.9', range), true, range);
    for (const range of ['^0.0.8', '^0.2.0', '>=0.1.0 <0.1.9', '1.0.0']) assert.equal(satisfies('0.1.9', range), false, range);
    assert.throws(() => satisfies('0.1.9', '0.1.x'), /Unsupported/);
    assert.throws(() => satisfies('0.1.9', '* || nonsense'), /Unsupported/);
});

test('core patch retains locked module versions even when module main is ahead', (t) => {
    const { config, paths, manifest } = fixture(t);
    writeJson(join(paths.modules.photos, 'package.json'), { ...manifest, version: '1.5.0' });
    const plan = makePlan(config, parseArgs(['core', '0.1.9', '--tenant', 'home']), paths);
    assert.equal(plan.modules[0].changed, false);
    assert.equal(plan.modules[0].version, '1.0.0');
    assert.equal(lockedVersion(paths.tenant, '@hearthlog/sdk'), '0.1.8');
});

test('setting moves preserve values, are idempotent, and refuse conflicts or unsafe paths', () => {
    const from = ['legacyEndpoint'], to = ['moduleSettings', 'org.example.photos', 'endpoint'];
    const original = { legacyEndpoint: 'https://storage.example.invalid', other: 'keep' };
    const migrated = moveSetting(original, from, to);
    assert.equal(migrated.moduleSettings['org.example.photos'].endpoint, original.legacyEndpoint);
    assert.equal(migrated.other, 'keep');
    assert.equal('legacyEndpoint' in migrated, false);
    assert.deepEqual(moveSetting(migrated, from, to), migrated);
    assert.equal(original.legacyEndpoint, 'https://storage.example.invalid');
    assert.throws(() => moveSetting({ ...migrated, legacyEndpoint: 'different' }, from, to), /conflict/);
    assert.throws(() => moveSetting(original, from, ['__proto__', 'value']), /JSON key paths/);
    assert.throws(() => moveSetting(original, from, ['legacyEndpoint', 'child']), /JSON key paths/);
});

test('tenant migrations are selected by core version and restricted to tenant configuration', (t) => {
    const { instance, config, paths } = coordinator(t);
    config.tenants.home.migrations = [{ whenCore: '>=0.2.0', file: 'tenants/home/deployment.json', from: ['legacy'], to: ['moduleSettings', 'photos', 'endpoint'] }];
    const older = makePlan(config, parseArgs(['core', '0.1.9', '--tenant', 'home']), paths);
    assert.equal(older.migrations.length, 0);
    const plan = makePlan(config, parseArgs(['core', '0.2.0', '--tenant', 'home']), paths);
    writeJson(join(paths.tenant, 'tenants/home/deployment.json'), { legacy: 'https://storage.example.invalid' });
    instance.migrateTenant(paths.tenant, plan);
    instance.migrateTenant(paths.tenant, plan);
    assert.equal(readJson(join(paths.tenant, 'tenants/home/deployment.json')).moduleSettings.photos.endpoint, 'https://storage.example.invalid');
    assert.throws(() => instance.migrateTenant(paths.tenant, { migrations: [{ ...plan.migrations[0], file: '../outside.json' }] }), /only tenant JSON/);
});

test('incompatible platform peers and dev tooling are updated together and both module versions align', (t) => {
    const { manifest, contract } = fixture(t);
    const result = updateModule(manifest, contract, '0.2.0', ['@hearthlog/sdk', '@hearthlog/tooling']);
    assert.equal(result.manifest.version, '1.0.1');
    assert.equal(result.contract.version, '1.0.1');
    assert.equal(result.manifest.peerDependencies['@hearthlog/sdk'], '>=0.1.0 <0.2.0 || 0.2.0');
    assert.equal(result.manifest.devDependencies['@hearthlog/tooling'], '^0.1.8 || 0.2.0');
    assert.equal(result.contract.compatibility.moduleApi, 1);
    assert.throws(() => updateModule(manifest, contract, '0.2.0', ['@hearthlog/sdk'], '1.0.0'), /new version/);
    assert.equal(updateModule(manifest, { ...contract, version: '0.9.0' }, '0.1.9', ['@hearthlog/sdk']).changed, false);
    assert.equal(updateModule(manifest, { ...contract, version: '0.9.0' }, undefined, [], '1.0.1').contract.version, '1.0.1');
});

test('tenant-only adoption never publishes or changes module compatibility', (t) => {
    const { config, paths } = fixture(t);
    const plan = makePlan(config, parseArgs(['tenant', 'home', '--core', '0.2.0', '--module', 'photos@1.2.0']), paths);
    assert.equal(plan.publishCore, false);
    assert.equal(plan.modules[0].changed, false);
    assert.equal(plan.modules[0].version, '1.2.0');
    assert.equal(plan.modules[0].manifest.peerDependencies['@hearthlog/sdk'], '>=0.1.0 <0.2.0');
});

test('unknown module and already released core version fail before execution', (t) => {
    const { config, paths } = fixture(t);
    assert.throws(() => makePlan(config, parseArgs(['core', '0.1.8', '--tenant', 'home']), paths), /new core version/);
    assert.throws(() => makePlan(config, parseArgs(['module', 'unknown', '1.0.1', '--tenant', 'home']), paths), /Unknown/);
});

test('preview creates no state or checkout and does not invoke process tools', (t) => {
    const { root, config } = fixture(t);
    const file = join(root, 'release.config.json');
    writeJson(file, config);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./release.mjs', import.meta.url)), '--config', file, 'core', '0.1.9', '--tenant', 'home'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Preview uses local/);
    assert.equal(existsSync(join(root, '.releases')), false);
});

test('tenant pins only selected platform/module packages and preserves generated link', (t) => {
    const { instance, paths, config } = coordinator(t);
    const plan = makePlan(config, parseArgs(['tenant', 'home', '--core', '0.2.0', '--module', 'photos@1.2.0']), paths);
    instance.setTenantVersions(paths.tenant, plan);
    const dependencies = readJson(join(paths.tenant, 'package.json')).dependencies;
    assert.equal(dependencies['@hearthlog/sdk'], '0.2.0');
    assert.equal(dependencies['@private/module-photos'], '1.2.0');
    assert.equal(dependencies['@hearthlog/generated'], 'link:.generated');
});

test('installed Hearthlog versions and module peers are checked independently of third-party peer warnings', (t) => {
    const { instance, paths, config } = coordinator(t);
    const plan = makePlan(config, parseArgs(['tenant', 'home', '--core', '0.2.0', '--module', 'photos@1.2.0']), paths);
    writeJson(join(paths.tenant, 'node_modules', '@hearthlog/sdk', 'package.json'), { version: '0.2.0' });
    const file = join(paths.tenant, 'node_modules', '@private/module-photos', 'package.json');
    writeJson(file, { version: '1.2.0', peerDependencies: { '@hearthlog/sdk': '>=0.1.0 <0.2.0 || 0.2.0', '@sveltejs/kit': '^2.21.0' } });
    instance.validateInstalled(paths.tenant, plan);
    writeJson(file, { version: '1.2.0', peerDependencies: { '@hearthlog/sdk': '<0.2.0' } });
    assert.throws(() => instance.validateInstalled(paths.tenant, plan), /does not support core/);
    writeJson(join(paths.tenant, 'node_modules', '@hearthlog/sdk', 'package.json'), { version: '0.1.8' });
    assert.throws(() => instance.validateInstalled(paths.tenant, plan), /must resolve to core/);
});

test('explicit tenant compiler dependencies enter the package without changing the generated link', (t) => {
    const { instance, paths, config } = coordinator(t);
    config.tenants.home.devDependencies = { '@types/node': '^24.0.0', kysely: '^0.29.6' };
    const plan = makePlan(config, parseArgs(['core', '0.2.0', '--tenant', 'home']), paths);
    instance.setTenantVersions(paths.tenant, plan);
    const manifest = readJson(join(paths.tenant, 'package.json'));
    assert.deepEqual(manifest.devDependencies, config.tenants.home.devDependencies);
    assert.equal(manifest.dependencies['@hearthlog/generated'], 'link:.generated');
});

test('standard type checks warn only for installed-dependency unused symbols; real type errors still block', async (t) => {
    let output = "node_modules/@hearthlog/contracts/src/definitions.ts(1,1): error TS6133: 'helper' is declared but never read.";
    const { instance, paths } = coordinator(t, { run: async () => ({ code: 2, stdout: output, stderr: '' }) });
    const manifest = readJson(join(paths.tenant, 'package.json'));
    manifest.scripts = { check: 'hearthlog build && svelte-kit sync && tsc --noEmit -p tsconfig.json --skipLibCheck' };
    writeJson(join(paths.tenant, 'package.json'), manifest);
    await instance.checkSiteTypes(paths.tenant);
    output = 'node_modules/@private/module-photos/src/page.ts(1,1): error TS2345: Argument has the wrong type.';
    await assert.rejects(instance.checkSiteTypes(paths.tenant), /Site check failed/);
    output = ".generated/src/page.ts(1,1): error TS6133: 'helper' is declared but never read.";
    await assert.rejects(instance.checkSiteTypes(paths.tenant), /Site check failed/);
    output = "node_modules/library/index.ts(1,1): error TS6133: 'helper' is declared but never read.";
    manifest.scripts.check = 'custom-check';
    writeJson(join(paths.tenant, 'package.json'), manifest);
    await assert.rejects(instance.checkSiteTypes(paths.tenant), /Site check failed/);
});

test('a prepared module source branch is cloned without changing its release PR target', async (t) => {
    const { instance, calls } = coordinator(t);
    const entry = { repo: 'example/photos', sourceRef: 'fix/prepared-source' };
    await instance.clone('module-photos', entry);
    const clone = calls.find((call) => call.program === 'gh' && call.args[0] === 'repo');
    assert.equal(clone.args[clone.args.indexOf('--branch') + 1], 'fix/prepared-source');
    assert.equal(entry.branch ?? 'main', 'main');
});

test('a prepared source branch still goes through a PR when its release metadata is already set', async (t) => {
    const { instance, paths, manifest, contract } = coordinator(t);
    instance.state.repositories['module-photos'] = { sha: 'prepared-source-sha' };
    instance.commit = async () => null;
    let checked = false;
    instance.pullRequest = async (key, entry, path, commit) => {
        assert.equal(key, 'module-photos');
        assert.equal(commit.sha, 'prepared-source-sha');
        assert.equal(commit.existing, false);
        checked = true;
        throw new Pending('PR review');
    };
    await assert.rejects(instance.publishModule({ alias: 'photos', directory: paths.modules.photos, manifest, contract, sourceRef: 'fix/prepared-source' }, {}), Pending);
    assert.equal(checked, true);
});

test('successful checkpoints survive a restart while failed actions run again', async (t) => {
    const { instance, config, options, directory, dependencies } = coordinator(t);
    let count = 0;
    await instance.step('good', async () => ++count);
    await instance.step('unchanged', async () => null);
    await assert.rejects(instance.step('bad', async () => { throw new Error('stopped'); }), /stopped/);
    const resumed = new Coordinator(config, options, directory, dependencies);
    assert.equal(await resumed.step('unchanged', async () => assert.fail('unchanged must remain null')), null);
    assert.equal(await resumed.step('good', async () => ++count), 1);
    assert.equal(await resumed.step('bad', async () => ++count), 2);
    assert.equal(count, 2);
});

test('PR checks wait for registration, reject failures, and require a passing check', async (t) => {
    let results = [{ code: 1, stdout: '', stderr: 'no checks reported' }, { code: 8, stdout: '[{"bucket":"pending"}]' }, { code: 0, stdout: '[{"bucket":"skipping"}]' }, { code: 0, stdout: '[{"bucket":"pass"}]' }];
    const { instance, directory } = coordinator(t, { run: async () => results.shift() });
    await instance.waitChecks('https://github.com/example/core/pull/1', 'example/core', directory);
    results = [{ code: 1, stdout: '[{"bucket":"fail","name":"Build","link":"https://example.invalid/check"}]' }];
    await assert.rejects(instance.waitChecks('https://github.com/example/core/pull/1', 'example/core', directory), /PR checks failed|Cannot read PR checks/);
});

test('candidate validation failure stops before any workflow, PR, or tag publication', async (t) => {
    const { instance, calls, paths } = coordinator(t);
    instance.clone = async (key) => key === 'core' ? paths.core : key === 'tenant' ? paths.tenant : paths.modules.photos;
    instance.validateCandidates = async () => { throw new Error('candidate build failed'); };
    await assert.rejects(instance.execute(), /candidate build failed/);
    assert.deepEqual(calls.map(({ program, args }) => [program, args[0]]), [['gh', 'auth']]);
});

test('uncertain dispatch is saved before the call and cannot dispatch twice on resume', async (t) => {
    const { instance, calls, config, options, directory, dependencies } = coordinator(t, { run: async (program, args) => {
        if (program === 'gh' && args[0] === 'workflow') throw new Error('connection lost after sending');
        return { code: 0, stdout: '', stderr: '' };
    } });
    instance.state.repositories.core = { sha: 'source-sha' };
    await assert.rejects(instance.publishCore({ core: '0.1.9', platformNames: [] }, directory), /connection lost/);
    assert.equal(readJson(join(directory, 'state.json')).actions['core:publish'].intent, true);
    const resumed = new Coordinator(config, options, directory, dependencies);
    resumed.findRun = async () => { throw new Error('still undiscovered'); };
    await assert.rejects(resumed.publishCore({ core: '0.1.9', platformNames: [] }, directory), /still undiscovered/);
    const dispatches = calls.filter((call) => call.program === 'gh' && call.args[0] === 'workflow');
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0].args.includes('expected_sha=source-sha'));
});

test('workflow discovery matches exact commit/title and rejects ambiguous runs', async (t) => {
    const { instance } = coordinator(t);
    instance.gh = async () => [{ databaseId: 1, headSha: 'other', displayTitle: 'release' }, { databaseId: 2, headSha: 'wanted', displayTitle: 'release' }];
    const run = await instance.findRun('publish', 'example/core', { workflow: 'release.yml', event: 'push', sha: 'wanted', title: 'release' });
    assert.equal(run.databaseId, 2);
    instance.gh = async () => [{ databaseId: 3 }, { databaseId: 4 }];
    await assert.rejects(instance.findRun('ambiguous', 'example/core', { workflow: 'release.yml', event: 'push' }), /Ambiguous/);
});

test('failed Actions jobs stop by default and require an explicit retry', async (t) => {
    const { instance, calls } = coordinator(t);
    let responses = [{ status: 'completed', conclusion: 'failure', url: 'https://github.com/example/core/actions/runs/1' }];
    instance.gh = async () => responses.shift();
    await assert.rejects(instance.waitRun('publish', 'example/core', { databaseId: 1 }), /failure/);
    assert.equal(calls.length, 0);
    instance.options.retryFailed = true;
    responses = [{ status: 'completed', conclusion: 'failure' }, { status: 'completed', conclusion: 'success' }];
    await instance.waitRun('publish', 'example/core', { databaseId: 1 });
    assert.equal(calls.filter((call) => call.args.includes('rerun')).length, 1);
});

test('PR head changes prevent merge and publication; an unchanged open PR exits pending', async (t) => {
    const { instance, directory, calls } = coordinator(t);
    instance.state.steps['module:push'] = true;
    instance.state.steps['module:pr'] = { url: 'https://github.com/example/core/pull/1' };
    instance.options.merge = true;
    instance.gh = async () => ({ state: 'OPEN', headRefOid: 'unexpected' });
    await assert.rejects(instance.pullRequest('module', { repo: 'example/core' }, directory, { sha: 'validated' }), /changed since validation/);
    assert.equal(calls.length, 0);
    instance.options.merge = false;
    instance.gh = async () => ({ state: 'OPEN', headRefOid: 'validated' });
    await assert.rejects(instance.pullRequest('module', { repo: 'example/core' }, directory, { sha: 'validated' }), Pending);
});

test('a preexisting module tag at another commit is never overwritten', async (t) => {
    const { instance, calls, directory } = coordinator(t, { run: async (program, args) => ({ code: 0, stdout: args[0] === 'ls-remote' ? 'wrong-sha\trefs/tags/v1.0.1' : '', stderr: '' }) });
    instance.state.steps['module-photos:prepare'] = { sha: 'validated', existing: true };
    await assert.rejects(instance.publishModule({ alias: 'photos', repo: 'example/photos', directory, version: '1.0.1' }, {}), /different commit/);
    assert.equal(calls.filter((call) => call.args[0] === 'push').length, 0);
});

test('registry authentication errors stop immediately without polling or retry', async (t) => {
    const { instance, calls } = coordinator(t, { run: async () => ({ code: 1, stdout: '', stderr: 'ERR_PNPM_FETCH_401 Unauthorized' }) });
    await assert.rejects(instance.waitPackages([{ name: '@private/module-photos', version: '1.0.1', registry: 'https://npm.pkg.github.com' }]), /Registry check failed/);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('https://npm.pkg.github.com'));
});

test('workspace lock prevents concurrent releases and can be released', (t) => {
    const { root } = fixture(t);
    const path = join(root, 'lock');
    const release = acquireLock(path);
    assert.throws(() => acquireLock(path), /Another release/);
    release();
    acquireLock(path)();
});

test('core workflow binds source validation and run correlation without changing manual defaults', () => {
    const text = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
    assert.match(text, /run-name: Release v\$\{\{ inputs.version \}\}/);
    assert.match(text, /EXPECTED_SHA: \$\{\{ inputs.expected_sha \}\}/);
    assert.ok(text.indexOf('Check the validated source commit') < text.indexOf('Set the version'));
    assert.match(text, /environment: npm/);
});

test('core → module → tenant run resumes across both PRs without repeating dispatch, tags, or validation', async (t) => {
    const data = fixture(t);
    const git = (args, cwd) => {
        const result = spawnSync('git', ['-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid', ...args], { cwd, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`Fixture git ${args.join(' ')}: ${result.stderr}`);
        return result.stdout.trim();
    };
    for (const path of [data.paths.core, data.paths.tenant, data.paths.modules.photos]) {
        git(['init', '--initial-branch=main'], path);
        git(['add', '.'], path);
        git(['commit', '-m', 'Initial fixture'], path);
    }
    const sources = { 'example/core': data.paths.core, 'private/photos': data.paths.modules.photos, 'private/home': data.paths.tenant };
    const directory = join(data.root, 'run');
    mkdirSync(directory);
    const options = parseArgs(['core', '0.2.0', '--tenant', 'home', '--execute']);
    const calls = [];
    const prs = new Map();
    let dispatchTitle;
    const result = (value = '') => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
    const run = async (program, args, cwd, options = {}) => {
        calls.push({ program, args, cwd });
        if (program === 'git') {
            const inspected = spawnSync('git', ['-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid', ...args], { cwd, encoding: 'utf8' });
            if (inspected.status !== 0 && !options.allowFailure) throw new Error(`Fixture git ${args.join(' ')} failed: ${inspected.stderr}`);
            return { code: inspected.status, stdout: inspected.stdout.trim(), stderr: inspected.stderr.trim() };
        }
        if (program === 'pnpm') {
            if (args[0] === 'pack') {
                const manifest = readJson(join(cwd, 'package.json'));
                const out = args[args.indexOf('--pack-destination') + 1];
                mkdirSync(out, { recursive: true });
                writeFileSync(join(out, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`), 'fixture');
            }
            if (args[0] === 'view') return result(JSON.stringify(args[1].slice(args[1].lastIndexOf('@') + 1)));
            return result();
        }
        assert.equal(program, 'gh');
        const repo = args[args.indexOf('--repo') + 1];
        const value = (name) => args[args.indexOf(name) + 1];
        if (args[0] === 'auth') return result();
        if (args[0] === 'repo' && args[1] === 'clone') {
            git(['clone', '--branch', 'main', sources[args[2]], args[3]], directory);
            return result();
        }
        if (args[0] === 'workflow') {
            const id = args.find((arg) => arg.startsWith('release_id=')).split('=')[1];
            dispatchTitle = `Release v0.2.0 (${id})`;
            return result();
        }
        if (args[0] === 'run' && args[1] === 'list') {
            const module = repo === 'private/photos';
            return result([{ databaseId: repo === 'example/core' ? 1 : module ? 2 : 3,
                headSha: value('--commit'), headBranch: module ? 'v1.0.1' : 'main', displayTitle: dispatchTitle, url: 'https://example.invalid/run' }]);
        }
        if (args[0] === 'run' && args[1] === 'view') return result({ status: 'completed', conclusion: 'success' });
        if (args[0] === 'run' && args[1] === 'download') {
            writeJson(join(value('--dir'), 'receipt.json'), { schemaVersion: 1, siteId: 'home', steps: { frontend: { completedAt: 'now' }, verify: { completedAt: 'now' } } });
            return result();
        }
        if (args[0] === 'pr' && args[1] === 'list') return result([]);
        if (args[0] === 'pr' && args[1] === 'create') {
            const sha = git(['rev-parse', 'HEAD'], cwd);
            const url = `https://github.com/${repo}/pull/1`;
            prs.set(repo, { url, headRefOid: sha, state: 'OPEN', mergeCommit: { oid: sha } });
            return result(url);
        }
        if (args[0] === 'pr' && args[1] === 'view') return result(prs.get(repo));
        assert.fail(`Unexpected tool call: ${program} ${args.join(' ')}`);
    };
    const dependencies = { run, log: () => {}, sleep: async () => assert.fail('No waiting expected') };
    const coordinator = () => {
        const instance = new Coordinator(data.config, options, directory, dependencies);
        // This test fakes pnpm installation; installed-package validation has a separate filesystem regression test.
        instance.validateInstalled = () => {};
        return instance;
    };
    await assert.rejects(coordinator().execute(), /Merge https:\/\/github.com\/private\/photos/);
    const validated = calls.filter((call) => call.program === 'pnpm' && call.args.includes('check-module')).length;
    assert.equal(validated, 1);
    prs.get('private/photos').state = 'MERGED';
    await assert.rejects(coordinator().execute(), /Merge https:\/\/github.com\/private\/home/);
    prs.get('private/home').state = 'MERGED';
    await coordinator().execute();
    await coordinator().execute();
    assert.equal(calls.filter((call) => call.program === 'gh' && call.args[0] === 'workflow').length, 1);
    assert.equal(calls.filter((call) => call.program === 'pnpm' && call.args.includes('check-module')).length, validated);
    assert.equal(calls.filter((call) => call.program === 'git' && call.args[0] === 'tag').length, 1);
    assert.equal(calls.filter((call) => call.program === 'gh' && call.args[0] === 'pr' && call.args[1] === 'create').length, 2);
    const state = readJson(join(directory, 'state.json'));
    assert.equal(state.steps['tenant:receipt'].receipt.siteId, 'home');
    assert.equal(readJson(join(data.paths.modules.photos, 'package.json')).version, '1.0.0', 'source checkouts must stay untouched');
});
