/** Module API v0: endless date lists and the one-day pager. */
export { BucketStore, type BucketLoader } from '@hearthlog/ui/components/endless/bucket-store.svelte.js';
export * from '@hearthlog/ui/utils/endless-axis.js';
export { default as DayPager } from '@hearthlog/ui/components/endless/DayPager.svelte';
export { default as EndlessList } from '@hearthlog/ui/components/endless/EndlessList.svelte';
// The list's types live in the component's module script, which tsc cannot read; Svelte erases them.
// @ts-expect-error tsc sees only a default export from a .svelte file
export type { EndlessBlock, EndlessPosition, EndlessTarget, EndlessView } from '@hearthlog/ui/components/endless/EndlessList.svelte';
