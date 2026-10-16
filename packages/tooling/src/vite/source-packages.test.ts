import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { sourcePackages } from './source-packages.js';

/** A site installed the way pnpm lays it out: packages in `.pnpm/<id>/node_modules`, linked into the importer's `node_modules`. */
test('every @hearthlog package and every module is found, direct or transitive, and nothing else', () => {
    const root = mkdtempSync(join(tmpdir(), 'hearthlog-source-packages-'));
    try {
        const store = (id: string) => join(root, 'node_modules', '.pnpm', id, 'node_modules');
        const install = (id: string, name: string, manifest: Record<string, unknown>, isModule = false) => {
            const directory = join(store(id), name);
            mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, ...manifest }));
            if (isModule) writeFileSync(join(directory, 'hearthlog.module.json'), '{}');
            return directory;
        };
        const link = (target: string, name: string, into: string) => {
            mkdirSync(dirname(join(into, name)), { recursive: true });
            symlinkSync(target, join(into, name));
        };

        const czech = install('czech', '@hearthlog/czech', {});
        const calc = install('calc', '@hearthlog/module-calc', { dependencies: { 'date-fns': '*' }, peerDependencies: { '@hearthlog/czech': '*' } }, true);
        link(czech, '@hearthlog/czech', store('calc'));
        link(install('date-fns', 'date-fns', {}), 'date-fns', store('calc'));
        const notes = install('notes', '@acme/module-notes', { dependencies: { '@acme/helpers': '*' } }, true);
        link(install('helpers', '@acme/helpers', {}), '@acme/helpers', store('notes'));
        const svelte = install('svelte', 'svelte', {});

        writeFileSync(join(root, 'package.json'), JSON.stringify({
            dependencies: { '@hearthlog/module-calc': '*', '@acme/module-notes': '*', '@hearthlog/missing': '*' },
            devDependencies: { svelte: '*' },
        }));
        link(calc, '@hearthlog/module-calc', join(root, 'node_modules'));
        link(notes, '@acme/module-notes', join(root, 'node_modules'));
        link(svelte, 'svelte', join(root, 'node_modules'));

        assert.deepEqual(sourcePackages(root), ['@acme/module-notes', '@hearthlog/czech', '@hearthlog/module-calc']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a folder without a package.json has none', () => {
    const root = mkdtempSync(join(tmpdir(), 'hearthlog-source-packages-'));
    try {
        assert.deepEqual(sourcePackages(root), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
