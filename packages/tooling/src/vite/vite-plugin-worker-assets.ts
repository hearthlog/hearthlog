/**
 * Vite Plugin: Worker asset list for the service worker
 *
 * SvelteKit's `$app/manifest` lists the worker entry files but not the chunks
 * and WASM they load, because those are copied into the client output after the
 * service worker is bundled. The SQLite WASM worker needs all of them offline,
 * so `virtual:worker-assets` lists everything Kit emitted under
 * `_app/immutable/workers`.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { Plugin } from 'vite';

const VIRTUAL_ID = 'virtual:worker-assets';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

function listFiles(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? listFiles(path) : [path];
    });
}

export function workerAssetsPlugin(outDir: string): Plugin {
    const clientOutput = join(outDir, 'output', 'client');
    return {
        name: 'worker-assets',
        resolveId(id) {
            return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
        },
        load(id) {
            if (id !== RESOLVED_ID) return undefined;
            const paths = listFiles(join(clientOutput, '_app', 'immutable', 'workers'))
                .map((file) => ({ path: relative(clientOutput, file).split('\\').join('/') }))
                .sort((left, right) => left.path.localeCompare(right.path));
            return `export const workerAssets = ${JSON.stringify(paths)};`;
        },
    };
}
