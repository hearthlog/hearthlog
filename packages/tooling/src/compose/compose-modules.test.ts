import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { findCollisions, ManifestError, moduleSettingPlaceholder, moduleSettingProblem, validateManifest, type ModuleManifest } from '@hearthlog/contracts';

import { coreNamesNoDomain, directGeneratedImports, moduleImportProblem } from '../check/check-modules.js';
import { loadModules, modulesForFeatures, renderNative, renderRoute, renderGatewayEntry, renderGatewayModules } from './compose-modules.js';

/** Tests that need the real modules run in `pnpm test:integration`, which installs them. */
const needsModules = { skip: loadModules().length === 0 && 'needs the modules: pnpm test:integration' };

const manifest = (overrides: Partial<ModuleManifest> = {}): ModuleManifest => ({
    manifestVersion: 1,
    id: 'org.example.notes',
    package: '@hearthlog/module-notes',
    version: '1.0.0',
    compatibility: { moduleApi: 1 },
    features: [{ id: 'notes', path: '/notes', label: 'Notes', subtitle: 'Notes', keywords: 'notes', navGroup: 'Life', icon: 'note-outline' }],
    routes: [{ path: '/notes', page: './src/pages/notes.svelte' }],
    ...overrides,
});

test('rejects modules that claim a core or another module\'s feature, route, or refresh key', () => {
    const reserved = { featureIds: ['finance'], routePaths: ['/finance'], refreshKeys: ['app:transactions'] };
    assert.deepEqual(findCollisions([manifest()], reserved), []);
    const clash = manifest({ id: 'org.example.other', package: '@hearthlog/module-other' });
    assert.equal(findCollisions([manifest(), clash], reserved).length, 2);
    const core = manifest({
        features: [{ ...manifest().features[0]!, id: 'finance' }],
        routes: [{ path: '/finance', page: './src/pages/notes.svelte' }],
        refreshKeys: ['app:transactions'],
    });
    assert.equal(findCollisions([core], reserved).length, 3);
});

test('a manifest cannot point outside its module or declare unknown keys', () => {
    assert.doesNotThrow(() => validateManifest(manifest()));
    assert.throws(() => validateManifest(manifest({ routes: [{ path: '/notes', page: './src/../../app/x.svelte' }] })), ManifestError);
    assert.throws(() => validateManifest({ ...manifest(), extra: true }), ManifestError);
    assert.throws(() => validateManifest(manifest({ compatibility: { moduleApi: 2 } })), ManifestError);
});

test('module SQLite Durable Objects are validated, exported, and cannot claim another module or core export', () => {
    const server: NonNullable<ModuleManifest['server']> = { entry: './src/server/index.ts', bindings: [
        { binding: 'NOTE_INDEX', type: 'durable-object', className: 'NoteIndex' },
    ] };
    const first = manifest({ server });
    assert.doesNotThrow(() => validateManifest(first));
    assert.throws(() => validateManifest(manifest({ server: { ...server, bindings: [{ binding: 'NOTE_INDEX', type: 'durable-object', className: '../bad' }] } })), ManifestError);
    const modules = [{ manifest: first, directory: '/fixture/notes' }];
    assert.match(renderGatewayModules('st', modules), /export \{ NoteIndex \} from '@hearthlog\/module-notes\/server\/index.js'/);
    assert.match(renderGatewayEntry('st', modules), /export \{ NoteIndex \} from '.\/server-modules.js'/);
    const reserved = { featureIds: [], routePaths: [], refreshKeys: [] };
    assert.ok(findCollisions([first, manifest({ id: 'org.example.other', package: '@hearthlog/module-other', server })], reserved).some(problem => problem.includes('Worker export')));
    assert.ok(findCollisions([manifest({ server: { ...server, bindings: [{ binding: 'NOTE_INDEX', type: 'durable-object', className: 'CalendarFeedRenderer' }] } })], reserved).some(problem => problem.includes('the core')));
});

