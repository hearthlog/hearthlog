/**
 * Module API v0: page lifecycle, the workspace clock, tenant identity, and
 * device-local settings. These re-export today's app code; when the platform
 * becomes real packages, modules keep importing `@hearthlog/sdk/runtime`.
 */
export { deferLocalPage, deferPage, providePageResource } from '@hearthlog/runtime/runtime/page-data.svelte.js';
export { appClock } from '@hearthlog/runtime/runtime/view.js';
export { tenant } from '@hearthlog/contracts/tenant/config';
export { get as getDeviceSetting, set as setDeviceSetting } from '@hearthlog/runtime/db/kv.js';
export { keepPageData } from '@hearthlog/runtime/runtime/kept-page-data.svelte.js';
export { refreshPageData } from '@hearthlog/runtime/runtime/refresh.js';
export { commandActionsAvailable, runCommandAction } from '@hearthlog/ui/state/commands.js';
export { contextualHref } from '@hearthlog/runtime/runtime/view.js';
export { REMINDER_HOUR } from '@hearthlog/runtime/native/reminders.js';
export { appearance } from '@hearthlog/runtime/theme/appearance.svelte.js';
export { attention } from '@hearthlog/runtime/store/attention.svelte.js';
export { notify } from '@hearthlog/ui/state/notifications.svelte.js';
export { isAiCapabilityEnabled, isFeatureEnabled } from '@hearthlog/contracts/tenant/config';
export { parsePositiveInt } from '@hearthlog/runtime/utils/address.js';
/** What a module loader receives: the URL, params, `depends`, and `parent` of the route. */
export type ModuleLoadEvent = Parameters<typeof import('@hearthlog/runtime/runtime/page-data.svelte.js').deferPage>[0];
export { sectionLinks } from '@hearthlog/contracts/features/navigation';
export { AccessSessionExpiredError, fetchAccessProtected } from '@hearthlog/runtime/access/session.js';
export { commandAvailability } from '@hearthlog/ui/state/commands.js';
export { syncAndWait } from '@hearthlog/runtime/store/sync.svelte.js';
export { db, requireActiveContext } from '@hearthlog/runtime/db/index.js';
export { currentPageResource } from '@hearthlog/ui/state/page-context.js';
export { phoneHeader } from '@hearthlog/runtime/runtime/phone-header.svelte.js';
export { events } from '@hearthlog/runtime/store/events.svelte.js';
export { longPress } from '@hearthlog/runtime/utils/long-press.js';
export type { PagePublisher } from '@hearthlog/runtime/runtime/page-data.svelte.js';
