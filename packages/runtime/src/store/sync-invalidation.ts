import { CORE_REFRESH_KEYS } from '@hearthlog/contracts/features/core';
import { MODULE_REFRESH_KEYS } from '#generated/modules';

/**
 * Route data dependencies that must be refreshed after local or remote event
 * application: the core's own keys (`src/lib/features/core.ts`) and the keys
 * modules declare in `hearthlog.module.json`. Keep both in sync with every
 * `depends('app:…')` declaration in route and module loaders.
 */
export const SYNC_INVALIDATION_TARGETS: readonly string[] = [...CORE_REFRESH_KEYS, ...MODULE_REFRESH_KEYS];