test('a tenant composes only modules whose features it enables', needsModules, () => {
    const modules = loadModules();
    assert.ok(modules.some(({ manifest }) => manifest.id === 'org.stor.calc'));
    assert.deepEqual(modulesForFeatures(modules, ['invoices']).map(({ manifest }) => manifest.id), ['org.stor.invoices']);
    assert.deepEqual(modulesForFeatures(modules, ['calendar']).map(({ manifest }) => manifest.id), []);
    assert.deepEqual(modulesForFeatures(modules, ['finance']).map(({ manifest }) => manifest.id), ['org.stor.finance']);
    assert.deepEqual(modulesForFeatures(modules, ['calendar', 'bmi']).map(({ manifest }) => manifest.id), ['org.stor.health']);
    assert.deepEqual(modulesForFeatures(modules, ['calc']).map(({ manifest }) => manifest.id), ['org.stor.calc']);
    const route = renderRoute(manifest(), { path: '/notes', page: './src/pages/notes.svelte', load: './src/pages/notes.ts' });
    assert.match(route.page, /from "@hearthlog\/module-notes\/pages\/notes\.svelte"/);
    assert.match(route.load!, /from "@hearthlog\/module-notes\/pages\/notes\.js"/);
});

test('a module may import only the platform API, its own files, and declared packages', () => {
    const root = '/repo/modules/notes';
    const file = `${root}/src/pages/notes.svelte`;
    assert.equal(moduleImportProblem('@hearthlog/sdk/ui', file, root, []), null);
    assert.equal(moduleImportProblem('../notes.js', file, root, []), null);
    assert.equal(moduleImportProblem('date-fns', file, root, ['date-fns']), null);
    assert.ok(moduleImportProblem('#lib/db/index.js', file, root, []));
    assert.ok(moduleImportProblem('../../../../src/lib/db/index.js', file, root, []));
    assert.ok(moduleImportProblem('@hearthlog/module-calc/pages/income.svelte', file, root, []));
    assert.ok(moduleImportProblem('pdf-lib', file, root, []));
    // Worker code stays off the browser entries.
    const server = `${root}/src/server/index.ts`;
    assert.equal(moduleImportProblem('@hearthlog/sdk/server', server, root, []), null);
    assert.equal(moduleImportProblem('@hearthlog/sdk/entities', server, root, []), null);
    assert.ok(moduleImportProblem('@hearthlog/sdk/data', server, root, []));
    assert.ok(moduleImportProblem('@hearthlog/sdk/runtime', server, root, []));
    assert.ok(moduleImportProblem('svelte', server, root, []));
});

