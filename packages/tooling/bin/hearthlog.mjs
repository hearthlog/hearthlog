#!/usr/bin/env node
// The `hearthlog` command: runs the TypeScript tools through tsx. `build`, `init`, `export`, `check-module`, `artifact`, and
// `gallery-public:build` start before a site has generated files (or write their own), so they run alone; the
// `apple:*` commands run the build and then the tools of `@hearthlog/native` (a dependency of the site, not of this
// package); `ensure`, `deploy`, `deploy-ledger`, and `split` run the build and then a deploy tool; every other
// command goes to the CLI.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');
const source = (path) => fileURLToPath(new URL(`../src/${path}`, import.meta.url));
const run = (args) => spawnSync(process.execPath, [tsx, ...args], { stdio: 'inherit' }).status ?? 1;

const [command, ...rest] = process.argv.slice(2);

// The native shell: the tool is a file of @hearthlog/native, found from the site, and every one of them reads the
// site's generated files, so the build runs first (it does nothing when they are current).
const native = { 'apple:mac': 'mac.js', 'apple:ios': 'ios.js', 'apple:resign': 'resign.js', 'apple:test': 'swift-checks.js' }[command];
if (native) {
    let tool;
    try {
        tool = createRequire(join(process.cwd(), 'package.json')).resolve(`@hearthlog/native/${native}`);
    } catch {
        console.error(`${command} needs @hearthlog/native: add it to this site's dependencies.`);
        process.exit(1);
    }
    const built = run([source('generate/build-generated.ts'), '--quiet']);
    process.exit(built === 0 ? run([tool, ...rest]) : built);
}

// The deploy tools read the site's generated files, so each starts with the build (which does nothing when they are
// current). They work from a tenant repository because they run from this package, not from the host's scripts.
const deployTools = { ensure: 'deploy/ensure-tenant.ts', deploy: 'deploy/deploy-tenant.ts', 'deploy-ledger': 'deploy/deploy-ledger.ts', split: 'deploy/split-tenant.ts' };
if (deployTools[command]) {
    const site = rest[rest.indexOf('--site') + 1];
    const env = { ...process.env, ...(rest.includes('--site') && site ? { VITE_STOR_TENANT: site } : {}) };
    const built = spawnSync(process.execPath, [tsx, source('generate/build-generated.ts'), '--quiet'], { stdio: 'inherit', env }).status ?? 1;
    process.exit(built === 0 ? (spawnSync(process.execPath, [tsx, source(deployTools[command]), ...rest], { stdio: 'inherit', env }).status ?? 1) : built);
}

// The plan reads the site's generated files too: build them first (a no-op when they are current). `apply` does not,
// because `apply --skip-build` deploys the release already in place and must not rewrite it.
if (command === 'plan') {
    const site = rest[rest.indexOf('--site') + 1];
    const env = { ...process.env, ...(rest.includes('--site') && site ? { VITE_STOR_TENANT: site } : {}) };
    const built = spawnSync(process.execPath, [tsx, source('generate/build-generated.ts'), '--quiet'], { stdio: 'inherit', env }).status ?? 1;
    if (built !== 0) process.exit(built);
}

const entry = {
    build: 'generate/build-generated.ts',
    init: 'init/init.ts',
    export: 'init/export-tenant.ts',
    'check-module': 'init/check-module.ts',
    'gallery-public:build': 'public-workers/build-gallery-public.ts',
    artifact: 'deploy/artifact.ts',
}[command];
process.exit(run(entry ? [source(entry), ...rest] : [source('cli/hearthlog.ts'), ...(command === undefined ? [] : [command]), ...rest]));
