/** Shared by the tarball harness and the tenant handover: running commands, packing every package and module, and pointing an install at the tarballs. */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = resolve(fileURLToPath(import.meta.url), '../..');
export const BIN = join(REPOSITORY, 'packages/tooling/bin/hearthlog.mjs');

export function run(command: string, args: string[], options: { cwd: string; env?: Record<string, string>; quiet?: boolean }): string {
    const result = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8', env: { ...process.env, ...options.env }, maxBuffer: 1 << 28 });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} (in ${options.cwd}) failed:\n${result.stdout.slice(-3000)}\n${result.stderr.slice(-3000)}`);
    }
    return result.stdout;
}

export function step(message: string): void {
    console.log(`\n== ${message}`);
}

export function packEverything(work: string): Map<string, string> {
    const tarballs = join(work, 'tarballs');
    rmSync(tarballs, { recursive: true, force: true });
    mkdirSync(tarballs, { recursive: true });
    const packed = new Map<string, string>();
    for (const group of ['packages', 'modules']) {
        if (!existsSync(join(REPOSITORY, group))) continue; // a platform workspace has no modules/
        for (const folder of readdirSync(join(REPOSITORY, group))) {
            const directory = join(REPOSITORY, group, folder);
            const manifestPath = join(directory, 'package.json');
            if (!existsSync(manifestPath)) continue;
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string; version: string };
            run('pnpm', ['pack', '--pack-destination', tarballs], { cwd: directory });
            const file = join(tarballs, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`);
            if (!existsSync(file)) throw new Error(`pnpm pack did not write ${file}`);
            packed.set(manifest.name, file);
        }
    }
    console.log(`Packed ${packed.size} packages into ${tarballs}`);
    return packed;
}

/** Points a site's dependencies and a pnpm override at every tarball (pnpm 10 reads overrides from pnpm-workspace.yaml). */
export function useTarballs(directory: string, packed: Map<string, string>): void {
    const manifestPath = join(directory, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> };
    const overrides: Record<string, string> = {};
    for (const [name, file] of packed) {
        overrides[name] = `file:${file}`;
        if (name in manifest.dependencies) manifest.dependencies[name] = `file:${file}`;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    appendFileSync(join(directory, 'pnpm-workspace.yaml'), `\noverrides:\n${Object.entries(overrides).map(([name, value]) => `  '${name}': '${value}'`).join('\n')}\n`);
}
