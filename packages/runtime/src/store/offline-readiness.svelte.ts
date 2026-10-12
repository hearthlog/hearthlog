export type OfflineReadinessPhase =
    | 'checking'
    | 'installing'
    | 'available'
    | 'unavailable'
    | 'unsupported'
    | 'failed';

export interface OfflineReadinessState {
    phase: OfflineReadinessPhase;
    errorMessage: string | null;
    checkedAt: number | null;
}

interface CacheRequirement {
    label: string;
    path: RegExp;
    contentType: RegExp;
}

interface OfflineReadinessDependencies {
    serviceWorker?: Pick<ServiceWorkerContainer, 'getRegistration'> | null;
    cacheStorage?: CacheStorage | null;
    now?: () => number;
}

const REQUIRED_CORE_CACHE_ENTRIES: readonly CacheRequirement[] = [
    { label: 'application fallback', path: /\/index\.html$/, contentType: /text\/html/i },
    {
        label: 'application entry',
        path: /\/_app\/immutable\/entry\/app\.[^/]+\.js$/,
        contentType: /(?:java|ecma)script/i,
    },
    {
        label: 'SQLocal worker',
        path: /\/_app\/immutable\/workers\/worker-[^/]+\.js$/,
        contentType: /(?:java|ecma)script/i,
    },
    {
        label: 'SQLocal worker chunk',
        path: /\/_app\/immutable\/workers\/chunks\/[^/]+\.js$/,
        contentType: /(?:java|ecma)script/i,
    },
    {
        label: 'SQLite OPFS proxy',
        path: /\/_app\/immutable\/workers\/sqlite3-opfs-async-proxy-[^/]+\.js$/,
        contentType: /(?:java|ecma)script/i,
    },
    {
        label: 'SQLite WASM',
        path: /\/_app\/immutable\/workers\/assets\/sqlite3[.-][^/]+\.wasm$/,
        contentType: /application\/wasm/i,
    },
];

export const offlineReadiness = $state<OfflineReadinessState>({
    phase: 'checking',
    errorMessage: null,
    checkedAt: null,
});

function updateOfflineReadiness(
    phase: OfflineReadinessPhase,
    errorMessage: string | null,
    checkedAt: number | null = Date.now(),
): void {
    offlineReadiness.phase = phase;
    offlineReadiness.errorMessage = errorMessage;
    offlineReadiness.checkedAt = checkedAt;
}

export function markOfflineReadinessInstalling(): void {
    updateOfflineReadiness('installing', null, null);
}

export function markOfflineReadinessFailed(error: unknown): void {
    updateOfflineReadiness(
        'failed',
        error instanceof Error ? error.message : 'The offline bundle could not be installed.',
    );
}

export async function checkOfflineReadiness(
    dependencies: OfflineReadinessDependencies = {},
): Promise<void> {
    const serviceWorker = dependencies.serviceWorker === undefined
        ? (typeof navigator !== 'undefined' && 'serviceWorker' in navigator
            ? navigator.serviceWorker
            : undefined)
        : dependencies.serviceWorker ?? undefined;
    const cacheStorage = dependencies.cacheStorage === undefined
        ? (typeof caches !== 'undefined' ? caches : undefined)
        : dependencies.cacheStorage ?? undefined;
    const now = dependencies.now ?? Date.now;

    if (!serviceWorker || !cacheStorage) {
        updateOfflineReadiness('unsupported', 'Offline caching is not supported by this browser.', now());
        return;
    }

    updateOfflineReadiness('checking', null, null);

    try {
        const registration = await serviceWorker.getRegistration();
        if (!registration) {
            updateOfflineReadiness('unavailable', 'No service worker is registered yet.', now());
            return;
        }
        if (!registration.active) {
            updateOfflineReadiness('installing', null, now());
            return;
        }

        const cacheNames = (await cacheStorage.keys()).filter((name) => name.includes('precache'));
        const cachedRequests = (
            await Promise.all(cacheNames.map(async (cacheName) => {
                const cache = await cacheStorage.open(cacheName);
                return (await cache.keys()).map((request) => ({ cache, request }));
            }))
        ).flat();

        const missing: string[] = [];
        for (const requirement of REQUIRED_CORE_CACHE_ENTRIES) {
            const match = cachedRequests.find(({ request }) =>
                requirement.path.test(new URL(request.url).pathname),
            );
            if (!match) {
                missing.push(requirement.label);
                continue;
            }

            const response = await match.cache.match(match.request);
            if (!response) {
                missing.push(requirement.label);
                continue;
            }

            const contentType = response.headers.get('content-type') ?? '';
            if (!requirement.contentType.test(contentType)) {
                updateOfflineReadiness(
                    'failed',
                    `${requirement.label} has an invalid content type (${contentType || 'missing'}).`,
                    now(),
                );
                return;
            }
        }

        if (missing.length > 0) {
            updateOfflineReadiness(
                'unavailable',
                `Offline bundle is missing: ${missing.join(', ')}.`,
                now(),
            );
            return;
        }

        for (const { cache, request } of cachedRequests) {
            if (!new URL(request.url).pathname.endsWith('.js')) continue;
            const response = await cache.match(request);
            if (!response) {
                updateOfflineReadiness(
                    'unavailable',
                    `Offline bundle is missing cached JavaScript: ${new URL(request.url).pathname}.`,
                    now(),
                );
                return;
            }
            const contentType = response.headers.get('content-type') ?? '';
            if (!/(?:java|ecma)script/i.test(contentType)) {
                updateOfflineReadiness(
                    'failed',
                    `Cached JavaScript has an invalid content type (${contentType || 'missing'}).`,
                    now(),
                );
                return;
            }
        }

        updateOfflineReadiness('available', null, now());
    } catch (error) {
        updateOfflineReadiness(
            'failed',
            error instanceof Error ? error.message : 'Offline readiness could not be checked.',
            now(),
        );
    }
}
