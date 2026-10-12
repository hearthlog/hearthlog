import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PRECACHE_EXTRA_PATHS, parseRouteNodeIds, parseServiceWorkerManifestPaths, precacheEntries } from '@hearthlog/shell/service-worker/offline-bundle.js';

const BUILD_DIR = 'build';
const CLIENT_DIR = join(BUILD_DIR, '_app', 'immutable');
const SW_PATH = join(BUILD_DIR, 'service-worker.js');
const INDEX_PATH = join(BUILD_DIR, 'index.html');
const VITE_MANIFEST_PATH = join('.svelte-kit', 'output', 'client', '.vite', 'manifest.json');
const SERVER_MANIFEST_PATH = join('.svelte-kit', 'output', 'server', 'manifest.js');

const PRECACHE_GZIP_BUDGET = 2 * 1024 * 1024;
const PRECACHE_ENTRY_BUDGET = 275;
const LAUNCH_JS_GZIP_BUDGET = 300 * 1024;
const FINANCE_JS_GZIP_BUDGET = 400 * 1024;
const INDEX_GZIP_BUDGET = 10 * 1024;

interface FileReport {
    path: string;
    size: number;
    gzipSize: number;
    hash: string;
}

interface ViteManifestEntry {
    file: string;
    imports?: string[];
    css?: string[];
    assets?: string[];
}

function walkFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walkFiles(path) : [path];
    });
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
    return `${bytes} B`;
}

function readReport(path: string): FileReport {
    const buffer = readFileSync(path);
    return {
        path,
        size: buffer.byteLength,
        gzipSize: gzipSync(buffer).byteLength,
        hash: createHash('sha256').update(buffer).digest('hex'),
    };
}

function reportFiles(paths: Iterable<string>): FileReport[] {
    return [...new Set(paths)].filter(existsSync).map(readReport);
}

function parsePrecacheUrls(): string[] {
    if (!existsSync(SW_PATH)) return [];
    const paths = [...parseServiceWorkerManifestPaths(readFileSync(SW_PATH, 'utf8')), ...PRECACHE_EXTRA_PATHS];
    return precacheEntries(paths.map((path) => ({ path, revision: null }))).map((entry) => entry.url);
}

