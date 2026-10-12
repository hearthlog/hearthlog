import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { createPreviewDatabaseFixture } from './preview-database-fixture';

const root = resolve(process.env.STOR_BUILD_OUTPUT_ROOT ?? 'build');
const port = Number(process.env.PORT ?? 4173);
const databaseFixture = createPreviewDatabaseFixture();
const staticAssetHeaders = readUniversalStaticAssetHeaders();
const serviceWorkerUpdate = Buffer.concat([
    readFileSync(join(root, 'service-worker.js')),
    Buffer.from('\n/* production-preview update fixture */\n'),
]);
let serveUpdatedServiceWorker = false;

const contentTypes: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.woff2': 'font/woff2',
};

function readUniversalStaticAssetHeaders(): Record<string, string> {
    const lines = readFileSync(join(root, '_headers'), 'utf8').split(/\r?\n/);
    const universalRule = lines.findIndex((line) => line.trim() === '/*');
    if (universalRule === -1) {
        throw new Error('The built _headers file must define a /* rule');
    }

    const headers: Record<string, string> = {};
    for (const line of lines.slice(universalRule + 1)) {
        if (line.trim() === '') continue;
        if (!/^\s/.test(line)) break;

        const separator = line.indexOf(':');
        if (separator === -1) {
            throw new Error(`Invalid header rule: ${line.trim()}`);
        }
        headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
    return headers;
}

function resolveRequestPath(pathname: string): string | null {
    const decoded = decodeURIComponent(pathname);
    const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const candidate = resolve(root, normalize(requested));
    if (!candidate.startsWith(`${root}/`) && candidate !== root) return null;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;

    // Match Cloudflare's single-page-application not-found handling.
    if (!extname(decoded)) return join(root, 'index.html');
    return null;
}

const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (url.pathname === '/__test__/stor.sqlite3') {
        response.writeHead(200, {
            'content-type': 'application/vnd.sqlite3',
            'content-length': databaseFixture.byteLength,
            'cache-control': 'no-store',
            'cross-origin-resource-policy': 'same-origin',
        });
        response.end(databaseFixture);
        return;
    }
    if (url.pathname === '/__test__/activate-sw-update') {
        serveUpdatedServiceWorker = true;
        response.writeHead(204, {
            'cache-control': 'no-store',
            'cross-origin-resource-policy': 'same-origin',
        });
        response.end();
        return;
    }
    if (url.pathname === '/service-worker.js' && serveUpdatedServiceWorker) {
        response.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'content-length': serviceWorkerUpdate.byteLength,
            'cache-control': 'no-store',
            'cross-origin-resource-policy': 'same-origin',
            ...staticAssetHeaders,
        });
        response.end(serviceWorkerUpdate);
        return;
    }
    const file = resolveRequestPath(url.pathname);
    if (!file) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
    }

    const extension = extname(file);
    const immutable = file.includes(`${join('_app', 'immutable')}${process.platform === 'win32' ? '\\' : '/'}`);
    response.writeHead(200, {
        'content-type': contentTypes[extension] ?? 'application/octet-stream',
        'cache-control': immutable
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=0, must-revalidate',
        ...staticAssetHeaders,
    });
    createReadStream(file).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Production preview listening on http://127.0.0.1:${port}`);
});
