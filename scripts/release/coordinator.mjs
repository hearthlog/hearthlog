import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, cpSync, openSync, closeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, makePlan, moveSetting, platformPackages, printPlan, readJson, satisfies } from './model.mjs';

export function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
}

export async function command(program, args, cwd, { capture = false, allowFailure = false } = {}) {
    return new Promise((resolveCommand, reject) => {
        const child = spawn(program, args, { cwd, env: { ...process.env, CI: 'true', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
            stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout?.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-16000); if (!capture) process.stderr.write(data); });
        child.on('error', reject);
        child.on('close', (code) => {
            const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
            if (code !== 0 && !allowFailure) reject(new Error(`${program} ${args.join(' ')} failed (${code})${capture ? `\n${stderr}` : ''}`));
            else resolveCommand(result);
        });
    });
}

export function acquireLock(path) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
        const owner = readJson(path);
        let alive = true;
        if (owner.host === hostname()) {
            try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        }
        if (alive) throw new Error(`Another release owns ${path} (PID ${owner.pid} on ${owner.host})`);
        rmSync(path);
    }
    const descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, host: hostname() }));
    closeSync(descriptor);
    return () => rmSync(path, { force: true });
}

export class Pending extends Error {}

export class Coordinator {
    constructor(config, options, directory, dependencies = {}) {
        this.config = config;
        this.options = options;
        this.directory = directory;
        this.run = dependencies.run ?? command;
        this.sleep = dependencies.sleep ?? delay;
        this.log = dependencies.log ?? console.log;
        this.now = dependencies.now ?? (() => Date.now());
        this.file = join(directory, 'state.json');
        this.state = existsSync(this.file) ? readJson(this.file) : { schema: 1, id: randomUUID().replaceAll('-', '').slice(0, 16), request: this.request(), steps: {}, repositories: {}, actions: {} };
        if (this.state.schema !== 1) throw new Error('Unsupported release state schema');
        if (JSON.stringify(this.state.request) !== JSON.stringify(this.request())) throw new Error('Saved release request/configuration differs; use a separate state directory');
        this.id = this.state.id ?? digest(this.state.request);
        this.branch = `release/coordinated-${this.id}`;
    }

    request() {
        const { kind, tenant, core, modules } = this.options;
        return { config: this.config, kind, tenant, core, modules: Object.fromEntries(Object.entries(modules).sort()) };
    }

    save() { writeJson(this.file, this.state); }
    async shell(program, args, cwd, options) { return this.run(program, args, cwd, options); }
    async output(program, args, cwd) { return (await this.shell(program, args, cwd, { capture: true })).stdout; }
    async gh(args) { return JSON.parse(await this.output('gh', args, this.directory)); }
    async step(key, action) {
        if (Object.hasOwn(this.state.steps, key)) return this.state.steps[key];
        this.log(`\n${key}`);
        const result = await action();
        this.state.steps[key] = result === undefined ? true : result;
        this.save();
        return result;
    }

    async clone(key, entry) {
        return this.step(`checkout:${key}`, async () => {
            const path = join(this.directory, 'repos', key);
            // An interrupted clone contains no operator work; recreate it before recording the immutable SHA.
            rmSync(path, { force: true, recursive: true });
            mkdirSync(dirname(path), { recursive: true });
            await this.shell('gh', ['repo', 'clone', entry.repo, path, '--', '--branch', entry.sourceRef ?? entry.branch ?? 'main', '--single-branch'], this.directory);
            const sha = await this.output('git', ['rev-parse', 'HEAD'], path);
            this.state.repositories[key] = { path, sha, repo: entry.repo };
            return path;
        });
    }