test('the core may not name a module feature outside comments, tests, and generated files', () => {
    const root = mkdtempSync(join(tmpdir(), 'stor-core-'));
    try {
        mkdirSync(join(root, 'modules', 'notes'), { recursive: true });
        writeFileSync(join(root, 'modules', 'notes', 'hearthlog.module.json'), JSON.stringify({ features: [{ id: 'notes' }] }));
        mkdirSync(join(root, 'src', 'lib'), { recursive: true });
        writeFileSync(join(root, 'src', 'lib', 'leak.ts'), "export const order = ['notes'];\n");
        writeFileSync(join(root, 'src', 'lib', 'fine.ts'), "// 'notes' is only an example here\nexport const x = 1;\n");
        writeFileSync(join(root, 'src', 'lib', 'fine.test.ts'), "export const y = 'notes';\n");
        writeFileSync(join(root, 'src', 'lib', 'catalog.generated.ts'), "export const z = 'notes';\n");
        const problems = coreNamesNoDomain(root, ['src/lib']);
        assert.equal(problems.length, 1);
        assert.match(problems[0]!, /leak\.ts:1.*notes/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('the core may not quote a module entity or table, or name its event types, outside comments, tests, and generated files', () => {
    const root = mkdtempSync(join(tmpdir(), 'stor-core-'));
    try {
        mkdirSync(join(root, 'modules', 'notes'), { recursive: true });
        writeFileSync(join(root, 'modules', 'notes', 'hearthlog.module.json'), JSON.stringify({ features: [{ id: 'notes' }] }));
        for (const directory of ['packages/runtime/src', 'packages/tooling/src/host', 'ledger/src', 'worker']) mkdirSync(join(root, directory), { recursive: true });
        writeFileSync(join(root, 'packages', 'runtime', 'src', 'leak.ts'), "export const table = 'jotted_notes';\nexport const type = 'NOTE_ADDED';\n");
        writeFileSync(join(root, 'packages', 'tooling', 'src', 'host', 'leak.ts'), 'export const entity = "note";\n');
        writeFileSync(join(root, 'ledger', 'src', 'leak.ts'), 'if (event.type === NOTE_UPDATED) {}\n');
        writeFileSync(join(root, 'worker', 'fine.ts'), "// 'note' and NOTE_ADDED are only examples here\nexport const notes = 1;\n");
        writeFileSync(join(root, 'packages', 'runtime', 'src', 'fine.test.ts'), "export const y = 'note';\n");
        writeFileSync(join(root, 'ledger', 'src', 'schemas.generated.ts'), "export const z = 'NOTE_ADDED';\n");
        const domain = { names: ['note', 'jotted_notes'], eventTypes: ['NOTE_ADDED', 'NOTE_UPDATED'] };
        const problems = coreNamesNoDomain(root, undefined, domain);
        assert.deepEqual(problems.map((problem) => problem.replace(/:\d+:.*/, '')).sort(), [
            join('ledger', 'src', 'leak.ts'), join('packages', 'runtime', 'src', 'leak.ts'), join('packages', 'runtime', 'src', 'leak.ts'), join('packages', 'tooling', 'src', 'host', 'leak.ts'),
        ].sort());
        assert.deepEqual(coreNamesNoDomain(root, undefined), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('generated files are imported only through #generated, not by path', () => {
    const root = mkdtempSync(join(tmpdir(), 'stor-generated-'));
    try {
        for (const directory of ['src/lib/db', 'worker/generated', 'ledger/src']) mkdirSync(join(root, directory), { recursive: true });
        writeFileSync(join(root, 'src', 'lib', 'db', 'schema.generated.ts'), 'export const a = 1;\n');
        writeFileSync(join(root, 'src', 'lib', 'db', 'bad.ts'), "import { a } from './schema.generated.js';\nimport { b } from '#lib/features/modules.generated.js';\nexport { a, b };\n");
        writeFileSync(join(root, 'src', 'lib', 'db', 'good.ts'), "import { a } from '#generated/schema';\nimport { t } from '$tenant/generated';\nexport { a, t };\n");
        writeFileSync(join(root, 'worker', 'generated', 'st.generated.ts'), "import { a } from '../../src/lib/db/schema.generated.js';\nexport { a };\n");
        writeFileSync(join(root, 'ledger', 'src', 'x.ts'), "import { e } from './event-schemas.generated';\nexport { e };\n");
        const problems = directGeneratedImports(root);
        assert.deepEqual(problems.map((problem) => problem.replace(/: .*/, '')).sort(), [
            join('ledger', 'src', 'x.ts'), join('src', 'lib', 'db', 'bad.ts'), join('src', 'lib', 'db', 'bad.ts'),
        ].sort());
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('module secrets are named, write-only, and cannot overwrite variables or reserved credentials', () => {
    const server = { entry: './src/server/index.ts', secrets: [{ name: 'MEDIA_KEY' }] };
    assert.doesNotThrow(() => validateManifest(manifest({ server })));
    for (const secrets of [[{ name: 'bad-name' }], [{ name: 'LEDGER_AUTH_TOKEN' }], [{ name: 'MEDIA_KEY', value: 'never-in-a-manifest' }], [{ name: 'MEDIA_KEY' }, { name: 'MEDIA_KEY' }]]) {
        assert.throws(() => validateManifest(manifest({ server: { ...server, secrets } })), ManifestError);
    }
    assert.throws(() => validateManifest(manifest({ server: { ...server, vars: [{ name: 'MEDIA_KEY', resource: 'mediaOrigin' }] } })), ManifestError);
    const other = manifest({ id: 'org.example.other', package: '@hearthlog/module-other', features: [], routes: [], server });
    assert.ok(findCollisions([manifest({ server }), other], { featureIds: [], routePaths: [], refreshKeys: [] }).some(problem => problem.includes('MEDIA_KEY')));
});

test('module settings and dev entries are declared, typed, and kept apart from infrastructure resources', () => {
    const vars = [{ name: 'MEDIA_ENDPOINT', setting: 'mediaEndpoint', format: 'https-origin' as const }, { name: 'MEDIA_PROXY', setting: 'mediaProxy', values: ['0', '1'], optional: true }];
    const server = { entry: './src/server/index.ts', routes: ['/api/media/v1'], vars, dev: './src/server/dev.ts' };
    assert.doesNotThrow(() => validateManifest(manifest({ server })));
    for (const invalid of [
        { ...server, vars: [{ name: 'MEDIA_ENDPOINT', setting: 'mediaEndpoint', resource: 'galleryPublicOrigin' }] },
        { ...server, vars: [{ name: 'MEDIA_ENDPOINT' }] },
        { ...server, vars: [{ name: 'MEDIA_ENDPOINT', setting: 'media-endpoint' }] },
        { ...server, vars: [{ name: 'MEDIA_ENDPOINT', setting: 'mediaEndpoint', format: 'url' }] },
        { ...server, vars: [{ name: 'MEDIA_ENDPOINT', setting: 'mediaEndpoint', values: [] }] },
        { ...server, vars: [{ name: 'MEDIA_ENDPOINT', resource: 'galleryPublicOrigin', format: 'https-origin' }] },
        { ...server, vars: [vars[0], { ...vars[0], name: 'OTHER' }] },
        { ...server, dev: './src/server/index.ts' },
        { ...server, dev: './src/dev.ts' },
        { ...server, routes: [] },
    ]) assert.throws(() => validateManifest(manifest({ server: invalid as never })), ManifestError, JSON.stringify(invalid));
});

test('module setting formats accept only values of their shape', () => {
    assert.equal(moduleSettingProblem({ format: 'https-origin' }, 'https://s3.example.com'), null);
    assert.match(moduleSettingProblem({ format: 'https-origin' }, 'http://s3.example.com') ?? '', /HTTPS/);
    assert.match(moduleSettingProblem({ format: 'https-origin' }, 'https://s3.example.com/bucket') ?? '', /HTTPS/);
    assert.equal(moduleSettingProblem({ format: 's3-bucket' }, 'private-media'), null);
    assert.match(moduleSettingProblem({ format: 's3-bucket' }, 'Private_Media') ?? '', /bucket/);
    assert.match(moduleSettingProblem({ format: 's3-region' }, 'EU 1') ?? '', /region/);
    assert.match(moduleSettingProblem({ values: ['0', '1'] }, 'true') ?? '', /one of/);
    assert.match(moduleSettingProblem({}, ' ') ?? '', /non-empty/);
    assert.equal(moduleSettingPlaceholder({ values: ['0', '1'] }), '0');
    for (const format of ['text', 'https-origin', 's3-bucket', 's3-region'] as const) assert.equal(moduleSettingProblem({ format }, moduleSettingPlaceholder({ format })), null);
});

test('the engine page loads only the native APIs of the modules it composes, on demand', () => {
    assert.match(renderNative([]), /loadNativeApis\(\): Promise<readonly NativeApi\[\]> \{\n {4}return \[\];\n\}/);
    const native = { contract: './src/native/contract.ts', api: './src/native/api.ts' };
    const rendered = renderNative([{ directory: '/notes', manifest: manifest({ native }) }, { directory: '/plain', manifest: manifest({ id: 'org.example.plain', package: '@hearthlog/module-plain' }) }]);
    assert.match(rendered, /Promise\.all\(\[import\('@hearthlog\/module-notes\/native\/api\.js'\)\]\)/);
    assert.doesNotMatch(rendered, /module-plain/);
});

test('a manifest\'s native files live in src/native/ and its Swift stays inside the module', () => {
    const native = (value: unknown) => ({ ...manifest(), native: value });
    assert.equal(validateManifest(native({ contract: './src/native/contract.ts', api: './src/native/api.ts', swiftTypes: './apple/Generated/Notes.swift' })).native?.api, './src/native/api.ts');
    assert.throws(() => validateManifest(native({ contract: './src/contract.ts', api: './src/native/api.ts' })), ManifestError);
    assert.throws(() => validateManifest(native({ contract: './src/native/contract.ts', api: './src/native/api.ts', swiftTypes: './../Notes.swift' })), ManifestError);
    assert.throws(() => validateManifest(native({ contract: './src/native/contract.ts', api: './src/native/api.ts', extra: true })), ManifestError);
});
