# Calendar improvement plan: unified sources and ICS feeds

Planning document. No code has been written; decisions below were confirmed by
the product owner and the remaining open items are listed in section 8.

## Decisions taken

1. **Declarative sources.** An entity declares its calendar-worthy date through
   a per-entity `calendar` config in `src/lib/event/entity-definitions.ts`
   (not a per-field boolean, not a side registry).
2. **Dynamic entities participate from the start.** Runtime-defined entity
   types can opt in through their meta-entity definition and the entity editor.
3. **ICS is served as a server-computed subscription feed**, not an uploaded
   client snapshot. The frontend Worker folds Ledger events on demand and
   serves `text/calendar` from an Access-bypassed capability URL.
4. **Phase 1 covers every dated record on the Finance and Invoices pages:**
   `calendar_event`, vacation plans and trips, `transactions.due_date`,
   `invoices.issue_date` / `due_date` / `tax_point_date`, and the received
   invoice's `issue_date` / `due_date` / `tax_point_date`. The received
   invoice's `paid_at` is intentionally not published (the due date is the
   actionable one), and invoice items are titled by customer/supplier with the
   invoice number as the subtitle, mirroring the invoice lists.
   Books, nutrition goals, and weight logs remain config-block candidates.
5. **Multi-day items render as a continuous band** in the month grid (one
   segment per week row, rounded ends at the range boundaries), not per-day
   chips. Mobile keeps the existing dot/count summary.
6. **Implementation runs Phases 1 and 2, then stops for review** before the
   Worker feed work in Phases 3–4.

## 1. Goals and non-goals

Goals:

- One transparent mechanism: adding a date to an entity definition is all it
  takes for the date to appear on the Calendar page, in the day agenda, and in
  ICS feeds.
- Remove the vacation-specific branch from `src/routes/calendar/+page.ts` and
  `src/routes/calendar/+page.svelte`.
- Serve subscribed ICS feeds to Google Calendar, Apple Calendar, and
  Thunderbird without weakening Cloudflare Access for the app itself.
- Keep reads SQL-only and scoped (`queryDatabase` + `ReadModelSession`), per
  the repository invariants.

Non-goals:

- CalDAV or any two-way sync. Feeds are read-only; editing stays in the owning
  feature pages and in the calendar's own events.
- Editing non-calendar entities from the calendar UI. Clicking an item
  navigates to its detail page.
- Public feeds without a token, or a tenant-wide public calendar.

## 2. Current state (evidence)

- `calendar_event` is a normal entity (`calendar_events`) with add/edit/pin/
  delete on the Calendar page (`src/routes/calendar/+page.svelte`).
- Vacation plans are bolted on: `src/routes/calendar/+page.ts` calls
  `repositories.vacations.getActivePlansForRange`, the page keeps a second
  `vacationPlansByDate` map, and the UI has vacation-only chips, suitcase icon,
  colors, and links. `src/lib/features/today.ts` has a matching vacation widget.
- Entity dates are SQLite `TEXT` with mixed formats: plain `YYYY-MM-DD`
  (`event_date`, `plan_date`, `due_date`), ISO local datetime (`logged_at`),
  and empty-string defaults (`received_invoices.due_date`). The `datetime`
  field type does not distinguish date from timestamp.
- Date-leading indexes are uneven: `calendar_events` and `vacation_plans`
  have them, `transactions` has only the unscoped `transaction_status` index,
  and `invoices` / `weight_logs` have none. New sources need indexes and a
  `SCHEMA_VERSION` bump.
- Dynamic entity definitions live in `entity_type_definitions`
  (`fields_json`) and are projected from `ENTITY_TYPE_*` events; there is no
  calendar metadata today. `EntityTypeRecord` is in `src/lib/db/dynamic-ddl.ts`.
- Auth: Cloudflare Access protects the bare tenant hostname with an email allow
  list; browser calls carry `Cf-Access-Jwt-Assertion`. The frontend Worker
  proxies Ledger through a service binding with `LEDGER_AUTH_TOKEN`, and
  `worker/ledger-scope.ts` verifies a log belongs to this app before touching
  private storage (`worker/vacation-files.ts` is the working precedent).
