/**
 * Vite Plugin: Tenant Web App Manifest
 *
 * Serves and emits /manifest.webmanifest for the tenant selected with
 * VITE_STOR_TENANT, so each installed app gets its own name, theme colour, and
 * icon set (tenants/<site-id>/static/icons/<site-id>/, see packages/tooling/src/generate/generate-brand-icons.ts).
 */

import type { Plugin } from 'vite';

import { themeVariablesFor } from '../../../contracts/src/tenant/theme.js';
import { activeSiteId } from '../root.js';
import { loadTenantConfig, siteById } from '../tenants/tenant-config.js';

const MANIFEST_PATH = '/manifest.webmanifest';

async function manifestJson(siteId: string): Promise<string> {
    const { sites } = await loadTenantConfig(undefined, { only: siteId });
    const site = siteById(sites, siteId);
    const color = themeVariablesFor(site.theme.accent, 'light')['--stor-theme-color'];
    const icons = `/icons/${site.id}`;
    return JSON.stringify(
        {
            name: site.title,
            short_name: site.title,
            id: site.title.trim().toLowerCase(),
            start_url: '/',
            scope: '/',
            display: 'standalone',
            theme_color: color,
            background_color: color,
            icons: [
                { src: `${icons}/pwa-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
                { src: `${icons}/pwa-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
                { src: `${icons}/maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            ],
        },
        null,
        2,
    );
}

export function tenantManifestPlugin(): Plugin {
    const siteId = activeSiteId();
    return {
        name: 'tenant-manifest',
        configureServer(server) {
            server.middlewares.use(MANIFEST_PATH, async (_request, response) => {
                response.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
                response.end(await manifestJson(siteId));
            });
        },
        async generateBundle() {
            if (this.environment?.name !== 'client') return;
            this.emitFile({
                type: 'asset',
                fileName: MANIFEST_PATH.slice(1),
                source: await manifestJson(siteId),
            });
        },
    };
}
