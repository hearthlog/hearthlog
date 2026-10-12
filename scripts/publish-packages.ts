/**
 * `pnpm publish:packages [--dry-run]`
 *
 * Publishes every package of `packages/` whose version is not on the registry yet: `pnpm pack` (which writes the
 * `workspace:*` ranges as versions), then `npm publish` of the tarball with provenance. `npm publish` is used for the upload
 * because its login is what npm's trusted publishing (OIDC from a GitHub Actions job, no stored token) attaches to.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publishedPackages } from './release-version.js';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const dryRun = process.argv.includes('--dry-run');
const out = mkdtempSync(join(tmpdir(), 'hearthlog-publish-'));
let failed = false;
try {
    for (const file of publishedPackages(root)) {
        const { name, version } = file.manifest;
        const directory = dirname(file.path);
        const known = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' });
        if (known.status === 0 && known.stdout.trim() === version) {
            console.log(`${name}@${version} is already on the registry.`);
            continue;
        }
        const packed = spawnSync('pnpm', ['pack', '--pack-destination', out], { cwd: directory, stdio: 'inherit' });
        const tarball = readdirSync(out).find((entry) => entry.startsWith(name.replace('@', '').replace('/', '-') + '-'));
        if (packed.status !== 0 || !tarball) throw new Error(`Could not pack ${name}`);
        const args = ['publish', join(out, tarball), '--access', 'public', '--provenance', ...(dryRun ? ['--dry-run'] : [])];
        const published = spawnSync('npm', args, { cwd: directory, stdio: 'inherit' });
        if (published.status !== 0) failed = true;
        rmSync(join(out, tarball));
    }
} finally {
    rmSync(out, { recursive: true, force: true });
}
if (failed) process.exit(1);
