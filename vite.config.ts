import { resolve } from 'node:path';

import { hearthlogConfig } from './packages/tooling/src/vite/config.js';

// This repository is the platform's workspace: the `st` site here installs the published modules from npm, and the tests are the packages' own.
export default hearthlogConfig({
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}', 'packages/czech/src/**/*.test.ts', 'packages/contracts/src/**/*.test.ts', 'packages/runtime/src/**/*.test.ts', 'packages/tooling/src/deploy/access-provisioning.test.ts', 'packages/cloudflare/src/**/*.test.ts'],
		alias: {
			// The runtime module exists only inside workerd.
			'cloudflare:workers': resolve(import.meta.dirname, 'packages/cloudflare/src/testing/cloudflare-workers.ts'),
		},
	},
});
