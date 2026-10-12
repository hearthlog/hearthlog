/**
 * `pnpm check:packages`
 *
 * What would reach npm, checked on the real tarballs: `pnpm pack` every package of `packages/`, unpack it, and require
 *
 *   - a package that is not private declares provenance publishing, a `repository` with its directory, a license, and a `files` list;
 *   - no `workspace:` range survives the pack, and no test, environment, Wrangler state, or editor file is inside;
 *   - every `exports` and `bin` target exists in the tarball (a pattern needs at least one match);
 *   - the unpacked files hold none of the forbidden identities (when the list is present; see `pnpm audit:push`).
 *
 * A package that stays private is listed in `PRIVATE`, so making one private by accident fails too.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditFiles } from '../packages/tooling/src/security/audit-push.js';
import { loadForbiddenList } from '../packages/tooling/src/security/forbidden-identities.js';

const REPOSITORY = resolve(fileURLToPath(import.meta.url), '../..');
/** Packages that are not published, and why. */
const PRIVATE: Record<string, string> = {
    "@hearthlog/ledger-admin": "the operator console: its Worker configuration and deploy script carry one operator's hostname and address",
};
const UNWANTED = /(^|\/)(node_modules|\.wrangler|\.dev\.vars[^/]*|\.env[^/]*|\.DS_Store)(\/|$)|\.(test|spec)\.[cm]?[jt]s$/;

type Manifest = {
    name: string;
    version: string;
    private?: boolean;
    license?: string;
    files?: string[];
    repository?: { directory?: string; url?: string };
    publishConfig?: { access?: string; provenance?: boolean };
    bin?: string | Record<string, string>;
    exports?: unknown;
    [key: string]: unknown;
};

/** Every string leaf of an `exports` map (conditions flattened). */
function targets(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (value && typeof value === 'object') return Object.values(value).flatMap(targets);
    return [];
}

function listFiles(directory: string, prefix = ''): string[] {
    return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? listFiles(directory, join(prefix, entry.name)) : [join(prefix, entry.name)],
    );
}

const work = mkdtempSync(join(tmpdir(), 'hearthlog-packages-'));
const problems: string[] = [];
const unpackedRoots: string[] = [];
let published = 0;
try {
    for (const folder of readdirSync(join(REPOSITORY, 'packages')).sort()) {
        const directory = join(REPOSITORY, 'packages', folder);
        if (!existsSync(join(directory, 'package.json'))) continue;
        const source = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest;
        const fail = (message: string) => problems.push(`${source.name}: ${message}`);
        if (source.private) {
            if (!(source.name in PRIVATE)) fail('is private but not listed in PRIVATE');
            continue;
        }
        if (source.name in PRIVATE) fail('is listed in PRIVATE but is not private');
        if (!source.license) fail('has no license');
        if (!Array.isArray(source.files) || source.files.length === 0) fail('has no files list');
        if (source.repository?.directory !== `packages/${folder}` || !source.repository.url) fail('has no repository with its directory');
        if (source.publishConfig?.access !== 'public' || source.publishConfig.provenance !== true) fail('does not publish publicly with provenance');

        const destination = join(work, folder);
        mkdirSync(destination, { recursive: true });
        const packed = spawnSync('pnpm', ['pack', '--pack-destination', destination], { cwd: directory, encoding: 'utf8' });
        if (packed.status !== 0) {
            fail(`pnpm pack failed: ${packed.stderr.trim()}`);
            continue;
        }
        const tarball = readdirSync(destination).find((name) => name.endsWith('.tgz'))!;
        const unpacked = join(destination, 'unpacked');
        mkdirSync(unpacked);
        const extracted = spawnSync('tar', ['xzf', join(destination, tarball), '-C', unpacked, '--strip-components=1']);
        if (extracted.status !== 0) {
            fail('could not unpack the tarball');
            continue;
        }
        published++;
        unpackedRoots.push(unpacked);
        const files = listFiles(unpacked);
        for (const file of files.filter((candidate) => UNWANTED.test(candidate))) fail(`ships ${file}`);

        const manifest = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8')) as Manifest;
        if (/"workspace:/.test(JSON.stringify(manifest))) fail('still has a workspace: range after pack');

        const wanted = [...targets(manifest.exports), ...targets(manifest.bin)];
        for (const target of wanted) {
            if (!target.startsWith('./')) continue;
            const path = target.slice(2);
            if (path.includes('*')) {
                const [head, tail] = path.split('*');
                if (!files.some((file) => file.startsWith(head) && file.endsWith(tail))) fail(`export ${target} matches no file`);
            } else if (!files.includes(path)) {
                fail(`export ${target} is not in the tarball`);
            }
        }
        console.log(`${manifest.name}@${manifest.version}: ${files.length} files`);
    }

    let list;
    try {
        list = loadForbiddenList();
    } catch {
        console.warn('The forbidden-identities list is not present: skipped the identity scan of the tarballs.');
    }
    if (list) {
        for (const root of unpackedRoots) {
            for (const finding of auditFiles(root, list)) problems.push(`${root.split('/').slice(-2)[0]}: ${finding.where} (${finding.kind}: ${finding.detail})`);
        }
    }
} finally {
    rmSync(work, { recursive: true, force: true });
}

if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    process.exit(1);
}
console.log(`\n${published} packages pack cleanly.`);
