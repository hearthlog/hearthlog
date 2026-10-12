import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import Icons from 'unplugin-icons/vite'
import { entityGeneratorPlugin } from './vite-plugin-entity-gen.js';
import { tenantManifestPlugin } from './vite-plugin-tenant-manifest.js';
import { workerAssetsPlugin } from './vite-plugin-worker-assets.js';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { localGatewayOriginAllowed, readLocalLedgerCredentialSync } from '../dev/local-development.js';
import {
	e2eLedgerStubPlugin,
	localAiDecisionsPlugin,
	localInvoiceExtractionPlugin,
	localInvoicePdfGatewayFallbackPlugin,
	localInvoiceRendererPath,
	localLedgerGatewayPath,
	localLedgerOriginGuardPlugin,
	localReceivedInvoiceFilesPlugin,
} from './dev-plugins.js';

import { defineConfig, type ProxyOptions, type UserConfig } from 'vite';

/** The `@hearthlog/*` packages the site depends on (the platform and its modules). */
function hearthlogDependencies(): string[] {
	try {
		const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
		return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) => name.startsWith('@hearthlog/') && name !== '@hearthlog/generated');
	} catch {
		return [];
	}
}

function installedVersion(name: string): string {
	try {
		return JSON.parse(readFileSync(join('node_modules', name, 'package.json'), 'utf8')).version;
	} catch {
		return 'unknown';
	}
}

function gitOutput(...args: string[]): string {
	try {
		return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return '';
	}
}

const stackInfo = {
	packages: Object.fromEntries(
		[
			'svelte',
			'@sveltejs/kit',
			'vite',
			'typescript',
			'tailwindcss',
			'bits-ui',
			'@tanstack/svelte-table',
			'@tanstack/svelte-virtual',
			'kysely',
			'sqlocal',
			'date-fns',
		].map((name) => [name, installedVersion(name)]),
	),
	node: process.version.replace(/^v/, ''),
	commit: gitOutput('rev-parse', '--short', 'HEAD'),
	branch: gitOutput('rev-parse', '--abbrev-ref', 'HEAD'),
	dirty: gitOutput('status', '--porcelain', '--untracked-files=no') !== '',
};

const buildTimestamp = process.env.STOR_BUILD_TIMESTAMP?.trim() || new Date().toISOString();
// Tenant build selection: VITE_STOR_TENANT=bravo writes the site into
// build/bravo (matching wrangler env.bravo assets.directory). The default
// tenant keeps the historical ./build output used by the top-level Worker.
const tenantId = process.env.VITE_STOR_TENANT?.trim() || 'st';
const buildDirectory = process.env.STOR_BUILD_OUTPUT_ROOT?.trim() ||
	(tenantId === 'st' ? 'build' : `build/${tenantId}`);
const svelteKitOutDir = process.env.STOR_SVELTEKIT_OUT_DIR?.trim() || '.svelte-kit';
// `pnpm build:generated` writes the site's boot shell and tenant module under .generated/sites/<id>/.
const appTemplate = `.generated/sites/${tenantId}/app.html`;
// The host files `pnpm build:generated` writes (see tooling/src/host/write-host.ts).
const hostFiles = {
	routes: '.generated/routes',
	serviceWorker: '.generated/service-worker',
	assets: '.generated/static',
	appTemplate,
};
const tenantGeneratedModule = `.generated/sites/${tenantId}/tenant.ts`;

/**
 * Read a Worker-style secret for the local dev proxy. Vite only exposes
 * `VITE_`-prefixed values to the client, so server-only credentials come from
 * the process environment or the gitignored `.dev.vars` / `.env` files.
 */