    async execute() {
        mkdirSync(this.directory, { recursive: true });
        this.save();
        await this.shell('gh', ['auth', 'status'], this.directory, { capture: true });
        const paths = { core: await this.clone('core', this.config.core), tenant: await this.clone('tenant', this.config.tenants[this.options.tenant]), modules: {} };
        for (const [alias, entry] of Object.entries(this.config.modules)) paths.modules[alias] = await this.clone(`module-${alias}`, entry);
        const plan = await this.step('plan', async () => makePlan(this.config, this.options, paths));
        printPlan(plan, this.log);
        if (this.options.kind === 'tenant') {
            await this.requirePublished(plan);
        } else {
            await this.step('validate:candidates', () => this.validateCandidates(plan, paths));
            if (plan.publishCore) await this.publishCore(plan, paths.core);
            else await this.waitPackages(plan.platformNames.map((name) => ({ name, version: plan.core })));
            for (const item of plan.modules.filter((item) => item.changed)) await this.publishModule(item, plan);
        }
        await this.requirePublished(plan);
        const tenant = await this.step('tenant:prepare', () => this.prepareTenant(plan, paths.tenant));
        if (!tenant) {
            this.log('Tenant already has these versions and contracts; no deployment needed.');
            return;
        }
        const merged = await this.pullRequest('tenant', this.config.tenants[plan.tenant], paths.tenant, tenant);
        const workflow = await this.findRun('tenant:deploy', this.config.tenants[plan.tenant].repo, {
            workflow: 'deploy.yml', event: 'push', sha: merged.sha,
        });
        await this.waitRun('tenant:deploy', this.config.tenants[plan.tenant].repo, workflow);
        await this.step('tenant:receipt', async () => {
            const destination = join(this.directory, 'receipt');
            rmSync(destination, { recursive: true, force: true });
            await this.shell('gh', ['run', 'download', String(workflow.databaseId), '--repo', this.config.tenants[plan.tenant].repo, '--name', 'receipt', '--dir', destination], this.directory);
            const files = readdirSync(destination, { recursive: true }).filter((name) => name.endsWith('receipt.json'));
            if (files.length !== 1) throw new Error(`Expected one deployment receipt in ${destination}`);
            const receipt = readJson(join(destination, files[0]));
            if (receipt.schemaVersion !== 1 || receipt.siteId !== plan.site || !receipt.steps?.frontend?.completedAt || !receipt.steps?.verify?.completedAt) {
                throw new Error(`Deployment receipt does not confirm frontend and verification for ${plan.site}`);
            }
            return { path: join(destination, files[0]), receipt };
        });
        this.log(`Release complete. Receipt: ${this.state.steps['tenant:receipt'].path}`);
    }