- Ledger stores accepted events only; local rejected events never reach it.
  `selectReplayEvents` (`src/lib/history/replay-selection.ts`) is a pure
  function that resolves tombstones, excisions, and workspace restores — the
  exact semantics a server-side fold needs. It has no imports and can run in a
  Worker.
- Ledger pagination: `MAX_CATCH_UP = 512` events per `GET /logs/:id/events`;
  `GET /logs/:id` returns the head version. Nothing scheduled/cron exists in
  the frontend Worker; storage bindings are R2 only (no KV, no D1).

## 3. Part A: unified declarative sources

### 3.1 Definition shape

Add to `EntityDefinition` (importable from Node codegen and from the Worker —
keep it free of browser-only imports):

```ts
/** How one entity's records appear on the calendar and in ICS feeds. */
export interface EntityCalendarSource {
    /**
     * Stable identifier for this date source, used in the source
     * preference, the presentation registry, and ICS UIDs. Defaults to
     * `<entity>-<dateField>`, so one entity can safely expose several dates.
     */
    key?: string;
    /** Column with the item date: `YYYY-MM-DD` or an ISO local datetime. */
    dateField: string;
    /** Inclusive end column for multi-day items. */
    endDateField?: string;
    /** `HH:mm` column; empty/absent means all-day. */
    timeField?: string;
    endTimeField?: string;
    /**
     * Title column; a `column#jsonKey` ref reads a JSON object key from a
     * text column (e.g. `customer_snapshot#name`). Defaults to title | name | label.
     */
    titleField?: string;
    /** Columns tried in order when `titleField` is empty. */
    titleFallbacks?: string[];
    /** Optional secondary line, e.g. an invoice number. */
    subtitleField?: string;
    /** Declarative equality filters, e.g. archived = 0. Never raw SQL. */
    filters?: Array<{ field: string; equals: string | number | boolean }>;
    /** Optional parent row for context, e.g. plan -> trip title. */
    parent?: {
        table: string;
        localField: string;
        titleField: string;
        filters?: Array<{ field: string; equals: string | number | boolean }>;
    };
    /** Agenda chip / ICS CATEGORIES label, e.g. "Vacation plan". */
    label: string;
}

export interface EntityDefinition {
    // ...existing fields
    /** One config per date field; an entity may expose several. */
    calendar?: EntityCalendarSource | EntityCalendarSource[];
}
```

Phase 1 examples:

```ts
// calendar_event (unchanged behavior, now declarative)
calendar: {
    dateField: "event_date",
    timeField: "start_time",
    titleField: "title",
    label: "Event",
}

// vacation_plan
calendar: {
    dateField: "plan_date",
    timeField: "start_time",
    titleField: "title",
    parent: {
        table: "vacation_trips",
        localField: "trip_id",
        titleField: "title",
        filters: [{ field: "archived", equals: 0 }],
    },
    label: "Vacation plan",
}

// vacation_trip (multi-day)
calendar: {
    dateField: "start_date",
    endDateField: "end_date",
    titleField: "title",
    filters: [{ field: "archived", equals: 0 }],
    label: "Trip",
}

// transaction: one date
calendar: {
    key: "tx-due",
    dateField: "due_date",
    titleField: "name",
    subtitleField: "transaction_category",
    label: "Transaction due",
}

// invoice: the due date is the actionable one; issued and received share a group
calendar: {
    key: "inv-due", dateField: "due_date",
    titleField: "customer_snapshot#name",
    titleFallbacks: ["description", "invoice_number"],
    subtitleField: "invoice_number", label: "Invoice",
}

