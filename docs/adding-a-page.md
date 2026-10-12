# Adding a custom page

Body (`modules/health/src/pages/body.svelte`: the `weightlog` entity and its `weight-logs` repository, in the Health module) is a small working page. Richer pages keep their own repositories and components; generated data APIs are optional conveniences.

1. Register the route's feature/page metadata in `packages/contracts/src/features/registry.ts` and its icon in `packages/shell/src/components/layout/feature-icons.ts`. The existing route guard derives access from the active tenant's enabled features. Do not use navigation visibility as the only access check.
2. Create `<module>/src/pages/<page>.ts` (a module's page; a site's own page goes in `src/routes/<page>/+page.ts`). Declare a refresh dependency, return an immediate empty shape, and load through `queryDatabase` inside `deferPage`:

```ts
import type { PageLoad } from './$types';
import type { GalleryAlbum } from '#lib/db/schema.generated.js';
import { deferPage } from '#lib/runtime/page-data.svelte.js';
import { queryDatabase } from '#lib/db/read-repositories.js';

export const load = ((event) => {
    event.depends('app:gallery');
    return deferPage(event, { albums: [] as GalleryAlbum[] }, async () => ({
        albums: await queryDatabase(repositories => repositories.records.galleryAlbum.list()),
    }));
}) satisfies PageLoad;
```

3. In `+page.svelte`, derive `routeData.pageResource`, pass it to `providePageResource`, render `PageDataStatus`, and read `resource.data`. This retains the current loading/error/refresh behavior.
4. Put mutation controls inside `CommandOnly`. Call a command from the event handler, surface errors, and await `refreshPageData('app:gallery')` after success. Keep a busy guard through the whole save.
5. Add the dependency to `packages/runtime/src/store/sync-invalidation.ts`. Its test compares actual route dependencies with the registered list. Local page refresh and remote synchronization refresh must reach the same page.
6. For date-sensitive pages, use the active workspace clock where a shared date boundary matters. Use scoped repositories instead of importing the live database directly into a page load. Custom repository reads go through `session.selectFrom(table)` or `session.table(table)`; the session applies the tenant/log scope, so never add `tenant_id` / `log_id` predicates yourself.
7. Add its route to the page list in `tests/production/first-load.spec.ts`. Unit tests and browser journeys are only for data, access, money, and core workflows; see [Test portfolio](testing-strategy.md).

Use the shared [page UX patterns](ux-patterns.md) for headers, navigation,
period controls, panels, actions, and states. No generated design system or
universal page factory is required.

## Adding an endless list

An endless list scrolls through date blocks (months, for example) with no
pages, reading each block from SQL as it scrolls into view. Finance
transactions (`modules/finance/src/components/finance/EndlessTimeline.svelte`, one block
per month), Calendar (`packages/shell/src/pages/calendar/Page.svelte`, one block per
week, read in six-week chunks), Gallery
(`modules/gallery/src/components/gallery/GalleryTimeline.svelte`, one block per month
that holds photos) are the working examples. The Health day pages (Day,
Nutrition, Activity) use the same axis and store but show one day at a time,
sideways: `DayPager` (`packages/ui/src/components/endless/DayPager.svelte`) through
`HealthDaysList`, with `dayAxis` from `endless-axis.ts` and the loaders in
`modules/health/src/health/day-blocks.ts`, `modules/health/src/calories/page-data.ts` and
`modules/health/src/activities/page-data.ts`. Days have a fixed width, so the pager needs
no height estimate: it draws the day in view and one either side, and every
swipe ends on a day. A day lays itself out by its own width (container queries
from 32rem), not the viewport.

1. Pick an axis from `packages/ui/src/utils/endless-axis.ts`: `monthAxis`,
   `weekAxis`, or `stepAxis` for other steps, or `listAxis` for keys read from
   SQL (only the months that hold photos, for example). Keys must sort in
   order. The axis may grow at its end while the list is open, but its keys
   never move; when a key appears or leaves in the middle, key the list on it
   and open it again at the place in view, as Gallery does.