    async pack(directory, destination) {
        mkdirSync(destination, { recursive: true });
        const manifest = readJson(join(directory, 'package.json'));
        await this.shell('pnpm', ['pack', '--pack-destination', destination], directory);
        const path = join(destination, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`);
        if (!existsSync(path)) throw new Error(`Package tarball missing: ${path}`);
        return [manifest.name, `file:${path}`];
    }

    copy(source, destination) {
        rmSync(destination, { recursive: true, force: true });
        cpSync(source, destination, { recursive: true, filter: (path) => {
            const relative = path.slice(source.length).split(/[\\/]/).filter(Boolean);
            return !relative.some((part) => ['.git', 'node_modules', '.wrangler', 'build', '.svelte-kit', '.apple-build'].includes(part) || part.startsWith('.env') || part.startsWith('.dev.vars'));
        } });
    }

    overrides(directory, values) {
        const path = join(directory, 'pnpm-workspace.yaml');
        const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
        if (/^overrides:/m.test(current)) throw new Error(`Existing pnpm overrides in ${path}; reconcile them explicitly before this release`);
        writeFileSync(path, `${current}\noverrides:\n${Object.entries(values).map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`).join('\n')}\n`);
    }

    setTenantVersions(path, plan, overrides = {}) {
        const manifest = readJson(join(path, 'package.json'));
        if (Object.keys(plan.devDependencies ?? {}).length) Object.assign(manifest.devDependencies ??= {}, plan.devDependencies);
        const desired = { ...Object.fromEntries(plan.platformNames.map((name) => [name, plan.core])), ...Object.fromEntries(plan.modules.map((item) => [item.name, item.version])), ...overrides };
        for (const section of ['dependencies', 'devDependencies']) {
            for (const name of Object.keys(manifest[section] ?? {})) if (desired[name]) manifest[section][name] = desired[name];
        }
        // Libraries supplied only as module peers (for example locale helpers) must join the same core version.
        for (const item of plan.modules) {
            for (const name of Object.keys(item.manifest.peerDependencies ?? {})) {
                if (plan.platformNames.includes(name)) (manifest.dependencies ??= {})[name] = desired[name];
            }
        }
        writeJson(join(path, 'package.json'), manifest);
    }

    async validateSite(path, plan) {
        this.validateInstalled(path, plan);
        const hearthlog = async (...args) => this.shell('pnpm', ['exec', 'hearthlog', ...args], path);
        await hearthlog('build');
        await hearthlog('lock');
        await this.checkSiteTypes(path);
        if (plan.modules.some((item) => item.contract.publicWorker?.name === 'gallery')) await hearthlog('gallery-public:build', '--site', plan.site);
        await this.shell('pnpm', ['exec', 'vite', 'build'], path);
        await hearthlog('lock', '--check');
        await hearthlog('plan', '--site', plan.site);
        await hearthlog('artifact', 'manifest', '--site', plan.site);
        await hearthlog('artifact', 'verify', '--site', plan.site);
    }

    async checkSiteTypes(path) {
        const result = await this.shell('pnpm', ['--if-present', 'run', 'check'], path, { capture: true, allowFailure: true });
        if (result.stdout) this.log(result.stdout);
        if (result.stderr) this.log(result.stderr);
        if (result.code === 0) return;
        const script = readJson(join(path, 'package.json')).scripts?.check;
        const standard = 'hearthlog build && svelte-kit sync && tsc --noEmit -p tsconfig.json --skipLibCheck';
        const output = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
        const diagnostics = [...output.matchAll(/^(.+)\(\d+,\d+\): error TS(\d+): /gm)];
        // The strict site's unused-local lint also inspects shipped dependency TS sources. Keep it scoped to the site.
        // Real dependency type errors, generated/app unused locals, and nonstandard check failures remain fatal.
        if (result.code === 2 && script === standard && diagnostics.length
            && diagnostics.every((match) => match[2] === '6133' && /(?:^|\/)node_modules\//.test(match[1].replaceAll('\\', '/')))) {
            this.log(`Type check passed with ${diagnostics.length} dependency unused-symbol warnings (TS6133).`);
            return;
        }
        throw new Error(`Site check failed (${result.code}); see the diagnostics above`);
    }

    migrateTenant(path, plan) {
        const files = new Map();
        for (const migration of plan.migrations ?? []) {
            const file = resolve(path, migration.file);
            if (!file.startsWith(`${resolve(path)}${sep}`) || !/^tenants(?:\/[^/]+\/(?:tenant|deployment))?\.json$/.test(migration.file)) {
                throw new Error(`Migrations may edit only tenant JSON configuration inside the checkout: ${migration.file}`);
            }
            const current = files.get(file) ?? readJson(file);
            files.set(file, moveSetting(current, migration.from, migration.to));
        }
        // Resolve all moves before writing, so a conflict leaves every source file unchanged.
        for (const [file, value] of files) writeJson(file, value);
    }

    validateInstalled(path, plan) {
        for (const name of plan.platformNames) {
            const file = join(path, 'node_modules', name, 'package.json');
            if (existsSync(file) && readJson(file).version !== plan.core) throw new Error(`${name} must resolve to core ${plan.core}`);
        }
        for (const item of plan.modules) {
            const manifest = readJson(join(path, 'node_modules', item.name, 'package.json'));
            if (manifest.version !== item.version) throw new Error(`${item.name} must resolve to ${item.version}`);
            for (const section of ['dependencies', 'peerDependencies']) {
                for (const [name, range] of Object.entries(manifest[section] ?? {})) {
                    if (plan.platformNames.includes(name) && !satisfies(plan.core, range)) {
                        throw new Error(`${item.name}: ${name} ${range} does not support core ${plan.core}`);
                    }
                }
            }
        }
    }

    async validateCandidates(plan, paths) {
        const tarballs = join(this.directory, 'tarballs');
        const coreOverrides = Object.fromEntries(plan.platformNames.map((name) => [name, plan.core]));
        if (plan.publishCore) {
            await this.shell('pnpm', ['install', '--frozen-lockfile'], paths.core);
            // Candidate versions exist only in the isolated checkout. The Release workflow owns the real bump/tag.
            for (const item of platformPackages(paths.core)) writeJson(join(item.directory, 'package.json'), { ...item.manifest, version: plan.core });
            for (const args of [['check:scripts'], ['test:scripts'], ['check:packages'], ['-C', 'dev', 'check:ts'], ['-C', 'dev', 'test:unit', '--run'], ['-C', 'dev', 'ledger:test']]) {
                await this.shell('pnpm', args, paths.core);
            }
            for (const item of platformPackages(paths.core)) Object.assign(coreOverrides, Object.fromEntries([await this.pack(item.directory, tarballs)]));
        }
        const moduleOverrides = {};
        for (const item of plan.modules) {
            if (item.changed) {
                writeJson(join(item.directory, 'package.json'), item.manifest);
                writeJson(join(item.directory, 'hearthlog.module.json'), item.contract);
                Object.assign(moduleOverrides, Object.fromEntries([await this.pack(item.directory, tarballs)]));
            }
            if (!plan.publishCore && !item.changed) continue;
            const validation = join(this.directory, 'validation', `module-${item.alias}`);
            this.copy(item.directory, validation);
            this.overrides(validation, coreOverrides);
            await this.shell('pnpm', ['install', '--no-frozen-lockfile', '--strict-peer-dependencies=false'], validation);
            const overridesFile = join(this.directory, `overrides-${item.alias}.json`);
            writeJson(overridesFile, coreOverrides);
            await this.shell('pnpm', ['exec', 'hearthlog', 'check-module', '.', '--overrides', overridesFile], validation);
        }
        const site = join(this.directory, 'validation', 'tenant');
        this.copy(paths.tenant, site);
        this.migrateTenant(site, plan);
        this.setTenantVersions(site, plan, moduleOverrides);
        this.overrides(site, { ...coreOverrides, ...moduleOverrides });
        await this.shell('pnpm', ['install', '--no-frozen-lockfile', '--strict-peer-dependencies=false'], site);
        await this.validateSite(site, plan);
    }

    async waitPackages(packages) {
        const deadline = this.now() + 10 * 60_000;
        for (const item of packages) {
            while (true) {
                const registry = item.registry ?? 'https://registry.npmjs.org';
                const result = await this.shell('pnpm', ['view', `${item.name}@${item.version}`, 'version', '--json', '--registry', registry], this.directory, { capture: true, allowFailure: true });
                if (result.code === 0 && JSON.parse(result.stdout) === item.version) break;
                const failure = result.stdout + result.stderr;
                if (result.code !== 0 && (/\b(?:401|403)\b|E401|E403|FETCH_401|FETCH_403|unauthorized|forbidden|authentication/i.test(failure)
                    || !/E404|ERR_PNPM_FETCH_404|No match found|No matching version|not found/i.test(failure))) {
                    throw new Error(`Registry check failed for ${item.name}@${item.version}: ${result.stderr || result.stdout}`);
                }
                if (this.now() > deadline) throw new Error(`Package not available: ${item.name}@${item.version}. Resume after publication succeeds.`);
                this.log(`Waiting for ${item.name}@${item.version} in ${registry}`);
                await this.sleep(15_000);
            }
        }
    }

    async requirePublished(plan) {
        await this.waitPackages([
            ...plan.platformNames.map((name) => ({ name, version: plan.core })),
            ...plan.modules.map((item) => ({ name: item.name, version: item.version, registry: item.manifest.publishConfig?.registry })),
        ]);
    }

    async findRun(key, repo, selector) {
        const existing = this.state.actions[key]?.run;
        if (existing) return existing;
        const deadline = this.now() + 5 * 60_000;
        while (true) {
            const runs = await this.gh(['run', 'list', '--repo', repo, '--workflow', selector.workflow, '--event', selector.event,
                ...(selector.sha ? ['--commit', selector.sha] : []), '--limit', '100', '--json', 'databaseId,headSha,headBranch,displayTitle,url,createdAt']);
            const matches = runs.filter((run) => (!selector.sha || run.headSha === selector.sha) && (!selector.title || run.displayTitle === selector.title)
                && (!selector.tag || run.headBranch === selector.tag));
            if (matches.length > 1) throw new Error(`Ambiguous workflow runs for ${key}; inspect ${repo} Actions before resuming`);
            if (matches.length === 1) {
                this.state.actions[key] = { ...this.state.actions[key], run: matches[0] };
                this.save();
                return matches[0];
            }
            if (this.now() > deadline) throw new Error(`No workflow run found for ${key}; inspect Actions. This command will not blindly redispatch.`);
            await this.sleep(10_000);
        }
    }

    async waitRun(key, repo, run) {
        // Recheck GitHub on every resume, including previously successful runs.
        const deadline = this.now() + 2 * 60 * 60_000;
        let previous;
        let retried = false;
        while (true) {
            const current = await this.gh(['run', 'view', String(run.databaseId), '--repo', repo, '--json', 'status,conclusion,url']);
            if (current.status === 'completed') {
                if (current.conclusion === 'success') return;
                if (this.options.retryFailed && !retried) {
                    await this.shell('gh', ['run', 'rerun', String(run.databaseId), '--repo', repo, '--failed'], this.directory);
                    retried = true;
                    await this.sleep(10_000);
                    continue;
                }
                throw new Error(`${key}: ${current.conclusion}. ${current.url}\nFix/rerun the failed job in Actions, or explicitly resume with --retry-failed.`);
            }
            if (current.status !== previous) this.log(`${key}: ${current.status} ${current.url} (approve protected environments in GitHub when requested)`);
            previous = current.status;
            if (this.now() > deadline) throw new Pending(`Still waiting for ${current.url}. Run the same command to resume.`);
            await this.sleep(15_000);
        }
    }

    async publishCore(plan, path) {
        const key = 'core:publish';
        const repo = this.config.core.repo;
        const tag = `v${plan.core}`;
        if (!this.state.actions[key]) {
            const existing = await this.shell('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], path, { capture: true });
            if (existing.stdout) throw new Error(`${tag} already exists. To adopt a published core, use release tenant --core, rather than publishing it again.`);
            // Persist intent BEFORE dispatch; an uncertain network response must never create a second release.
            this.state.actions[key] = { intent: true };
            this.save();
            await this.shell('gh', ['workflow', 'run', 'release.yml', '--repo', repo, '--ref', this.config.core.branch ?? 'main',
                '-f', `version=${plan.core}`, '-f', `release_id=${this.id}`, '-f', `expected_sha=${this.state.repositories.core.sha}`], path);
        }
        const run = await this.findRun(key, repo, { workflow: 'release.yml', event: 'workflow_dispatch', title: `Release v${plan.core} (${this.id})` });
        await this.waitRun(key, repo, run);
        await this.waitPackages(plan.platformNames.map((name) => ({ name, version: plan.core })));
    }

    async commit(path, title, files) {
        const changed = await this.shell('git', ['diff', '--quiet', '--', ...files], path, { capture: true, allowFailure: true });
        if (changed.code !== 0 && changed.code !== 1) throw new Error('Cannot inspect release diff');
        const untracked = await this.output('git', ['ls-files', '--others', '--exclude-standard', '--', ...files], path);
        if (changed.code === 0 && !untracked) {
            if (await this.output('git', ['log', '-1', '--format=%s'], path) !== title) return null;
            return { sha: await this.output('git', ['rev-parse', 'HEAD'], path), title };
        }
        await this.shell('git', ['checkout', '-B', this.branch], path);
        await this.shell('git', ['add', '--', ...files], path);
        await this.shell('git', ['diff', '--cached', '--check'], path);
        await this.shell('git', ['commit', '-m', title], path);
        return { sha: await this.output('git', ['rev-parse', 'HEAD'], path), title };
    }

    async pullRequest(key, entry, path, commit) {
        const branch = this.branch;
        await this.step(`${key}:push`, () => this.shell('git', ['push', 'origin', `${commit.sha}:refs/heads/${branch}`], path));
        const pr = await this.step(`${key}:pr`, async () => {
            const existing = await this.gh(['pr', 'list', '--repo', entry.repo, '--state', 'all', '--head', branch, '--json', 'number,url']);
            if (existing.length > 1) throw new Error(`Multiple release PRs in ${entry.repo}`);
            if (existing.length) return existing[0];
            const body = join(this.directory, `${key}-pr.md`);
            writeFileSync(body, `${commit.title}\n\nUpdates the selected dependencies and release contracts together.\n\nValidation: candidate module builds/unit tests and the composed tenant checks, production build, deployment plan, and artifact verification passed locally.\n\nCoordinator: ${this.id}. Source commit: ${commit.sha}.\n`);
            const url = await this.output('gh', ['pr', 'create', '--repo', entry.repo, '--base', entry.branch ?? 'main', '--head', branch,
                '--title', commit.title, '--body-file', body], path);
            return { url };
        });
        let current = await this.gh(['pr', 'view', pr.url, '--repo', entry.repo, '--json', 'state,headRefOid,mergeCommit,url']);
        if (current.headRefOid !== commit.sha) throw new Error(`Release PR changed since validation: ${pr.url}. Start a new release after reviewing it.`);
        if (current.state === 'CLOSED') throw new Error(`Release PR was closed: ${pr.url}`);
        if (current.state !== 'MERGED' && this.options.merge) {
            // Checks must exist and pass; --match-head-commit prevents a concurrent edit from being merged.
            await this.waitChecks(pr.url, entry.repo, path);
            await this.shell('gh', ['pr', 'merge', pr.url, '--repo', entry.repo, '--squash', '--match-head-commit', commit.sha], path);
            current = await this.gh(['pr', 'view', pr.url, '--repo', entry.repo, '--json', 'state,headRefOid,mergeCommit,url']);
        }
        if (current.state !== 'MERGED') throw new Pending(`Merge ${pr.url}, then rerun the same command to continue. Use --merge to merge after checks pass.`);
        const sha = current.mergeCommit?.oid;
        if (!sha) throw new Pending(`Waiting for the merge commit of ${pr.url}; resume shortly.`);
        await this.shell('git', ['fetch', 'origin', sha], path);
        const diff = await this.shell('git', ['diff', '--quiet', commit.sha, sha], path, { capture: true, allowFailure: true });
        if (diff.code !== 0) throw new Error(`The merged tree differs from the validated release in ${pr.url}. Review/revalidate before publishing.`);
        return { sha, url: pr.url };
    }

    async waitChecks(url, repo, path) {
        const deadline = this.now() + 2 * 60 * 60_000;
        while (true) {
            const result = await this.shell('gh', ['pr', 'checks', url, '--repo', repo, '--json', 'bucket,name,link'], path, { capture: true, allowFailure: true });
            if (![0, 1, 8].includes(result.code) || (result.code === 1 && !result.stdout && !/no checks reported/i.test(result.stderr))) {
                throw new Error(`Cannot read PR checks: ${result.stderr || result.stdout}`);
            }
            const checks = result.stdout ? JSON.parse(result.stdout) : [];
            const failed = checks.filter((check) => ['fail', 'cancel'].includes(check.bucket));
            if (failed.length) throw new Error(`PR checks failed: ${failed.map((check) => `${check.name} ${check.link}`).join(', ')}`);
            if (checks.length && checks.every((check) => ['pass', 'skipping'].includes(check.bucket)) && checks.some((check) => check.bucket === 'pass')) return;
            if (this.now() > deadline) throw new Pending(`Waiting for passing checks on ${url}; rerun to resume.`);
            this.log(`Waiting for PR checks: ${url}`);
            await this.sleep(15_000);
        }
    }

    async publishModule(item, plan) {
        const path = item.directory;
        const commit = await this.step(`module-${item.alias}:prepare`, async () => {
            writeJson(join(path, 'package.json'), item.manifest);
            writeJson(join(path, 'hearthlog.module.json'), item.contract);
            await this.shell('pnpm', ['install', '--no-frozen-lockfile'], path);
            const files = ['package.json', 'hearthlog.module.json', ...(existsSync(join(path, 'pnpm-lock.yaml')) ? ['pnpm-lock.yaml'] : [])];
            const result = await this.commit(path, `chore(release): release ${item.alias} ${item.version}`, files);
            if (!result) return { sha: this.state.repositories[`module-${item.alias}`].sha, title: `Release ${item.alias} ${item.version}`, existing: !item.sourceRef };
            return result;
        });
        const merged = commit.existing ? commit : await this.pullRequest(`module-${item.alias}`, item, path, commit);
        const tag = `v${item.version}`;
        await this.step(`module-${item.alias}:tag`, async () => {
            const remote = await this.output('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], path);
            if (remote) {
                const lines = remote.split('\n');
                const peeled = lines.find((line) => line.endsWith('^{}')) ?? lines[0];
                if (peeled.split(/\s+/)[0] !== merged.sha) throw new Error(`${item.repo}: ${tag} already points to a different commit`);
                return;
            }
            // The push is repeatable after interruption: check the remote tag before ever writing it.
            const local = await this.shell('git', ['rev-parse', '--verify', `refs/tags/${tag}`], path, { capture: true, allowFailure: true });
            if (local.code !== 0) await this.shell('git', ['tag', '-a', tag, merged.sha, '-m', tag], path);
            const tagged = await this.output('git', ['rev-parse', `${tag}^{}`], path);
            if (tagged !== merged.sha) throw new Error(`Local ${tag} points to an unexpected commit`);
            await this.shell('git', ['push', 'origin', `refs/tags/${tag}`], path);
        });
        const run = await this.findRun(`module-${item.alias}:publish`, item.repo, { workflow: 'release.yml', event: 'push', sha: merged.sha, tag });
        await this.waitRun(`module-${item.alias}:publish`, item.repo, run);
        await this.waitPackages([{ name: item.name, version: item.version, registry: item.manifest.publishConfig?.registry }]);
    }

    async prepareTenant(plan, path) {
        this.migrateTenant(path, plan);
        this.setTenantVersions(path, plan);
        await this.shell('pnpm', ['install', '--no-frozen-lockfile', '--strict-peer-dependencies=false'], path);
        await this.validateSite(path, plan);
        return this.commit(path, `chore(release): update ${plan.tenant} dependencies`, [...new Set(['package.json', 'pnpm-lock.yaml', `tenants/${plan.site}/modules.lock.json`, ...(plan.migrations ?? []).map((migration) => migration.file)])]);
    }
}
