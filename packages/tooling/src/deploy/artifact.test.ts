import { compareFingerprints, unhash } from './artifact-compare.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { renderWorkflow } from '../init/init.js';
import { buildManifest, manifestProblems } from './artifact.js';

function release() {
    const root = mkdtempSync(join(tmpdir(), 'hearthlog-artifact-'));
    mkdirSync(join(root, 'build', 'jst', '_app'), { recursive: true });
    mkdirSync(join(root, '.generated', 'sites', 'jst'), { recursive: true });
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    writeFileSync(join(root, 'build', 'jst', 'index.html'), '<html></html>');
    writeFileSync(join(root, 'build', 'jst', '_app', 'a.js'), 'export {}');
    writeFileSync(join(root, '.generated', 'sites', 'jst', 'worker.ts'), 'export default {}');
    const paths = [join(root, 'build', 'jst'), join(root, '.generated')];
    return { root, paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a release matches its manifest until a file, the lockfile, or the file list changes', () => {
    const { root, paths, cleanup } = release();
    try {
        const manifest = buildManifest('jst', root, paths);
        assert.deepEqual(Object.keys(manifest.files).sort(), ['.generated/sites/jst/worker.ts', 'build/jst/_app/a.js', 'build/jst/index.html']);
        assert.deepEqual(manifestProblems(manifest, root, paths), []);

        writeFileSync(join(root, 'build', 'jst', '_app', 'a.js'), 'export const evil = 1');
        assert.match(manifestProblems(manifest, root, paths)[0]!, /build\/jst\/_app\/a\.js changed/);
        writeFileSync(join(root, 'build', 'jst', '_app', 'a.js'), 'export {}');

        writeFileSync(join(root, 'build', 'jst', 'extra.js'), '1');
        assert.match(manifestProblems(manifest, root, paths)[0]!, /extra\.js was not part of the build/);
        rmSync(join(root, 'build', 'jst', 'extra.js'));

        writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nother\n');
        assert.match(manifestProblems(manifest, root, paths)[0]!, /pnpm-lock\.yaml/);
        writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

        assert.match(manifestProblems({ ...manifest, files: { ...manifest.files, 'build/jst/gone.js': 'x' } }, root, paths).join('\n'), /gone\.js is missing/);
    } finally {
        cleanup();
    }
});

test('the tenant workflow keeps secrets out of the build job and pins every action', () => {
    const text = renderWorkflow('jst-two');
    const [build, deploy] = text.split('\n  deploy:\n');
    assert.ok(build && deploy);
    assert.equal(/\$\{\{ secrets\./.test(build), false);
    assert.match(deploy, /environment: jst-two/);
    assert.match(deploy, /--ignore-scripts/);
    assert.match(deploy, /LEDGER_ADMIN_TOKEN_JST_TWO: \$\{\{ secrets\.LEDGER_ADMIN_TOKEN \}\}/);
    assert.match(deploy, /--skip-build --no-bootstrap/);
    // Secrets are on the deploy step only, never on the job.
    assert.equal(/\n    env:/.test(deploy), false);
    for (const use of text.match(/uses: \S+/g) ?? []) assert.match(use, /@[0-9a-f]{40}$/);
    assert.equal(/\{\{(id|idUpper|pushPaths)\}\}/.test(text), false);
});

test('two builds of a site are the same site when routes, chunk names, precache, gateway, contracts, and Worker config agree', () => {
    const base = { routes: ['/a', '/b'], chunks: ['_app/x-#.js', '_app/x-#.js'], precache: ['/a'], contents: ['1', '2'], gateway: 'g', contracts: 'c', wrangler: 'w' };
    assert.deepEqual(compareFingerprints('s', base, { ...base, contents: ['3', '2'] }).problems, [], 'file hashes are not compared');
    assert.equal(compareFingerprints('s', base, { ...base, contents: ['3', '2'] }).identical, 1);
    assert.equal(compareFingerprints('s', base, { ...base, chunks: ['_app/x-#.js'] }).problems.length, 1, 'a chunk missing counts, even when its name repeats');
    assert.equal(compareFingerprints('s', base, { ...base, gateway: 'h', contracts: 'd' }).problems.length, 2);
    assert.equal(unhash('_app/immutable/chunks/AbC123xy.js'), '_app/immutable/chunks/#.js');
});