function readDevVar(name: string): string | undefined {
	const fromEnvironment = process.env[name]?.trim();
	if (fromEnvironment) return fromEnvironment;
	for (const file of ['.dev.vars', '.env']) {
		try {
			const line = readFileSync(file, 'utf8')
				.split('\n')
				.find((entry) => entry.trimStart().startsWith(`${name}=`));
			if (!line) continue;
			const value = line.slice(line.indexOf('=') + 1).trim();
			if (value) return value.replace(/^(['"])(.*)\1$/, '$2');
		} catch {
			// The file is optional; try the next source.
		}
	}
	return undefined;
}

export interface HearthlogConfigOptions {
	/** Vitest options; only the repository that tests its packages passes them. */
	test?: Record<string, unknown>;
}

/**
 * The Vite configuration of a Hearthlog site: SvelteKit with the static adapter, Tailwind, icons, the site's
 * manifest and entity plugins, and the local development stand-ins for the gateway Worker. A site's
 * `vite.config.ts` calls this and nothing else.
 */
export function hearthlogConfig(options: HearthlogConfigOptions = {}) {
return defineConfig(({ command, mode }): UserConfig => {
	const localLedgerCredential =
		command === 'serve' && mode === 'development'
			? readLocalLedgerCredentialSync()
			: undefined;
	const isE2E = process.env.VITE_E2E === '1';
	const usesSameOriginLedger = Boolean(localLedgerCredential) || isE2E;
	// The dev proxy needs both: the renderer's address and its bearer token (from .dev.vars or the environment).
	const invoiceRendererOrigin = readDevVar('INVOICE_RENDERER_ORIGIN');
	const invoiceRendererToken =
		command === 'serve' && mode === 'development' && invoiceRendererOrigin
			? readDevVar('INVOICE_RENDERER_TOKEN')
			: undefined;

	const localLedgerProxy: Record<string, ProxyOptions> = localLedgerCredential
		? {
				[localLedgerGatewayPath]: {
					target: localLedgerCredential.baseUrl,
					changeOrigin: false,
					ws: true,
					rewrite: (path) =>
						path.slice(localLedgerGatewayPath.length) || '/',
					configure: (proxy) => {
						proxy.on('proxyReq', (proxyRequest, request) => {
							if (
								!localGatewayOriginAllowed(
									request.headers.origin,
									request.headers.host,
								)
							) {
								proxyRequest.destroy();
								return;
							}
							proxyRequest.setHeader(
								'Authorization',
								`Bearer ${localLedgerCredential.token}`,
							);
							// The deployed Worker stamps the verified Access email; locally
							// there is no Access, so use the same identity the client shows.
							proxyRequest.setHeader('X-Ledger-Actor', 'local@localhost');
							proxyRequest.removeHeader('Origin');
						});
						proxy.on('proxyReqWs', (proxyRequest, request) => {
							if (
								!localGatewayOriginAllowed(
									request.headers.origin,
									request.headers.host,
								)
							) {
								proxyRequest.destroy();
								return;
							}
							proxyRequest.setHeader(
								'Authorization',
								`Bearer ${localLedgerCredential.token}`,
							);
							proxyRequest.removeHeader('Origin');
						});
					},
				},
			}
		: {};
	const localInvoiceRendererProxy: Record<string, ProxyOptions> =
		invoiceRendererToken
			? {
				[localInvoiceRendererPath]: {
					target: invoiceRendererOrigin as string,
					changeOrigin: true,
					configure: (proxy) => {
						proxy.on('proxyReq', (proxyRequest, request) => {
							if (
								!localGatewayOriginAllowed(
									request.headers.origin,
									request.headers.host,
								)
							) {
								proxyRequest.destroy();
								return;
							}
							proxyRequest.setHeader(
								'Authorization',
								`Bearer ${invoiceRendererToken}`,
							);
							proxyRequest.removeHeader('Origin');
							proxyRequest.removeHeader('Referer');
						});
					},
				},
			}
		: {};
	const e2eLedgerProxy = isE2E ? {} : localLedgerProxy;
	const devServerProxy =
		(localLedgerCredential && !isE2E) || invoiceRendererToken
			? { proxy: { ...e2eLedgerProxy, ...localInvoiceRendererProxy } }
			: undefined;

	return {
		define: {
			__BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
			__STACK_INFO__: JSON.stringify(stackInfo),
			// The browser always uses a same-origin gateway. The ignored
			// deployment credential stays in the Vite server process.
			...(usesSameOriginLedger
				? {
						'import.meta.env.VITE_LEDGER_SERVICE_URL':
							JSON.stringify(localLedgerGatewayPath),
					}
				: {}),
			...(usesSameOriginLedger || command === 'build'
				? { 'import.meta.env.VITE_LEDGER_AUTH_TOKEN': 'undefined' }
				: {}),
		},
		server: {
			...devServerProxy,
			// Module and SDK sources live outside src/; Kit's default list omits them.
			fs: { allow: [resolve('modules'), resolve('packages')] }
		},
		resolve: {
			alias: {
				// Dedicated namespace so a tenant build can swap in its generated module.
				'$tenant/generated': resolve(tenantGeneratedModule),
			},
		},
		cacheDir: process.env.STOR_VITE_CACHE_DIR?.trim() || 'node_modules/.vite',
        plugins: [
                tailwindcss(),
                sveltekit({
                        preprocess: vitePreprocess({ script: true }),
                        outDir: svelteKitOutDir,
                        files: hostFiles,
                        // Registration is deliberately scheduled by #lib/pwa/registration
                        // after local-store bootstrap; Kit's eager registration would
                        // bypass it.
                        serviceWorker: {
                                register: false
                        },
                        adapter: adapter({
                                pages: buildDirectory,
                                assets: buildDirectory,
                                fallback: 'index.html'
                        }),
                        compilerOptions: {
                                experimental: {
                                        async: true
                                },
                                warningFilter: (warning) => !warning.filename?.includes('node_modules') && !warning.code.startsWith('a11y')
                        }
                }),
                entityGeneratorPlugin(),
                tenantManifestPlugin(),
                workerAssetsPlugin(svelteKitOutDir),
                localLedgerOriginGuardPlugin(Boolean(localLedgerCredential)),
                localInvoicePdfGatewayFallbackPlugin(Boolean(invoiceRendererToken)),
                localReceivedInvoiceFilesPlugin(),
                localInvoiceExtractionPlugin(),
                localAiDecisionsPlugin(isE2E),
                e2eLedgerStubPlugin(isE2E),
                Icons({
			compiler: 'svelte',
		}),
		{
			name: 'configure-response-headers',
			configureServer: (server) => {
				server.middlewares.use((_req, res, next) => {
					res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
					res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
					next();
				});
			},
			configurePreviewServer: (server) => {
				server.middlewares.use((_req, res, next) => {
					res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
					res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
					next();
				});
			},
		},
	],
	optimizeDeps: {
		// The platform and the modules ship Svelte and TypeScript source; installed from the registry they sit in node_modules,
		// where the dependency scan cannot resolve their relative imports. They are compiled with the site, not pre-bundled.
		exclude: ['sqlocal', 'microlighter', ...hearthlogDependencies()]
	},
	build: {
		// Bundle Microlighter's lazy grammars, which Vite skips in dependencies by default.
		dynamicImportVarsOptions: {
			exclude: [/node_modules\/(?!microlighter\/|\.pnpm\/microlighter@)/],
		},
	},
	worker: {
		format: "es"
	},
		...(options.test ? { test: options.test } : {}),
	};
});
}
