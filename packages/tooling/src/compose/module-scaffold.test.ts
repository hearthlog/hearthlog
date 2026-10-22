import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

import { validateManifest } from '@hearthlog/contracts';

import { checkBoundaries } from '../check/check-modules.js';
import { checkComposition, loadModules, modulesForFeatures, renderRoute } from './compose-modules.js';
import { renderSite } from '../init/init.js';
import { exportModule, moduleTemplate, scaffoldModule } from './module-scaffold.js';
/** Calc and Health as installed (`pnpm test:integration` installs the published modules; this repository has none). */
const REAL_MODULES = loadModules().filter(({ manifest }) => ['@hearthlog/module-calc', '@hearthlog/module-health'].includes(manifest.package));
const needsModules = { skip: REAL_MODULES.length < 2 && 'needs the modules: pnpm test:integration' };

/** A scratch platform: the real modules when they are installed, plus whatever a test adds. */
function workspace() {
    const root = mkdtempSync(join(tmpdir(), 'stor-scaffold-'));
    mkdirSync(join(root, 'modules'), { recursive: true });
    for (const { manifest, directory } of REAL_MODULES) {
        const source = realpathSync(directory);
        cpSync(source, join(root, 'modules', manifest.package.replace('@hearthlog/module-', '')), {
            recursive: true, dereference: true,
            // Integration links dependencies into installed modules. These
            // source/manifest fixtures must not recursively copy that graph.
            filter: path => !relative(source, path).split(sep).includes('node_modules'),
        });
    }
    return { root, modules: join(root, 'modules'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a module made from the template composes with the real ones and breaks no boundary, with no core edit', () => {
    const space = workspace();
    try {
        scaffoldModule(space.modules, { name: 'notes' });
        const modules = loadModules(space.modules);
        const notes = modules.find(({ manifest }) => manifest.id === 'org.example.notes');
        assert.ok(notes, 'the composer finds the new module by its directory alone');
        assert.doesNotThrow(() => checkComposition(modules));
        assert.deepEqual(modulesForFeatures(modules, ['notes']).map(({ manifest }) => manifest.id), ['org.example.notes']);
        const route = renderRoute(notes.manifest, notes.manifest.routes[0]!);
        assert.match(route.page, /@hearthlog\/module-notes\/pages\/home\.svelte/);
        assert.deepEqual(checkBoundaries(space.root).filter((problem) => problem.includes('notes')), []);
    } finally {
        space.cleanup();
    }
});

test('the template refuses names that would break routes or collide', () => {
    const space = workspace();
    try {
        assert.throws(() => moduleTemplate({ name: 'Bad Name' }), /lowercase/);
        assert.throws(() => moduleTemplate({ name: 'ok', feature: '../x' }), /feature id/);
        scaffoldModule(space.modules, { name: 'notes' });
        assert.throws(() => scaffoldModule(space.modules, { name: 'notes' }), /already exists/);
        // A second module claiming the same feature is rejected by the composer, not silently merged.
        scaffoldModule(space.modules, { name: 'notes-again', feature: 'notes' });
        assert.throws(() => checkComposition(loadModules(space.modules)));
    } finally {
        space.cleanup();
    }
});

test('a module that reaches into the core is caught', () => {
    const space = workspace();
    try {
        scaffoldModule(space.modules, { name: 'sneaky' });
        const page = join(space.modules, 'sneaky', 'src', 'pages', 'home.ts');
        writeFileSync(page, `import { db } from '#lib/db/index.js';\n${readFileSync(page, 'utf8')}`);
        assert.ok(checkBoundaries(space.root).some((problem) => problem.includes('sneaky') && problem.includes('#lib')));
    } finally {
        space.cleanup();
    }
});

/** A module in its source form, as `module:new` writes it, with one third-party dependency. */
function sourceModule(space: ReturnType<typeof workspace>, name: string): void {
    scaffoldModule(space.modules, { name });
    const path = join(space.modules, name, 'package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies: Record<string, string> };
    manifest.dependencies['date-fns'] = '^4.4.0';
    writeFileSync(path, JSON.stringify(manifest));
}

test('an exported module is a repository of its own: a valid manifest, peer ranges, and a license', () => {
    const space = workspace();
    const out = join(space.root, 'out', 'notes');
    try {
        sourceModule(space, 'notes');
        const files = exportModule(space.modules, 'notes', out);
        assert.ok(files.includes('LICENSE') && files.includes('hearthlog.module.json') && files.includes('package.json'));
        assert.doesNotThrow(() => validateManifest(JSON.parse(readFileSync(join(out, 'hearthlog.module.json'), 'utf8'))));
        const manifest = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
        assert.equal(manifest.private, undefined);
        assert.equal(manifest.license, 'AGPL-3.0-only');
        assert.equal(manifest.dependencies['@hearthlog/sdk'], undefined, 'the platform is a peer, not a bundled dependency');
        assert.match(manifest.peerDependencies['@hearthlog/sdk'], /^>=0\.1\.0/);
        assert.equal(manifest.dependencies['date-fns'], '^4.4.0', 'third-party dependencies stay');
        assert.deepEqual(manifest.files, ['src', 'hearthlog.module.json', '!**/*.test.ts'], 'the tests stay out of the package');
        assert.deepEqual(manifest.publishConfig, { access: 'public', provenance: true });
        assert.match(manifest.repository.url, /hearthlog-module-notes\.git$/);
        assert.equal(manifest.scripts.test, 'hearthlog check-module');
        assert.match(manifest.packageManager, /^pnpm@10/);
        assert.match(readFileSync(join(out, 'pnpm-workspace.yaml'), 'utf8'), /esbuild/);
        assert.equal(manifest.devDependencies['@hearthlog/tooling'], manifest.peerDependencies['@hearthlog/sdk'], 'tested against the platform range it accepts');
        assert.ok(files.includes('.gitignore') && files.includes('.gitleaks.toml') && files.includes('.github/workflows/ci.yml') && files.includes('.github/workflows/release.yml'));
        assert.match(readFileSync(join(out, '.github/workflows/release.yml'), 'utf8'), /environment: npm/);
        assert.throws(() => exportModule(space.modules, 'notes', out), /not empty/);
    } finally {
        space.cleanup();
    }
});

test('an export refuses a module whose sources import a platform package it does not declare', () => {
    const space = workspace();
    try {
        sourceModule(space, 'notes');
        writeFileSync(join(space.modules, 'notes', 'src', 'extra.ts'), "import { x } from '@hearthlog/ui/state/commands.js';\nexport { x };\n");
        assert.throws(() => exportModule(space.modules, 'notes', join(space.root, 'out', 'notes')), /imports @hearthlog\/ui without declaring it/);
    } finally {
        space.cleanup();
    }
});

test('a site depends on each module at the module\'s own version, not the platform\'s', needsModules, () => {
    const space = workspace();
    const calc = loadModules(space.modules).find(({ manifest }) => manifest.package === '@hearthlog/module-calc');
    assert.ok(calc);
    const files = new Map(renderSite({ directory: '/unused', id: 'one', modules: ['calc'], available: [calc] }));
    const manifest = JSON.parse(files.get('package.json')!) as { dependencies: Record<string, string> };
    const version = (JSON.parse(readFileSync(join(calc.directory, 'package.json'), 'utf8')) as { version: string }).version;
    assert.equal(manifest.dependencies['@hearthlog/module-calc'], `^${version}`);
    assert.notEqual(manifest.dependencies['@hearthlog/module-calc'], manifest.dependencies['@hearthlog/sdk']);
    space.cleanup();
});
