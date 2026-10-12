import { resolve } from 'node:path';

import { hearthlogConfig } from '../packages/tooling/src/vite/config.js';

// The platform's development site. Its unit tests are the platform packages' own (the paths below are from the
// checkout, `dir`). It installs no module. Tests that need modules run through `pnpm test:integration`,
// which links the published ones in for the run without adding them to package.json (HEARTHLOG_INTEGRATION=1).
const integration = process.env.HEARTHLOG_INTEGRATION === '1';
const needModules = [
	'packages/contracts/src/tenant/route-access.test.ts',
	'packages/runtime/src/db/entity-scope.test.ts',
	'packages/runtime/src/db/module-projections.test.ts',
	'packages/runtime/src/store/sync-invalidation.test.ts',
	'packages/runtime/src/store/sync-convergence.test.ts',
];

export default hearthlogConfig({
	test: {
		dir: resolve(import.meta.dirname, '..'),
		include: ['src/**/*.{test,spec}.{js,ts}', 'packages/czech/src/**/*.test.ts', 'packages/contracts/src/**/*.test.ts', 'packages/runtime/src/**/*.test.ts', 'packages/tooling/src/deploy/access-provisioning.test.ts', 'packages/cloudflare/src/**/*.test.ts'],
		// The sync tests open real SQLite databases; on a loaded CI runner five seconds is not enough.
		testTimeout: 30_000,
		exclude: integration ? ['**/node_modules/**'] : ['**/node_modules/**', ...needModules],
		alias: {
			// The runtime module exists only inside workerd.
			'cloudflare:workers': resolve(import.meta.dirname, '../packages/cloudflare/src/testing/cloudflare-workers.ts'),
		},
	},
});