function precacheUrlToBuildPath(url: string): string | null {
    if (/^(?:https?:)?\/\//.test(url)) return null;
    const clean = url.split(/[?#]/, 1)[0];
    if (/^\/?client\//.test(clean)) return null;
    const relativePath = clean.replace(/^\/+/, '');
    if (!relativePath || relativePath.includes('..')) return null;
    return join(BUILD_DIR, relativePath);
}

function readViteManifest(): Record<string, ViteManifestEntry> | null {
    if (!existsSync(VITE_MANIFEST_PATH)) return null;
    return JSON.parse(readFileSync(VITE_MANIFEST_PATH, 'utf8')) as Record<string, ViteManifestEntry>;
}

function manifestAssetPath(path: string): string {
    if (path.startsWith('_app/')) return join(BUILD_DIR, path);
    if (path.startsWith('_')) {
        return join(BUILD_DIR, '_app', 'immutable', 'chunks', path.slice(1));
    }
    return join(BUILD_DIR, path);
}

function addManifestEntryGraph(
    files: Set<string>,
    viteManifest: Record<string, ViteManifestEntry>,
    key: string,
    visited: Set<string>,
): void {
    if (visited.has(key)) return;
    visited.add(key);
    const entry = viteManifest[key];
    if (!entry) return;
    files.add(manifestAssetPath(entry.file));
    for (const css of entry.css ?? []) files.add(manifestAssetPath(css));
    for (const asset of entry.assets ?? []) files.add(manifestAssetPath(asset));
    for (const imported of entry.imports ?? []) {
        addManifestEntryGraph(files, viteManifest, imported, visited);
    }
}

function routeFirstLoadFiles(
    viteManifest: Record<string, ViteManifestEntry>,
    serverManifest: string,
    routeId: string,
): Set<string> | null {
    const nodeIds = parseRouteNodeIds(serverManifest, [routeId]);
    if (nodeIds.length <= 1 && routeId !== '/') return null;

    const files = new Set<string>();
    const visited = new Set<string>();
    for (const [key, entry] of Object.entries(viteManifest)) {
        if (entry.file.includes('/entry/')) {
            addManifestEntryGraph(files, viteManifest, key, visited);
        }
    }
    for (const nodeId of nodeIds) {
        addManifestEntryGraph(
            files,
            viteManifest,
            `.svelte-kit/generated/client-optimized/nodes/${nodeId}.js`,
            visited,
        );
    }
    return files;
}

function sum(files: FileReport[], field: 'size' | 'gzipSize'): number {
    return files.reduce((total, file) => total + file[field], 0);
}

function printFileTable(title: string, files: FileReport[], limit = 12): void {
    console.log(`\n${title}`);
    for (const file of files.slice(0, limit)) {
        console.log(
            `${formatBytes(file.size).padStart(10)} gzip ${formatBytes(file.gzipSize).padStart(10)}  ${relative(BUILD_DIR, file.path)}`,
        );
    }
}

function fail(message: string): void {
    console.error(message);
    process.exitCode = 1;
}

if (!existsSync(BUILD_DIR) || !existsSync(SW_PATH) || !existsSync(INDEX_PATH)) {
    console.error('Complete build output is missing. Run pnpm build first.');
    process.exit(1);
}

const allBuildFiles = walkFiles(BUILD_DIR);
const immutableFiles = reportFiles(walkFiles(CLIENT_DIR));
const jsFiles = immutableFiles.filter((file) => file.path.endsWith('.js'));
const precacheUrls = parsePrecacheUrls();
const invalidPrecacheUrls = precacheUrls.filter((url) => precacheUrlToBuildPath(url) === null);
const nonRootRelativePrecacheUrls = precacheUrls.filter((url) => !url.startsWith('/'));
const precachePaths = precacheUrls
    .map(precacheUrlToBuildPath)
    .filter((path): path is string => path !== null);
const missingPrecacheTargets = precachePaths.filter((path) => !existsSync(path));
const precachedFiles = reportFiles(precachePaths);
const normalizedPrecacheUrls = precacheUrls.map((url) => `/${url.replace(/^\/+/, '')}`);
const duplicatePrecacheUrls = normalizedPrecacheUrls.filter(
    (url, index) => normalizedPrecacheUrls.indexOf(url) !== index,
);

const requiredOfflineAssets = [
    /\/_app\/immutable\/entry\/app\..+\.js$/,
    /\/_app\/immutable\/workers\/worker-.+\.js$/,
    /\/_app\/immutable\/workers\/chunks\/.+\.js$/,
    /\/_app\/immutable\/workers\/sqlite3-opfs-async-proxy-.+\.js$/,
    /\/_app\/immutable\/workers\/assets\/sqlite3-.+\.wasm$/,
    /\/_app\/immutable\/assets\/inter-latin-.+\.woff2$/,
    /\/_app\/immutable\/assets\/fira-code-latin-.+\.woff2$/,
];

const viteManifest = readViteManifest();
const serverManifest = existsSync(SERVER_MANIFEST_PATH)
    ? readFileSync(SERVER_MANIFEST_PATH, 'utf8')
    : '';
const launchFiles = viteManifest
    ? reportFiles(routeFirstLoadFiles(viteManifest, serverManifest, '/') ?? [])
    : [];
const financeFiles = viteManifest
    ? reportFiles(routeFirstLoadFiles(viteManifest, serverManifest, '/finance/[year]/[month]') ?? [])
    : [];
const launchJs = launchFiles.filter((file) => file.path.endsWith('.js'));
const financeJs = financeFiles.filter((file) => file.path.endsWith('.js'));
const precachePathSet = new Set(precachePaths.map((path) => relative(BUILD_DIR, path)));
const missingLaunchOfflineFiles = launchFiles.filter((file) =>
    !precachePathSet.has(relative(BUILD_DIR, file.path)),
);
const missingFinanceOfflineFiles = financeFiles.filter((file) =>
    !precachePathSet.has(relative(BUILD_DIR, file.path)),
);

const totalJs = sum(jsFiles, 'size');
const totalPrecache = sum(precachedFiles, 'size');
const totalPrecacheGzip = sum(precachedFiles, 'gzipSize');
const launchJsGzip = sum(launchJs, 'gzipSize');
const financeJsGzip = sum(financeJs, 'gzipSize');
const indexReport = readReport(INDEX_PATH);
const indexHtml = readFileSync(INDEX_PATH, 'utf8');
const manifestFiles = allBuildFiles.filter((path) =>
    /(?:^|\/)manifest\.(?:json|webmanifest)$/.test(path),
);

console.log('Build report');
console.log(`Immutable JS: ${formatBytes(totalJs)} across ${jsFiles.length} files`);
console.log(
    `Precache: ${formatBytes(totalPrecache)} raw, ${formatBytes(totalPrecacheGzip)} gzip-estimated across ${precacheUrls.length} entries`,
);
console.log(`Launch initial JS: ${formatBytes(launchJsGzip)} gzip-estimated`);
console.log(`Finance initial JS: ${formatBytes(financeJsGzip)} gzip-estimated`);
console.log(`index.html: ${formatBytes(indexReport.gzipSize)} gzip-estimated`);

if (totalPrecacheGzip > PRECACHE_GZIP_BUDGET) {
    fail(`[Budget] Precache exceeds ${formatBytes(PRECACHE_GZIP_BUDGET)} gzip-estimated.`);
}
if (precacheUrls.length > PRECACHE_ENTRY_BUDGET) {
    fail(`[Budget] Precache exceeds ${PRECACHE_ENTRY_BUDGET} entries.`);
}
if (launchJsGzip > LAUNCH_JS_GZIP_BUDGET) {
    fail(`[Budget] Launch initial JS exceeds ${formatBytes(LAUNCH_JS_GZIP_BUDGET)}.`);
}
if (financeJsGzip > FINANCE_JS_GZIP_BUDGET) {
    fail(`[Budget] Finance initial JS exceeds ${formatBytes(FINANCE_JS_GZIP_BUDGET)}.`);
}
if (indexReport.gzipSize > INDEX_GZIP_BUDGET) {
    fail(`[Budget] index.html exceeds ${formatBytes(INDEX_GZIP_BUDGET)}.`);
}
if (invalidPrecacheUrls.length > 0) {
    fail(`[Offline] Invalid precache URLs: ${invalidPrecacheUrls.join(', ')}`);
}
if (nonRootRelativePrecacheUrls.length > 0) {
    fail(`[Offline] Precache URLs must be root-relative: ${nonRootRelativePrecacheUrls.join(', ')}`);
}
if (missingPrecacheTargets.length > 0) {
    fail(`[Offline] ${missingPrecacheTargets.length} precache URLs do not map to deployed files.`);
}
if (duplicatePrecacheUrls.length > 0) {
    fail(`[Offline] Duplicate precache URLs: ${[...new Set(duplicatePrecacheUrls)].join(', ')}`);
}
for (const pattern of requiredOfflineAssets) {
    if (!normalizedPrecacheUrls.some((url) => pattern.test(url))) {
        fail(`[Offline] Required asset missing from precache: ${pattern}`);
    }
}
if (normalizedPrecacheUrls.some((url) => /\/sqlite3-worker1-.+\.js$/.test(url))) {
    fail('[Offline] The unused generic SQLite worker is still precached.');
}
if (missingLaunchOfflineFiles.length > 0) {
    fail(`[Offline] ${missingLaunchOfflineFiles.length} Launch first-load files are missing from precache.`);
}
if (missingFinanceOfflineFiles.length > 0) {
    fail(`[Offline] ${missingFinanceOfflineFiles.length} Finance first-load files are missing from precache.`);
}
if (manifestFiles.length !== 1 || basename(manifestFiles[0] ?? '') !== 'manifest.webmanifest') {
    fail(`[Manifest] Expected one manifest.webmanifest, found: ${manifestFiles.map((path) => relative(BUILD_DIR, path)).join(', ') || 'none'}`);
}
if ((indexHtml.match(/rel="manifest"/g) ?? []).length !== 1 || !indexHtml.includes('/manifest.webmanifest')) {
    fail('[Manifest] index.html must link exactly one /manifest.webmanifest.');
}
const textBuildFiles = allBuildFiles.filter((path) => /\.(?:js|css|html)$/.test(path));
const externalFontReference = textBuildFiles.some((path) => {
    const source = readFileSync(path, 'utf8');
    return /fonts\.(?:googleapis|gstatic)\.com/i.test(source) ||
        /@font-face\s*\{[^}]*url\(\s*["']?https?:\/\//is.test(source) ||
        /<link\b[^>]*\brel=["'](?:preconnect|stylesheet)["'][^>]*\bhref=["']https?:\/\//is.test(source);
});
if (externalFontReference) {
    fail('[Fonts] An external font or stylesheet origin remains in build output.');
}
if (!indexHtml.includes('id="stor-boot-shell"') || !indexHtml.includes('stor:app-mounted')) {
    fail('[Boot] The generated index.html is missing the static boot shell contract.');
}
if (existsSync(join(BUILD_DIR, 'registerSW.js'))) {
    fail('[PWA] registerSW.js should not be generated when registration is explicit.');
}

printFileTable(
    'Largest precached files',
    [...precachedFiles].sort((left, right) => right.gzipSize - left.gzipSize),
);
printFileTable(
    'Largest launch initial files',
    [...launchFiles].sort((left, right) => right.gzipSize - left.gzipSize),
);
printFileTable(
    'Largest Finance initial files',
    [...financeFiles].sort((left, right) => right.gzipSize - left.gzipSize),
);