// received_invoice: the paid date and the issue/tax-point dates stay off
calendar: {
    key: "rin-due", dateField: "due_date",
    titleField: "supplier_name",
    titleFallbacks: ["description", "invoice_number", "file_name"],
    subtitleField: "invoice_number", label: "Invoice",
}
```

Source keys: each config derives `<entity>-<dateField>` unless `key` is set;
keys are what the per-log source preference, the presentation registry, and
ICS UIDs use, so one entity can expose several dates without collisions.

Remaining candidates, each a config block plus an index and a UI review:
`books.finished_date` (needs a field-type audit because it is a plain string),
`nutrition_goals.effective_from`, and `weight_logs.date`. Health logs
(`calorie_entries.logged_at`, `activity_entries.logged_at`) are dense and stay
off. Money dates are day-level even when stored as ISO timestamps, so their
configs omit `timeField` and render all-day; existing consumers normalize them
with `substr(trim(col), 1, 10)` (`src/lib/db/forecast.ts`).

Rules for the config:

- `dateField`, `endDateField`, `timeField`, and filter/parent columns must
  exist on the entity; the repository validates this before building SQL.
- Identifiers are always quoted with `quoteIdentifier`; filter values and the
  month bounds are parameterized. Dynamic definitions are user data, so this is
  a security boundary, not a style rule.
- Empty string and `NULL` dates are excluded in SQL.

### 3.2 Source resolution

- Static: `ENTITY_DEFINITIONS` filtered by `tenant.approvedEntities.entityNames`
  so a disabled feature's table is never queried.
- Dynamic: rows from `entity_type_definitions` for the active log with a
  non-empty `calendar_json`, parsed and validated against their own field list.
- The two sets are merged by source key in the calendar repository during a
  single `queryDatabase` call; one entity contributes one union arm per
  configured date.

### 3.3 SQL shape

One normalized union query (exact CTE layout is an implementation detail):

```sql
WITH items AS (
    SELECT 'vacation_plan' AS source, p.id AS source_id,
           substr(p.plan_date, 1, 10) AS item_date, NULL AS end_date,
           CASE WHEN length(p.plan_date) > 10
                THEN substr(p.plan_date, 12, 5) ELSE p.start_time END AS start_time,
           '' AS end_time, p.title AS title, t.title AS subtitle, 0 AS pinned
    FROM vacation_plans p
    LEFT JOIN vacation_trips t
        ON t.id = p.trip_id AND t.tenant_id = p.tenant_id AND t.log_id = p.log_id
       AND t.archived = 0
    WHERE p.plan_date >= :start AND p.plan_date < :endExclusive
    UNION ALL
    -- one arm per source
)
SELECT item_date AS day, json_group_array(json_object(...)) AS items
FROM (SELECT * FROM items ORDER BY item_date, start_time, source, source_id)
GROUP BY item_date
```

- Grouping stays in SQL (the repo invariant), so the page consumes
  `{ day, items[] }` directly; the existing `groupCalendarEventsByDate` JS map
  is retired for this path.
- Multi-day items are expanded to one row per covered day in SQL with a
  recursive days CTE bounded by the visible month, with `is_range_start` /
  `is_range_end` flags for styling and a single `end_date` for ICS.
- Per-source ordering and a stable source rank (calendar events first) live in
  SQL, not in component code.
- Pinned/upcoming queries (`getUpcomingPinnedCalendarEvents`) stay specific to
  `calendar_event`; no generic source can be pinned in Phase 1.
- New indexes are migrations, declared in `entity-definitions.ts` and emitted
  by codegen: `vacation_plans (tenant_id, log_id, plan_date)` (the current
  index leads with `trip_id` and cannot serve a date range);
  `transactions (tenant_id, log_id, due_date)`; `invoices (tenant_id, log_id,
  issue_date | due_date | tax_point_date)`; `received_invoices (tenant_id,
  log_id, issue_date | tax_point_date | paid_at)` (`due_date` already has an
  index). Bump `SCHEMA_VERSION` and use the schema-repair path.

### 3.4 Presentation registry

New `src/lib/calendar/sources.ts` maps source key to presentation metadata:
short URL key, icon **name** (`~icons/mdi/*` as a string, resolved to a
component by the calendar UI), tone token (`--stor-accent-soft`,
`--stor-warning-soft`, …), href template, and sort rank. Href templates use
only existing deep links — `/vacations/{trip_id}#day-{date}`,
`/invoices?invoice={id}`, `/invoices?tab=received&invoice={id}`, or the owning
month page `/finance/{year}/{month}` where none exists. The client resolves
them against `page.url`; the Worker imports the same dependency-free module and
resolves them against the feed request origin for the ICS `URL` property.
Storing icon names as strings keeps Svelte/icon imports out of the module, and
keying by source lets `inv-due` and `rin-due` share the invoice icon while
their links still open the issued or received invoice.

### 3.5 Calendar UI

- Grid cells render a mixture of sources; overflow beyond 2–3 chips collapses
  into “+N more”, which selects the day and opens the agenda.
- Source filters live in a grouped **Sources** menu, not a scrolling chip row.
  Built-in dates group as Events, Vacations, Transactions, and Invoices; a
  dynamic entity is its own row. The choice is stored per log in IndexedDB
  (`src/lib/calendar/preferences.ts`) as hidden groups and sources, so a new
  source stays visible without user action. The repository omits hidden
  sources in SQL; a saved choice that would hide every available source falls
  back to showing all.
- Agenda groups items by source with the configured label and links to the
  owning page; calendar events keep the edit drawer and pin toggle.
- Legend/toggles sit in the Calendar toolbar; no new navigation destinations.
- Today keeps the existing pinned-events widget and vacation widget. A unified
  “upcoming” widget is deliberately deferred (section 8).

### 3.6 Dynamic entities

- `DefineEntityTypePayload` and `UpdateEntityTypePayload`
  (`src/lib/event/meta-entity-types.ts`) gain an optional
  `calendar?: EntityCalendarSource | EntityCalendarSource[]`.
- `entity_type_definitions` gains a nullable `calendar_json` column
  (`src/lib/db/index.ts` DDL + `EntityTypeRecord` in `src/lib/db/dynamic-ddl.ts`),
  with a `SCHEMA_VERSION` bump and the entity_type_definitions repair migration
  extended.
- `handleEntityTypeDefined` / `handleEntityTypeUpdated`
  (`src/lib/event/dynamic-entities.ts`) persist and validate the config
  (field exists, is `datetime`/`string`, equals-filter types match).
- The dynamic entity editor in `src/routes/entities/+page.svelte` gets a
  “Show on calendar” control that picks the date field, optional end/time
  fields, title field, and label. Archived types drop out of the source set.
- Meta-event consumers must keep treating unknown optional fields as absent so
  older clients ignore new configs safely.

### 3.7 Migrations and generated files

- `SCHEMA_VERSION` bump in `src/lib/db/schema-version.ts` for `calendar_json`
  and the new indexes.
- Regenerate with `pnpm generate:entities` (never edit
  `src/lib/event/types.generated.ts` and friends by hand).
- No event payload rewrites: existing events keep their shapes.

### 3.8 Part A tests

- Vitest: config validation, union SQL against an in-memory SQLite fixture
  (static + dynamic sources, one entity with several dates, ranges, empty
  dates, filters), URL parsing, dynamic-definition round trip through meta
  events.
- Playwright: vacation plans and trips appear without vacation-specific markup;
  source filter persists across reload; dynamic entity with a calendar config
  appears; disabled feature's sources never render.
- `pnpm check:ts`, `pnpm test:unit --run`, `pnpm build`,
  `pnpm test -- tests/calendar.spec.ts`.

## 4. Part B: server-computed ICS feeds

### 4.1 Feasibility

Serverless is not the constraint: an ICS feed is a small `text/calendar`
response that can be generated on demand and cached. The two real constraints
are Cloudflare Access (calendar clients cannot present a browser session) and
the fact that Ledger stores raw accepted events, not read models. Both have
workable answers below.

### 4.2 Access bypass and tokens

Calendar clients cannot send the Access JWT or custom headers, and Google
fetches feeds from its own servers, so:

- Add a **path-scoped Access application** for
  `hostname/api/calendar-feed/*` with a **Bypass** policy, managed by
  `scripts/cloudflare-access.ts` and `scripts/ensure-tenant.ts`. Before
  implementation, verify path-app precedence against the existing bare-host
  app; if it does not compose reliably, use a dedicated feed hostname with its
  own Bypass app as the fallback.
- **Auth decision (confirmed): the feed path authenticates by a per-feed
  capability token issued and validated by the authenticated Worker — not by
  app tokens and not through the Ledger admin API.** App tokens are the
  single-principal gateway credential (URL exposure or rotation would break the
  whole site); Ledger `access` tokens are API-scoped with stateful revocation;
  the admin API is tied to the operator's Access audience. The Worker issues
  256-bit random tokens (`POST /api/calendar-feeds/v1`, Access JWT +
  `verifyLogAppId`), stores only their SHA-256, and serves them at the
  Access-bypassed path. Each token belongs to one feed registration with its
  own source filter and window; revocation is per feed. The URL is a bearer
  secret — document that anyone with the URL can read the calendar.
- **Lifecycle (confirmed): no expiry by default.** Records carry optional
  `expiresAt` (off unless set), `createdBy`, `createdAt`, and
  `lastAccessedAt`; the management UI revokes feeds individually.
- Public and management paths are separate: `/api/calendar-feed/<token>.ics`
  is bypassed; `/api/calendar-feeds/v1/...` keeps the normal Access check.

### 4.3 Endpoints

Authenticated management (Access JWT + `verifyLogAppId`, modeled on
`worker/vacation-files.ts`):

- `POST /api/calendar-feeds/v1` `{ logId, window?, sources? }` → creates a
  feed, returns the URL and the token **once**.
- `GET /api/calendar-feeds/v1?logId=` → feed list without tokens.
- `DELETE /api/calendar-feeds/v1/:feedId` → revoke.

Public feed:

- `GET /api/calendar-feed/<token>.ics` → token lookup → fold → ICS with
  `Content-Type: text/calendar; charset=utf-8`, `ETag`, `Cache-Control:
  no-store` for the management responses and a version-keyed cache internally.

### 4.4 Fold correctness (reuse, do not reimplement)

- Fetch the log’s head version (`GET /logs/:id`) and all events in pages of
  512 via the `LEDGER` service binding.
- Adapt `StoredEvent` to `ReplayEvent` and run the existing pure
  `selectReplayEvents(events, headVersion)` so tombstones, legacy excisions,
  and workspace restores behave exactly as in the client.
- Fold effective `ENTITY_*` events by entity: highest `entityVersion` wins;
  `*_REMOVED` drops the entity; event type prefix resolves the entity
  definition via `getEventPrefix`.
- Merge static calendar configs with dynamic ones read from effective
  `ENTITY_TYPE_*` events, so a runtime-defined entity appears in the feed with
  no extra server state.
- Accepted-only semantics: locally pending or later-rejected events never reach
  Ledger, so the feed is always a strict subset of what the app shows and can
  lag by one sync. This is intended.
- Keep `src/lib/history/replay-selection.ts` and the calendar metadata modules
  dependency-free so the Worker can import them; add a `paths` entry to
  `worker/tsconfig.json` for the workspace aliases.

### 4.5 Caching and freshness

- Cache key: `(logId, headVersion, feed config)`; R2 object holding the
  generated ICS. A poll first asks Ledger for the head version — unchanged
  version serves the cached bytes; changed version refolds from version 0.
- Full refold keeps the incremental-maintenance problem (restore/excision can
  invalidate earlier choices) out of the first version. Personal logs are small
  enough; add per-poll page caps and a size guard, and revisit incremental
  folding only if polls get expensive.
- Freshness is independent of app usage, which is the reason this option was
  chosen over client snapshots.

### 4.6 ICS rules

- One `VEVENT` per entity (not per expanded day): all-day items use
  `DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE` with an exclusive end; timed items
  use floating local times (`DTSTART:YYYYMMDDTHHmmss`) to match the UI, with no
  TZID. The `timezone` field on trips is ignored in Phase 1 (open item 8.5).
- Stable `UID`: `<source-key>-<entity-id>@<feed-id>`; never derived from the
  title or date. The key disambiguates invoice issue/due/tax-point events.
- Proper RFC 5545 output: CRLF, escaping of `\ ; ,` and newlines, 75-octet
  folding on UTF-8 boundaries, `PRODID`, `CALSCALE`, `METHOD:PUBLISH`,
  `X-WR-CALNAME`, `REFRESH-INTERVAL;VALUE=DURATION:PT1H`, `SUMMARY`,
  `DESCRIPTION`, `CATEGORIES`, `URL` (deep link), `DTSTAMP`.
- Rolling window (default −6 months/+18 months, bounded by the feed config).
- Serializer is a pure module `src/lib/calendar/ics.ts` used by the Worker and,
  cheaply, by an in-app “Export .ics” action (offline-friendly).

### 4.7 Token storage

- R2 is sufficient and needs no new binding technology: store
  `calendar-feeds/v1/tokens/<sha256(token)>.json` → `{ feedId, logId, appId,
  sources, window, createdBy, createdAt, lastAccessedAt, expiresAt? }`, plus
  `calendar-feeds/v1/ics/<logId>/<configHash>-<headVersion>.ics`. The token
  hash is the storage key, so validation is a single, strongly consistent GET.
- The management endpoints verify the same Access identity and log scope as
  the rest of the app; no Ledger contract, signing key, or admin credential is
  involved. Ledger is read-only here, over the existing service binding.
- Reuse the existing private bucket via a dedicated `CALENDAR_FEEDS` binding
  (the generated tenant configs already build R2 bindings from
  `tenants.json`), or add a dedicated bucket if separation is preferred.
- KV is the alternative if per-token TTL/listing ergonomics matter; it is a new
  binding kind in generated configs and not required for correctness.

### 4.8 Deployment changes

- `run_worker_first` in `wrangler.jsonc` and `buildTenantWranglerConfig`:
  both calendar prefixes.
- `scripts/cloudflare-access.ts` / `ensure-tenant.ts`: Bypass app for the feed
  path (or dedicated hostname), with tests for the planner.
- Worker types regeneration and routing in `worker/index.ts`.
- No Ledger contract change is required for the fold; if full-log fetches prove
  too costly, a future Ledger RPC returning compacted entity state is the
  escalation path.

### 4.9 Security

- Token hashes only at rest; tokens never logged; feed management remains
  Access-protected.
- Worker observability logs request paths, so tokens in a path segment are
  visible in logs — either accept that (own account) or disable path logging
  for that route and document it.
- The feed reflects accepted events only; no rejected/pending data leaks.
- Rate limiting via Cloudflare WAF/rate rules on the feed path is optional but
  recommended.

### 4.10 Part B tests

- Vitest: `ics.ts` (escaping, folding at UTF-8 boundaries, UID stability,
  DTEND exclusive, all-day vs timed), token hashing/validation, fold adapter
  over `selectReplayEvents` fixtures (tombstone, excision, restore, removed).
- Worker tests (`pnpm test:worker` / `playwright.worker.config.ts`): feed
  create/list/revoke, invalid and revoked tokens, head-version cache hit,
  ETag/`text/calendar` headers, source filters/window.
- `pnpm frontend:worker:check`, `pnpm frontend:worker:dry-run`,
  `pnpm check:tenants`.

## 5. Phases

| Phase | Scope | Size |
| --- | --- | --- |
| 1 | Source model (static + dynamic), repository union, migrations, Calendar UI, vacation + finance/invoice sources, retire vacation hardcoding | M–L |
| 2 | `ics.ts` serializer + in-app `.ics` export | S |
| 3 | Feed registry endpoints, tokens in R2, management UI, worker tests | M |
| 4 | Public feed serving, Access Bypass provisioning, server-side fold + cache, deployment docs | M–L |
| 5 (optional) | Remaining sources (books, nutrition, weight), unified Today “upcoming”, per-source feeds, webcal one-click | M |

Each phase must keep `pnpm check:all` green and ship its own tests; phases 1
and 4 are the two high-risk transitions and should land separately.

## 6. Rollout risks

- **Fold divergence** between client SQL projections and the Worker fold.
  Mitigation: share `selectReplayEvents` and the definitions; feed is
  accepted-only by design; add fixture parity tests comparing a folded entity
  list with a rebuilt client projection.
- **Access bypass** is a deliberate public surface. Capability tokens are
  revocable but public-by-URL; document and rotate.
- **Large logs** make full refolds expensive; head-version caching bounds the
  frequency, and pagination caps bound the worst case.
- **Noisy sources** can overwhelm the grid; invoices alone contribute three or
  four dates per record. Source filters (all on by default, since the scope is
  “everything”) plus the “+N more” overflow are the guardrail; if a month is
  still too dense, curation happens in the registry defaults, not in SQL.

## 7. Verification checklist

- Phase 1: `pnpm check:ts`, `pnpm test:unit --run`, `pnpm build`,
  `pnpm test -- tests/calendar.spec.ts tests/vacations.spec.ts`.
- Phase 2: plus unit tests for `ics.ts`.
- Phase 3–4: plus `pnpm frontend:worker:check`,
  `pnpm frontend:worker:dry-run`, `pnpm check:tenants`, worker Playwright suite.
- Docs updated: this file becomes the reference; add a how-to for creating and
  revoking a feed.

## 8. Progress

Phase 1 — unified sources, dynamic entities, Calendar UI:

- [x] Decisions recorded (config shape, finance/invoice scope, band rendering)
- [x] Entity definition metadata for calendar_event, vacations, transactions,
      invoices, received invoices
- [x] New date indexes declared in entity definitions
- [x] Shared calendar config/validation module (`src/lib/calendar/config.ts`)
- [x] Generated files + `SCHEMA_VERSION` bump
- [x] Dynamic entity meta-event, schema column, validation, and editor support
- [x] Unified calendar repository (static + dynamic, points + ranges, SQL grouping)
- [x] Calendar loader + URL source filters (`src/lib/calendar/url.ts`)
- [x] Calendar UI unification with source legend and continuous range bands
- [x] Vacation-specific code paths retired
- [x] Unit and Playwright coverage updated
- [x] `docs/adding-an-entity.md` mentions the calendar config

Phase 2 — ICS serializer and in-app export:

- [x] `src/lib/calendar/ics.ts` serializer + unit tests
- [x] In-app “Export .ics” action honoring the active source filters

Phases 1–2 are complete and verified (`pnpm check:ts`, `pnpm test:unit --run`,
`pnpm build`, `pnpm test -- tests/calendar.spec.ts tests/vacations.spec.ts`).

Phase 3 — feed registry (auth decided: per-feed capability tokens issued and
validated by the Worker, hashed in R2, no expiry by default):

- [x] Auth decisions recorded
- [x] Feed storage bucket + binding plumbing (`tenants.json`, generated
      wrangler configs, `ensure-tenant` bucket phase, worker types)
- [x] Worker management endpoints (`POST`/`GET`/`DELETE /api/calendar-feeds/v1`)
- [x] Management UI (create / list / revoke feeds)
- [x] Worker tests

Phase 3 is verified: `pnpm check:ts`, `pnpm test:unit --run` (calendar + worker
suites), `pnpm build`, `pnpm exec playwright test tests/calendar.spec.ts
tests/calendar-feeds.spec.ts`, `pnpm frontend:worker:check`,
`pnpm frontend:worker:dry-run`. The created URL starts serving once Phase 4
lands.

Phase 4 — public feed serving:

- [x] Shared pure source resolution/fold reused by the client and the Worker
- [x] `/api/calendar-feed/<token>.ics` serving with head-version caching
- [x] Access Bypass provisioning in `cloudflare-access.ts` / `ensure-tenant`
- [x] Feed how-to docs (`docs/calendar-feeds.md`)

Phase 4 code is complete. Deploy-time actions (run when deploying, not from
an agent session): `pnpm ensure:tenant` to create the bucket and the path-scoped
Bypass application, then verify Access path precedence in the account.

Calendar filter revision (after Phase 4):

- [x] Invoice calendar exposes due dates only; issued and received share one
      Invoices group and one presentation
- [x] Grouped Sources menu replaces the chip row; `?src=` URL state retired
- [x] Per-log IndexedDB preference (`src/lib/calendar/preferences.ts`,
      `src/lib/calendar/groups.ts`) with fallback when everything is hidden
- [x] Feed picker groups its checkboxes to match

## 9. Open decisions

1. ~~**Invoice date coverage.**~~ Resolved: the calendar publishes the issued
   and received invoice due dates only. Issue and tax-point dates stay off
   (they remain available in the invoice lists and analytics), and both due
   dates share the Invoices group.
2. ~~**Range rendering**: per-day chips with start/end styling (recommended) vs
   a continuous band.~~ Resolved: continuous band (decision 5).
3. **Feed window and past events**: per-feed configuration, default −6/+18
   months (recommended) or future-only.
4. **Feed host**: path-scoped Bypass on the existing hostname (recommended,
   pending precedence verification) vs a dedicated feed subdomain.
5. **Timezone handling**: floating local times (recommended for now) vs using
   `vacation_trips.timezone` as `TZID`.
6. ~~**In-app `.ics` export**~~ Resolved: shipped in Phase 2.
7. **Today “upcoming” unification**: defer until the calendar source model
   proves out (recommended).
8. **Record status filtering.** The plan includes every stored record (draft
   and paid invoices, archived and active transactions). If that proves too
   noisy, declarative filters can exclude e.g. `status = 'draft'`, but that
   hides information the Finance and Invoices pages show, so it is off by
   default.