2. Extend `BucketStore` (`packages/ui/src/components/endless/bucket-store.svelte.ts`)
   with a loader that reads a batch of keys in one `queryDatabase` session and
   returns the blocks by key. Filtering, totals, grouping, and layout such as
   which days a multi-day item covers stay in SQL. Override `ensure` and
   `refresh` to widen the keys when small blocks should load in chunks.
3. Render `EndlessList` with the axis, the store, an `opening` target, an
   `estimate` of a block's height, and the page's `revision` so saves and
   syncs re-read the blocks on screen. When blocks differ a lot in size, pass
   `estimate` as a function of the key, computed from SQL counts; the list
   then opens in the right place before anything loads. The `item` snippet draws a block; its
   data is missing while it loads, so draw a placeholder of about the
   estimated height.
4. Scroll with `scrollTo({ key, at, find, ratio })`. Pass `home` for a
   floating way back (Today) and `pick` to name the place in view, and follow
   it in the address with a shallow `goto(..., { replace: true })` from `onVisibleChange`.
5. Give the list a height; it scrolls itself. On smaller screens the page may
   scroll around it, and the list accounts for that. A page that fits the
   screen from `lg` is listed in `pageFitsScreen` in `packages/shell/src/pages/layout/Layout.svelte`.
6. Keep the loaded page on screen while it refreshes. A page with an endless
   list reads its day-independent data in `+page.ts` (the opening day comes from
   `?date=`), wraps its resource in `keepPageData`
   (`packages/runtime/src/runtime/kept-page-data.svelte.ts`) so a save or a link to another
   day swaps data without a skeleton, and passes the counter it returns as the
   list's `revision`. Anything beside the list that follows the day in view (a
   week strip, a side panel) reads through `WeekFollower`
   (`modules/health/src/health/week-follow.svelte.ts`), which keeps weeks already seen.

Finance also passes `anchorSelector` for its keyed transaction rows and Today
line. The list captures visible elements through `BucketStore.beforePublish`
before new data reaches the rendering snippet, measures the updated blocks,
and restores the first surviving element's position within the scroller.
Manual scrolling and explicit jumps cancel a pending correction. An optional
`openingPlaceholder` snippet keeps a stationary skeleton visible until the
opening window has loaded, been measured, and reached its target. These options
are currently enabled for Finance only; routine refreshes retain loaded content.

## Adding a calculator

Calculators live under the Calculator section. A calculator that keeps its
inputs stores them on the device (KV), not in events. `/calc` is the income
calculator; `/calc/dates` is the date calculator, which saves nothing.

The Calculator is a module (`modules/calc/`, see [Modules](modules.md)); it
imports the app only through `@hearthlog/sdk`.

1. Add an entry to `CALCULATORS` in `modules/calc/src/calculators.ts` with a
   route under `/calc/<id>` and, if it keeps its inputs, its own `storageKey`.
   Add the route (`src/pages/<id>.svelte`, plus `<id>.ts` for a loader) and the
   sidebar child to `modules/calc/hearthlog.module.json`, then run
   `pnpm generate:modules`. With two or more entries the page header shows
   calculator tabs and the sidebar lists them as sub-pages.
2. Put the pure model in `modules/calc/src/<id>.ts` (inputs, defaults,
   `parse…`/`validate…`, the calculation).
3. With a `storageKey`, load with `deferLocalPage(url, defaults, () => loadCalculatorSettings(calculator, parse))`,
   create a `CalculatorDraft` in the page, hydrate it from `resource.data`, and
   run `$effect(() => draft.listen())` so edits save after a short pause and on
   page hide. A calculator that saves nothing needs no loader.
4. Render `CalculatorPageHeader` with the calculator's `active` id, then the
   calculator component in `modules/calc/src/components/`.
