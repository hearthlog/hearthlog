#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, Coordinator, Pending } from './coordinator.mjs';
import { digest, makePlan, parseArgs, printPlan, readJson } from './model.mjs';

const HELP = `Usage: release core <version> --tenant <id> [--module name@version ...]
       release module <name> <version> --tenant <id> [--core <version>]
       release tenant <id> [--core <version>] [--module name@version ...]

Preview only by default; no network requests or changes.
  --execute       Validate, publish through Actions, and open downstream PRs
  --merge         Merge passing PRs and continue to tenant deployment
  --retry-failed  Explicitly rerun failed Actions jobs when resuming
  --config FILE   Workspace inventory (required)

Repeat the same command to resume. GitHub environment approvals still apply.
Only committed remote branch contents are released; local edits are preserved.
`;

export async function main(argv) {
    if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return; }
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('The release coordinator requires Node.js 24 or newer');
    const options = parseArgs(argv);
    if (!options.config) throw new Error('--config is required');
    const configPath = resolve(options.config);
    const root = dirname(configPath);
    const config = readJson(configPath);
    if (!config.core?.repo || !config.modules || !config.tenants?.[options.tenant]) throw new Error('Configure core, modules, and the selected tenant');
    for (const [key, item] of Object.entries({ core: config.core, ...config.modules, ...config.tenants })) {
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repo ?? '') || !item.path) throw new Error(`Invalid repository configuration: ${key}`);
    }
    const request = { config, kind: options.kind, tenant: options.tenant, core: options.core, modules: Object.fromEntries(Object.entries(options.modules).sort()) };
    const directory = join(root, '.releases', digest(request));
    console.log(`Release state: ${directory}`);
    if (!options.execute) {
        const paths = { core: resolve(root, config.core.path), tenant: resolve(root, config.tenants[options.tenant].path),
            modules: Object.fromEntries(Object.entries(config.modules).map(([name, entry]) => [name, resolve(root, entry.path)])) };
        printPlan(makePlan(config, options, paths));
        if (existsSync(join(directory, 'state.json'))) console.log('Saved run exists; --execute resumes its original remote snapshots.');
        console.log('Preview uses local manifests. Execution replans from isolated remote branch snapshots. Add --execute to proceed.');
        return;
    }
    const unlock = acquireLock(join(root, '.releases', 'active.lock'));
    try { await new Coordinator(config, options, directory).execute(); }
    finally { unlock(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { await main(process.argv.slice(2)); }
    catch (error) {
        console.error(error.message);
        process.exitCode = error instanceof Pending ? 2 : 1;
    }
}
