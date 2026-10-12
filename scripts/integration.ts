/**
 * `pnpm test:integration`
 *
 * Runs the checks that need modules, against the published ones, without making them part of this repository: the root `package.json`
 * and the `st` site install none. For the run it installs `@hearthlog/module-*` from npm, swaps the development site for the one in
 * `integration/st.tenant.json` (every module's features), locks the modules, generates the site, and runs
 *
 *   - the unit tests, including the ones that need modules (route access, entity scope, module projections, sync invalidation),
 *   - the type check and the frontend Worker's `Env` declaration check (it holds the bindings of every module),
 *   - the Ledger's type check and tests (its event contracts come from the modules),
 *
 * (or, with arguments, only that script: `pnpm test:integration test:unit --run <file>`), then puts `package.json`, the lockfile, the site, and the generated files back, whatever happened.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const MODULES = ['calc', 'finance', 'gallery', 'health', 'invoices'];
const TOUCHED = ['package.json', 'pnpm-lock.yaml', 'tenants/st/tenant.json', 'tenants/st/modules.lock.json'];
const COMMANDS: string[][] = [
    ['test:unit', '--run'],
    ['check:ts'],
    ['frontend:worker:check'],
    ['ledger:check'],
    ['ledger:test'],
];

function pnpm(args: string[]): void {
    const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit', env: { ...process.env, HEARTHLOG_INTEGRATION: '1' } });
    if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed`);
}

const saved = mkdtempSync(join(tmpdir(), 'hearthlog-integration-'));
const copy = (from: string, to: string) => {
    if (existsSync(from)) copyFileSync(from, to);
};
for (const file of TOUCHED) {
    copy(join(root, file), join(saved, file.replaceAll('/', '__')));
}
let failed = false;
try {
    pnpm(['add', '--workspace-root', '--save-dev', '--ignore-scripts', ...MODULES.map((name) => `@hearthlog/module-${name}@^1.0.0`)]);
    copyFileSync(join(root, 'integration', 'st.tenant.json'), join(root, 'tenants/st/tenant.json'));
    pnpm(['lock:modules']);
    pnpm(['build:generated']);
    // `pnpm test:integration <script> [args]` runs only that script in the integration state.
    const only = process.argv.slice(2).filter((argument) => argument !== '--');
    for (const command of only.length > 0 ? [only] : COMMANDS) pnpm(command);
} catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.message : String(error));
} finally {
    for (const file of TOUCHED) copy(join(saved, file.replaceAll('/', '__')), join(root, file));
    rmSync(saved, { recursive: true, force: true });
    spawnSync('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
    spawnSync('pnpm', ['build:generated'], { cwd: root, stdio: 'inherit' });
}
if (failed) process.exit(1);
console.log('\nThe checks that need modules pass against the published ones.');
