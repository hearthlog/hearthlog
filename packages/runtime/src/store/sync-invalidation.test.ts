import { describe, expect, it } from 'vitest';

import { SYNC_INVALIDATION_TARGETS } from './sync-invalidation.js';

describe('sync invalidation targets', () => {
    it('refreshes every route data dependency after realtime event application', () => {
        expect(new Set(SYNC_INVALIDATION_TARGETS)).toEqual(new Set([
            'app:history',
            'app:assets',
            'app:budgets',
            'app:activities',
            'app:calendar',
            'app:calories',
            'app:entities',
            'app:entity-types',
            'app:foods',
            'app:invoices',
            'app:gallery',
            'app:developer',
            'app:transactions',
            'app:weight-logs',
        ]));
    });
});

it('covers every literal route data dependency', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    async function visit(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) { if (entry.name !== 'node_modules') await visit(path); continue; }
            if (!entry.name.endsWith('.ts')) continue;
            const source = await readFile(path, 'utf8');
            for (const match of source.matchAll(/\bdepends\(['"](app:[^'"]+)['"]\)/g)) {
                expect(SYNC_INVALIDATION_TARGETS, `${path} depends on ${match[1]}`).toContain(match[1]);
            }
        }
    }
    await visit('.generated/routes');
    // Module loaders declare their keys in hearthlog.module.json: the modules of a checkout, or the ones a workspace installs.
    const { existsSync } = await import('node:fs');
    if (existsSync('modules')) await visit('modules');
    else for (const entry of await readdir('node_modules/@hearthlog')) if (entry.startsWith('module-')) await visit(join('node_modules/@hearthlog', entry, 'src'));
});
