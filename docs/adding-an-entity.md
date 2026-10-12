# Adding an entity

Use Gallery albums as the executable example: the `gallery_album` definition in `packages/contracts/src/event/entity-definitions.ts`, the generated `galleryAlbumCommands` and `repositories.records.galleryAlbum`, and `src/lib/components/gallery/AlbumSection.svelte`, which calls them. Product pages stay handwritten. A comparable new entity with its own page needs seven application source edits, down from ten in the initial exercise; see [the measured exercise](extension-exercise.md).

1. Add a definition to `ENTITY_DEFINITIONS` in `packages/contracts/src/event/entity-definitions.ts`, or, for an entity a module owns, to that module's `src/data/definitions.ts` (see [Modules](modules.md)). Choose a stable entity name, table, owning feature, and fields. Copy the `gallery_album` definition for a standard entity. Keep persisted names stable; `payloadKey` maps an event field such as `coverPhotoId` to a database column such as `cover_photo_id` (camelCase is the default mapping). Defaults must also interpret older events that lack the field.

   An entity with a meaningful date can add an optional `calendar` config (`{ key, dateField, endDateField, timeField, titleField, titleFallbacks, subtitleField, filters, parent, params, label }`); a title ref may read a JSON object key (`customer_snapshot#name`) and `titleFallbacks` are tried in order when the title is empty. It then appears on the Calendar page and in calendar feeds without further wiring. Built-in dates are grouped in the page's Sources menu and the feed picker (Events, Transactions, Invoices); a date that is not in a built-in group gets its own row. `packages/contracts/src/calendar/config.ts` documents the shape and validation, and `packages/contracts/src/calendar/sources.ts` adds presentation (short URL key, icon, tone, deep link, sort rank); `packages/runtime/src/calendar/groups.ts` owns the grouping. Add a scoped date index when the calendar will span many records.
2. For a new feature, add its `FeatureId` and page metadata in `packages/contracts/src/features/registry.ts`, and its icon in `packages/shell/src/components/layout/feature-icons.ts`. An entity can instead belong to an existing feature. Navigation includes registered features automatically; its preferred order is optional.
3. Increment `SCHEMA_VERSION` in `packages/runtime/src/db/schema-version.ts` when the local materialized schema changes. Inspect the existing schema repair path for changes beyond a new standard table. Do not rewrite old event payloads or pending upload bodies to make a migration pass.
4. Run `pnpm generate:entities`. Review all five generated files: `event/types.generated.ts`, `db/schema.generated.ts`, `commands/standard.generated.ts`, and `db/standard.generated.ts` under `src/lib/`, and `ledger/src/event-schemas.generated.ts`, which tells Ledger the shape of the new events. Deploy Ledger before the frontend so it already accepts them. Never edit them directly. `pnpm generate:entities:check` detects drift without writing files.
5. Use the generated command and query adapters. Commands still enter the existing validation, local transaction, outbox, and synchronization path. Queries capture the active tenant/log read session; the scope is applied by the session, so repositories never add `tenant_id` / `log_id` predicates by hand.

```ts
import { galleryAlbumCommands } from '#lib/commands/standard.generated.js';
import { queryDatabase } from '#lib/db/read-repositories.js';

const id = crypto.randomUUID();
await galleryAlbumCommands.create({ id, title: 'Summer', description: '', coverPhotoId: '' });
await galleryAlbumCommands.update({ id, description: 'Two weeks by the sea' });
const albums = await queryDatabase(repositories => repositories.records.galleryAlbum.list());
const album = await queryDatabase(repositories => repositories.records.galleryAlbum.get(id));
await galleryAlbumCommands.remove({ id });
```

Use `executeLocalCommand(events, { submissionId })` for a multi-event user action. Reuse a submission ID when retrying the same save; use a new ID for a distinct action, even when its values match an earlier action. Generated adapters also accept this option. Disable repeated form submission while a save is running. Durable delivery retries reuse the original request automatically.

For domain-specific validation or queries, extend the existing command/repository mechanisms. The generated CRUD adapter does not infer relationships, lifecycle rules, or product workflows. Current remove/recreate behavior remains the existing projector behavior; adding a field or entity does not change it.

6. Add the custom page following [Adding a page](adding-a-page.md), including its refresh key. The route-dependency test catches missing sync invalidation registration.
7. Keep family tenants unchanged until the feature is ready. For an intended family app, edit that person's entry in `tenants.json`, then run `pnpm check:tenants` and regenerate that tenant's artifact using the existing tenant workflow. Provisioning/deployment are separate operations.
8. Validate generated drift, `pnpm check:ts`, focused domain tests, and the custom page in the browser. Cover a real offline write and reload, accepted remote changes, and a tenant where the feature is absent. Run `pnpm build` before delivery.

## Deleting a feature

Delete its page, components, repositories, refresh keys, calendar sources, and entity definitions, then run `pnpm generate:entities`. Bump `SCHEMA_VERSION` and drop the old projection tables in the schema migration (see `DELETED_FEATURE_TABLES` in `packages/runtime/src/db/index.ts`). Accepted events stay in Ledger and `raw_events` untouched; nothing projects them once the definitions are gone.

The standard definition drives projections and event dispatch. Log history can inspect its accepted events without changing the page's read path. A routine entity does not require changes to synchronization or bootstrap. Avoid introducing a second registry or custom transport for it.
