export interface PrecacheManifestEntry {
    url: string;
    revision?: string | null;
    size?: number;
    integrity?: string;
}

/**
 * Converts generated client URLs to their deployed, build-root-relative path.
 * SvelteKit's PWA build runs before adapter-static moves `client/*` into the
 * build root, so the prefix must be removed from the emitted manifest too.
 */
export function normalize(url: string): string {
    const withoutOrigin = url.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/i, '');
    return withoutOrigin
        .split(/[?#]/, 1)[0]
        .replace(/^\/+/, '')
        .replace(/^client\//, '');
}

export function toPrecacheUrl(url: string): string {
    return `/${normalize(url)}`;
}

export function normalizeManifestEntries<T extends PrecacheManifestEntry>(
    entries: T[],
): T[] {
    const entriesByUrl = new Map<string, T>();

    for (const entry of entries) {
        const normalizedEntry = { ...entry, url: toPrecacheUrl(entry.url) };
        const existing = entriesByUrl.get(normalizedEntry.url);
        if (!existing || (existing.revision == null && normalizedEntry.revision != null)) {
            entriesByUrl.set(normalizedEntry.url, normalizedEntry as T);
        }
    }

    return [...entriesByUrl.values()];
}

export function parseRouteNodeIds(serverManifest: string, routeIds: readonly string[]): number[] {
    const result = new Set<number>([0]);
    for (const routeId of routeIds) {
        const escaped = routeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = serverManifest.match(new RegExp(
            `id:\\s*"${escaped}"[\\s\\S]*?page:\\s*\\{\\s*layouts:\\s*\\[([^\\]]*)\\],\\s*errors:\\s*\\[([^\\]]*)\\],\\s*leaf:\\s*(\\d+)`,
        ));
        if (!match) continue;
        for (const layout of match[1].matchAll(/\d+/g)) result.add(Number(layout[0]));
        for (const error of match[2].matchAll(/\d+/g)) result.add(Number(error[0]));
        result.add(Number(match[3]));
    }
    return [...result];
}

export function isCanonicalSqliteWasm(url: string): boolean {
    return /^_app\/immutable\/workers\/assets\/sqlite3[.-][^/]+\.wasm$/.test(normalize(url));
}

export function isGenericSqliteWorker(url: string): boolean {
    return /^_app\/immutable\/workers\/sqlite3-worker1-[^/]+\.js$/.test(normalize(url));
}

function activeTenantId(): string {
    return process.env.VITE_STOR_TENANT?.trim() || 'st';
}

export function shouldPrecacheManifestEntry(
    entry: PrecacheManifestEntry,
    tenantId: string = activeTenantId(),
): boolean {
    const normalizedUrl = normalize(entry.url);

    if (/^_app\/immutable\/(?:workers\/)?assets\/sqlite3[.-][^/]+\.wasm$/.test(normalizedUrl)) {
        return isCanonicalSqliteWasm(normalizedUrl);
    }
    if (isGenericSqliteWorker(normalizedUrl)) return false;
    // Every tenant's icon set ships in static/, but a build installs only its own.
    const iconSet = /^icons\/([^/]+)\//.exec(normalizedUrl)?.[1];
    if (iconSet !== undefined) return iconSet === (tenantId?.trim() || 'st');
    // Install the complete app, including lazy route and overlay chunks. A
    // fresh device can then open any local page without visiting it online.
    return true;
}

/**
 * Files outside `$app/manifest`: the SPA fallback shell and the manifest the
 * tenant plugin emits at build time.
 */
export const PRECACHE_EXTRA_PATHS = ['/index.html', '/manifest.webmanifest'] as const;

const PRECACHE_FILE = /\.(?:js|mjs|css|html|ico|png|svg|woff2?|webmanifest|wasm)$/;

/**
 * The service worker's core precache list: build output, static files and
 * prerendered pages from `$app/manifest`, plus the SPA shell. The worker and
 * the build checks share this so they cannot disagree about what installs.
 */
export function precacheEntries(
    paths: readonly { path: string; revision: string | null }[],
    tenantId?: string,
): PrecacheManifestEntry[] {
    return normalizeManifestEntries(
        paths.map(({ path, revision }) => ({ url: path, revision })),
    )
        .filter((entry) => PRECACHE_FILE.test(entry.url))
        .filter((entry) => shouldPrecacheManifestEntry(entry, tenantId));
}

/** Reads the `$app/manifest` paths that Kit bundles into the built worker. */
export function parseServiceWorkerManifestPaths(serviceWorker: string): string[] {
    return Array.from(
        serviceWorker.matchAll(/\{\s*path\s*:\s*[`"']([^`"']+)[`"']\s*\}/g),
        (match) => match[1],
    );
}
