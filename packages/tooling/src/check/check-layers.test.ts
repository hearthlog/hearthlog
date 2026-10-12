import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkLayers, checkPackages, layerOf, type LayerConfig } from './check-layers.js';

const config: LayerConfig = {
    root: 'src/lib',
    default: 'runtime',
    layers: [
        { name: 'kernel', may: [], include: ['features/*'] },
        { name: 'ui', may: ['kernel'], include: ['components/ui/*'] },
        { name: 'shell', may: ['kernel', 'ui', 'runtime'], include: ['components/**'] },
        { name: 'runtime', may: ['kernel', 'ui'], include: [] },
    ],
    packages: { widgets: { may: ['base'], allowOutside: ['packages/other/src/ok'] } },
};

test('a file belongs to the first layer whose glob matches it, else to the default', () => {
    assert.equal(layerOf('features/core.ts', config), 'kernel');
    assert.equal(layerOf('components/ui/Button.svelte', config), 'ui');
    assert.equal(layerOf('components/layout/NavBar.svelte', config), 'shell');
    assert.equal(layerOf('db/index.ts', config), 'runtime');
});

test('imports may point down the layers, and a layer that reaches up or sideways is reported', () => {
    const root = mkdtempSync(join(tmpdir(), 'layers-'));
    try {
        const write = (path: string, content: string) => {
            mkdirSync(join(root, 'src', 'lib', ...path.split('/').slice(0, -1)), { recursive: true });
            writeFileSync(join(root, 'src', 'lib', path), content);
        };
        write('features/core.ts', 'export const core = 1;\n');
        write('components/ui/Button.svelte', "<script>import { core } from '@hearthlog/contracts/features/core';</script>\n");
        write('db/index.ts', "import { core } from '../features/core.js';\nimport Button from '@hearthlog/ui/components/ui/Button.svelte';\nexport const db = core;\n");
        write('components/layout/NavBar.svelte', "<script>import { db } from '#lib/db/index.js';</script>\n");
        write('db/bad.ts', "import NavBar from '#lib/components/layout/NavBar.svelte';\n");
        write('features/bad.ts', "import { db } from '#lib/db/index.js';\n");
        write('components/ui/Bad.svelte', "<script>import { db } from '#lib/db/index.js';</script>\n");
        write('db/ignored.test.ts', "import NavBar from '#lib/components/layout/NavBar.svelte';\n");
        const { problems, counts } = checkLayers(root, config);
        assert.deepEqual(problems.map((problem) => problem.replace(/^.*src\/lib\//, '')).sort(), [
            'components/ui/Bad.svelte: ui imports runtime (db/index.ts)',
            'db/bad.ts: runtime imports shell (components/layout/NavBar.svelte)',
            'features/bad.ts: kernel imports runtime (db/index.ts)',
        ]);
        assert.deepEqual(counts, { kernel: 2, ui: 2, runtime: 2, shell: 1 });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('an extracted package may not import the app, leave its src, or import a package it does not list', () => {
    const root = mkdtempSync(join(tmpdir(), 'layers-pkg-'));
    try {
        const write = (path: string, content: string) => {
            mkdirSync(join(root, 'packages', 'widgets', 'src', ...path.split('/').slice(0, -1)), { recursive: true });
            writeFileSync(join(root, 'packages', 'widgets', 'src', path), content);
        };
        write('a.ts', "import { x } from './b.js';\nimport s from 'svelte';\nimport { g } from '#generated/modules';\nimport { u } from '@hearthlog/widgets/b.js';\nimport { k } from '@hearthlog/base/k.js';\nexport { x, s, g, u, k };\n");
        write('b.ts', 'export const x = 1;\n');
        write('app.ts', "import { db } from '#lib/db/index.js';\nexport { db };\n");
        write('out.ts', "import { y } from '../../other/src/y.js';\nexport { y };\n");
        write('other.ts', "import { r } from '@hearthlog/runtime/r.js';\nexport { r };\n");
        write('ok.ts', "import { y } from '../../other/src/ok.js';\nexport { y };\n");
        write('a.test.ts', "import { db } from '#lib/db/index.js';\nexport { db };\n");
        assert.deepEqual(checkPackages(root, config).map((problem) => problem.replace(/^packages\/widgets\/src\//, '')).sort(), [
            'app.ts: @hearthlog/widgets imports the app ("#lib/db/index.js")',
            'other.ts: @hearthlog/widgets may not import @hearthlog/runtime',
            'out.ts: @hearthlog/widgets reaches outside its src ("../../other/src/y.js")',
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
