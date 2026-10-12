/**
 * Vite Plugin: Entity Generator
 * 
 * Watches entity-definitions.ts and auto-regenerates types on change.
 * This provides a better DX by eliminating the need to manually run
 * `pnpm generate:entities` during development.
 */

import type { Plugin } from 'vite';
import { spawn } from 'child_process';
import path from 'path';

let isGenerating = false;

export function entityGeneratorPlugin(): Plugin {
    return {
        name: 'entity-generator',
        configureServer(server) {
            const entityDefsPath = path.resolve('packages/contracts/src/event/entity-definitions.ts');

            // Add the file to the watcher
            server.watcher.add(entityDefsPath);

            server.watcher.on('change', (changedPath) => {
                // Normalize paths for comparison
                const normalizedChanged = path.normalize(changedPath);
                const normalizedTarget = path.normalize(entityDefsPath);

                if (normalizedChanged === normalizedTarget && !isGenerating) {
                    isGenerating = true;
                    console.log('\n[entity-gen] 🔄 Regenerating entity types...');

                    const startTime = Date.now();
                    const child = spawn('pnpm', ['generate:entities'], {
                        stdio: 'pipe',
                        shell: true,
                        cwd: process.cwd()
                    });

                    child.stdout?.on('data', (data) => {
                        const output = data.toString().trim();
                        if (output) console.log(`[entity-gen] ${output}`);
                    });

                    child.stderr?.on('data', (data) => {
                        const output = data.toString().trim();
                        if (output) console.error(`[entity-gen] ❌ ${output}`);
                    });

                    child.on('close', (code) => {
                        const elapsed = Date.now() - startTime;
                        if (code === 0) {
                            console.log(`[entity-gen] ✅ Done in ${elapsed}ms`);
                        } else {
                            console.error(`[entity-gen] ❌ Failed with code ${code}`);
                        }
                        isGenerating = false;
                    });

                    child.on('error', (err) => {
                        console.error(`[entity-gen] ❌ Failed to start: ${err.message}`);
                        isGenerating = false;
                    });
                }
            });

            console.log('[entity-gen] 👀 Watching entity-definitions.ts for changes');
        },
    };
}
