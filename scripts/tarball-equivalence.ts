/**
 * `pnpm check:tarballs [site...] [--work <dir>] [--keep]`
 *
 * Prove that the packages work when installed, not only when linked: `pnpm pack` every package and module,
 * assemble each site outside the workspace from those tarballs (pnpm overrides point every `@hearthlog/*` at
 * its tarball; a first install writes the lockfile, a second runs `--frozen-lockfile` from nothing), build it,
 * and compare what it ships with the same site built in this workspace.
 *
 * A site is a tenant id of this repository (`solo`: its `tenants.json`, `tenants/<id>/`, and icons are laid over a
 * fresh `hearthlog init`, or exported when it has its own stack) or `examples/empty` (a fresh `init`, no workspace
 * build to compare with; it must ship no module code, and it builds without `VITE_STOR_TENANT`, as a new site does).
 * The default is `examples/empty solo`.
 *
 * Compared, structurally: the route set, the chunk names without their content hashes, the precache list, the
 * gateway table (`server-modules.ts`), and the Ledger event contracts (`event-schemas.generated.ts`). Hashes and
 * sizes are printed as a difference list and do not fail the run.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIN, REPOSITORY, packEverything, run, step, useTarballs } from './tarball-support.js';
import { compareFingerprints, fingerprint, type Fingerprint } from '../packages/tooling/src/deploy/artifact-compare.js';

const EXAMPLES: Record<string, { id: string; modules: string[] }> = {
    'examples/empty': { id: 'empty', modules: [] },
};

function walk(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
    });
}

// ── assembling a site from tarballs ────────────────────────────────────────

function assemble(directory: string, id: string, modules: string[], packed: Map<string, string>, overlayTenant: boolean): void {
    rmSync(directory, { recursive: true, force: true });
    run('node', [BIN, 'init', directory, '--id', id, '--modules', modules.length > 0 ? modules.join(',') : 'none'], { cwd: REPOSITORY });
    if (overlayTenant) {
        // The tenant's own repository: a site on its own stack is exported (`hearthlog export`), as it will be pushed.
        if (existsSync(join(REPOSITORY, 'tenants', id, 'deployment.json'))) {
            rmSync(directory, { recursive: true, force: true });
            run('node', [BIN, 'export', id, '--out', directory], { cwd: REPOSITORY });
        } else {
            // A site on the shared stack takes the shared block, without the sweeper: the other sites it names are not here.
            rmSync(join(directory, 'tenants'), { recursive: true, force: true });
            cpSync(join(REPOSITORY, 'tenants', id), join(directory, 'tenants', id), { recursive: true });
            const shared = JSON.parse(readFileSync(join(REPOSITORY, 'tenants.json'), 'utf8')) as { infrastructure: Record<string, unknown> };
            delete shared.infrastructure.gallerySweeper;
            writeFileSync(join(directory, 'tenants.json'), `${JSON.stringify(shared, null, 2)}\n`);
        }
    }
    useTarballs(directory, packed);
}

function installTwice(directory: string): void {
    run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: directory });
    rmSync(join(directory, 'node_modules'), { recursive: true, force: true });
    run('pnpm', ['install', '--frozen-lockfile'], { cwd: directory });
}

// ── the sites ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const flag = (name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
    const sites = argv.filter((argument, index) => !argument.startsWith('--') && argv[index - 1] !== '--work');
    const targets = sites.length > 0 ? sites : ['examples/empty', 'solo'];
    const work = resolve(flag('--work') ?? join(tmpdir(), `hearthlog-tarballs-${process.pid}`));
    mkdirSync(work, { recursive: true });
    console.log(`Working in ${work}`);

    step('pack');
    const packed = packEverything(work);

    const problems: string[] = [];
    for (const target of targets) {
        const example = EXAMPLES[target];
        const id = example?.id ?? target;
        const directory = join(work, 'sites', id);

        let baseline: Fingerprint | undefined;
        if (!example) {
            step(`${id}: build in the workspace`);
            const env = { VITE_STOR_TENANT: id, STOR_SVELTEKIT_OUT_DIR: '.svelte-kit-tarballs' };
            run('node', [BIN, 'build', '--quiet'], { cwd: REPOSITORY, env });
            run('pnpm', ['exec', 'vite', 'build'], { cwd: REPOSITORY, env });
            baseline = await fingerprint(REPOSITORY, id, join(REPOSITORY, '.svelte-kit-tarballs'));
            rmSync(join(REPOSITORY, '.svelte-kit-tarballs'), { recursive: true, force: true });
            run('node', [BIN, 'build', '--quiet'], { cwd: REPOSITORY });
        }

        step(`${id}: assemble and install from tarballs`);
        const modules = example
            ? example.modules
            : (JSON.parse(readFileSync(join(REPOSITORY, 'tenants', id, 'modules.lock.json'), 'utf8')) as { modules: { package: string }[] }).modules.map((entry) => entry.package);
        assemble(directory, id, modules, packed, !example);
        installTwice(directory);

        step(`${id}: build from tarballs`);
        // A new site builds its only site without being told which (an empty value counts as unset).
        const siteEnv = { VITE_STOR_TENANT: example ? '' : id };
        run('pnpm', ['exec', 'hearthlog', 'build'], { cwd: directory, env: siteEnv });
        run('pnpm', ['exec', 'vite', 'build'], { cwd: directory, env: siteEnv });
        const installed = await fingerprint(directory, id);
        console.log(`${id}: ${installed.routes.length} routes, ${installed.chunks.length} chunks, ${installed.precache.length} precache entries`);

        if (baseline) {
            const compared = compareFingerprints(id, baseline, installed, ['workspace', 'tarball']);
            console.log(`${id}: ${compared.identical} of ${baseline.contents.length} files under _app are byte-identical (informational)`);
            problems.push(...compared.problems);
        }

        // The exported repository must plan what this repository plans: the same resources, steps, and problems.
        if (!example && existsSync(join(REPOSITORY, 'tenants', id, 'deployment.json'))) {
            step(`${id}: plan from the exported repository`);
            const planned = (cwd: string, command: string, prefix: string[]) => JSON.parse(run(command, [...prefix, 'plan', '--site', id, '--json'], { cwd }));
            const here = planned(REPOSITORY, 'node', [BIN]);
            const there = planned(directory, join(directory, 'node_modules/.bin/hearthlog'), []);
            if (JSON.stringify(here) !== JSON.stringify(there)) problems.push(`${id}: the plan from the exported repository differs from the plan here`);
        }

        // A site on its own stack also deploys its Ledger and its public Workers: build the Gallery one and bundle all three.
        if (!example && existsSync(join(REPOSITORY, 'tenants', id, 'deployment.json'))) {
            step(`${id}: bundle the Ledger and the public Workers of its stack`);
            const workers = ['ledger', 'calendar-public'];
            if (modules.includes('@hearthlog/module-gallery')) {
                run('pnpm', ['exec', 'hearthlog', 'gallery-public:build', '--site', id], { cwd: directory });
                workers.push('gallery-public');
            }
            // The deploy job: a fresh checkout that installs the same lockfile with scripts disabled, takes the sealed
            // release, and deploys it. Nothing in it builds.
            step(`${id}: deploy the sealed release (dry run)`);
            run('node', [BIN, 'artifact', 'manifest', '--site', id], { cwd: directory });
            const deployment = join(work, 'deploy', id);
            rmSync(deployment, { recursive: true, force: true });
            cpSync(directory, deployment, { recursive: true, filter: (source) => !/\/(node_modules|build|\.generated|\.svelte-kit)$|artifact-manifest\.json$/.test(source) || source.endsWith('/.generated/package.json') });
            mkdirSync(join(deployment, '.generated'), { recursive: true });
            cpSync(join(directory, '.generated'), join(deployment, '.generated'), { recursive: true });
            cpSync(join(directory, 'build'), join(deployment, 'build'), { recursive: true });
            cpSync(join(directory, 'artifact-manifest.json'), join(deployment, 'artifact-manifest.json'));
            run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: deployment, quiet: true });
            run(join(deployment, 'node_modules/.bin/hearthlog'), ['artifact', 'verify', '--site', id], { cwd: deployment });
            run(join(deployment, 'node_modules/.bin/hearthlog'), ['deploy', '--site', id, '--skip-build', '--dry-run'], { cwd: deployment, env: { CI: 'true' }, quiet: true });
            for (const worker of workers) {
                // The binary directly: `pnpm exec` breaks the --env-file path.
                run(join(directory, 'node_modules/.bin/wrangler'), ['deploy', '--config', `.generated/sites/${id}/${worker}/wrangler.jsonc`, '--dry-run', '--env-file', '/dev/null'], { cwd: directory, quiet: true });
            }
        }

        // Isolation: a site may ship only the code of the modules in its lock.
        const present = new Set(modules.map((name) => name.replace('@hearthlog/module-', '')));
        for (const other of ['calc', 'finance', 'gallery', 'health', 'invoices'].filter((name) => !present.has(name))) {
            const hits = walk(join(directory, 'build')).filter((path) => /\.(js|css|html)$/.test(path)).filter((path) => readFileSync(path, 'utf8').includes(`org.stor.${other}`));
            if (hits.length > 0) problems.push(`${id}: the module "${other}" is not in the lock but its id appears in ${hits.length} output file(s)`);
        }
    }

    if (!argv.includes('--keep')) rmSync(join(work, 'sites'), { recursive: true, force: true });
    if (problems.length > 0) {
        console.error(`\n${problems.length} problem(s):\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
        process.exitCode = 1;
    } else {
        console.log('\nThe tarball builds match.');
    }
}

await main();
