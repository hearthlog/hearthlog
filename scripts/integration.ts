/**
 * `pnpm test:integration`
 *
 * Runs the checks that need modules, against the published ones, without making them part of this repository: neither the
 * root `package.json` nor the lockfile names a module, and this script never writes either. For the run it installs
 * `@hearthlog/module-*` from npm into a throwaway project outside the repository, links them in, swaps the development site
 * (`dev/`) for the one in `tests/integration/st.tenant.json` (every module's features), locks the modules, generates the site, and runs
 *
 *   - the unit tests, including the ones that need modules (route access, entity scope, module projections, sync invalidation),
 *   - the tooling tests and their type check, including the ones that need modules (composition, init, the module lock, integrations),
 *   - the type check and the frontend Worker's `Env` declaration check (it holds the bindings of every module),
 *   - the Ledger's type check and tests (its event contracts come from the modules),
 *
 * (or, with arguments, only that script: `pnpm test:integration test:unit --run <file>`), then removes the links and puts the
 * site and the generated files back, whatever happened.
 *
 * The throwaway project overrides every package this repository already installs with a link to the repository's own copy
 * (the platform packages to `packages/*`), so the modules run against the code under test and share its Svelte and the rest;
 * only what the modules need beyond that is downloaded. Each module is then linked into `dev/modules/<name>`, where the
 * composer finds the modules of a checkout, into `dev/node_modules/@hearthlog/`, where the generated files import it by
 * name, and into the tooling tests' fixture host (`tests/fixture-host/modules/`).
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const site = join(root, 'dev');
const fixtureHost = join(root, 'tests', 'fixture-host');
const MODULES = ['calc', 'finance', 'gallery', 'health', 'invoices'];
const TOUCHED = ['dev/tenants/st/tenant.json', 'dev/tenants/st/modules.lock.json'];
// Each runs in the development site, or (`-w`) at the repository root.
const COMMANDS: string[][] = [
    ['test:unit', '--run'],
    ['-w', 'test:scripts'],
    ['-w', 'check:scripts'],
    ['check:ts'],
    ['frontend:worker:check'],
    ['ledger:check'],
    ['ledger:test'],
];

function run(cwd: string, args: string[]): void {
    const result = spawnSync('pnpm', args, { cwd, stdio: 'inherit', env: { ...process.env, HEARTHLOG_INTEGRATION: '1' } });
    if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} (in ${cwd}) failed`);
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

/** `link:` overrides for every package the development site installs, and the platform's own packages. */
function sharedPackages(): Record<string, string> {
    const links: Record<string, string> = {};
    const manifest = readJson(join(site, 'package.json'));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
        const installed = join(site, 'node_modules', name);
        if (existsSync(installed)) links[name] = `link:${realpathSync(installed)}`;
    }
    for (const folder of readdirSync(join(root, 'packages'))) {
        const path = join(root, 'packages', folder, 'package.json');
        if (existsSync(path)) links[readJson(path).name as string] = `link:${join(root, 'packages', folder)}`;
    }
    return links;
}

const scratch = mkdtempSync(join(tmpdir(), 'hearthlog-integration-'));
const saved = join(scratch, 'saved');
const project = join(scratch, 'project');
mkdirSync(saved);
mkdirSync(project);
for (const file of TOUCHED) {
    if (existsSync(join(root, file))) copyFileSync(join(root, file), join(saved, file.replaceAll('/', '__')));
}

const modulesDirectories = [join(site, 'modules'), join(fixtureHost, 'modules')];
const createdDirectories = modulesDirectories.filter((directory) => !existsSync(directory));
const linkPaths = (name: string) => [...modulesDirectories.map((directory) => join(directory, name)), join(site, 'node_modules/@hearthlog', `module-${name}`)];
const links: string[] = [];
let failed = false;
try {
    // The links must not replace a module checkout or an installed module.
    for (const name of MODULES) {
        for (const path of linkPaths(name)) {
            if (existsSync(path)) throw new Error(`${path} already exists; remove it before running the integration checks`);
        }
    }

    const shared = sharedPackages();
    writeFileSync(join(project, 'package.json'), `${JSON.stringify({
        name: 'hearthlog-integration',
        private: true,
        packageManager: readJson(join(root, 'package.json')).packageManager,
        // The shared packages are dependencies too, so the modules' peers (the platform, Svelte) resolve to them.
        dependencies: { ...shared, ...Object.fromEntries(MODULES.map((name) => [`@hearthlog/module-${name}`, '^1.0.0'])) },
    }, null, 2)}\n`);
    writeFileSync(join(project, 'pnpm-workspace.yaml'), `overrides:\n${Object.entries(shared).map(([name, link]) => `  ${JSON.stringify(name)}: ${JSON.stringify(link)}`).join('\n')}\n`);
    run(project, ['install', '--ignore-scripts']);

    for (const directory of modulesDirectories) mkdirSync(directory, { recursive: true });
    for (const name of MODULES) {
        const installed = realpathSync(join(project, 'node_modules/@hearthlog', `module-${name}`));
        // pnpm keeps a package's dependencies beside it, not inside it. TypeScript resolves the files it reads through
        // modules/<name> from that path, so the throwaway copy gets a node_modules of its own that points at them.
        const manifest = readJson(join(installed, 'package.json'));
        for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
            // `installed` is <store>/node_modules/@hearthlog/module-<name>; its dependencies are in <store>/node_modules.
            const target = join(installed, '../..', dependency);
            const link = join(installed, 'node_modules', dependency);
            if (!existsSync(target)) continue;
            mkdirSync(resolve(link, '..'), { recursive: true });
            symlinkSync(realpathSync(target), link, 'dir');
        }
        for (const path of linkPaths(name)) {
            symlinkSync(installed, path, 'dir');
            links.push(path);
        }
    }

    copyFileSync(join(root, 'tests', 'integration', 'st.tenant.json'), join(site, 'tenants/st/tenant.json'));
    run(site, ['lock:modules']);
    run(site, ['build:generated']);
    // `pnpm test:integration <script> [args]` runs only that script (of the development site) in the integration state.
    const only = process.argv.slice(2).filter((argument) => argument !== '--');
    for (const command of only.length > 0 ? [only] : COMMANDS) {
        if (command[0] === '-w') run(root, command.slice(1));
        else run(site, command);
    }
} catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.message : String(error));
} finally {
    for (const path of links) if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(path);
    for (const directory of createdDirectories) {
        if (existsSync(directory) && readdirSync(directory).length === 0) rmSync(directory, { recursive: true });
    }
    for (const file of TOUCHED) {
        const copy = join(saved, file.replaceAll('/', '__'));
        if (existsSync(copy)) copyFileSync(copy, join(root, file));
    }
    rmSync(scratch, { recursive: true, force: true });
    spawnSync('pnpm', ['build:generated'], { cwd: site, stdio: 'inherit' });
}
if (failed) process.exit(1);
console.log('\nThe checks that need modules pass against the published ones.');
