# Gallery implementation plan

27 September 2026 · Pilot implementation prepared locally · No Gallery deployment verified

## Product contract

Build a private, directly uploaded photo library in ST, followed by an explicit public export. The private page follows the live-shell Gallery design study; the export follows the public Gallery study. The variable, aspect-aware photo mosaic is part of the agreed design on desktop and phone.

Decisions already made:

- The Gallery is a private library with direct uploads. Existing Vacations files are not silently imported.
- Original photo objects are immutable and shared across forked logs within the same Ledger app. An authoritative per-log access index decides which log can read each photo version.
- Publishing creates a reviewed, immutable public snapshot. The first visibility mode is **Anyone with link**, unlisted by default. Private edits, uploads, and forks never update it automatically.
- Public pages share the private Gallery's presentation components and show only reviewed fields, including the photo details the owner keeps switched on. They have no private Hearthlog shell or API dependency.

The private page now has Photos, Favorites, Albums, upload status, a viewer, backup and restore. Publishing can start from an album or a hand-picked selection.

## Architecture and ownership

| Part | Owner and contract | Main code touchpoints |
| --- | --- | --- |
| Photo metadata | Commands append photo, edit, favorite, and removal events. Tenant/log-scoped SQLite projections provide the timeline and viewer reads. Binary bytes never enter events. | `src/lib/event/entity-definitions.ts`, `src/lib/db/`, `src/lib/gallery/` |
| Private objects | Originals and derived sizes live under immutable app-scoped keys in a private R2 bucket. The browser durably stages pending originals in IndexedDB; uploaded bytes can be fetched on a new device. | `src/lib/gallery/`, `worker/`, generated tenant configuration |
| File authorization | Ledger maintains a per-log index of accepted photo-version references, including references inherited at a fork point. The private Worker validates the Access identity, tenant, log, and exact photo version through that index before reading or accepting bytes. | `ledger/src/`, `worker/ledger-scope.ts`, Gallery media route |
| Private page | A custom `/gallery` page under Life, secondarily reachable through mobile More. It uses the current Hearthlog shell, route tabs, mobile action, command overlays, and tenant tokens. | `src/routes/gallery/`, `src/lib/components/gallery/`, feature registry/navigation |
| Public export | An Access-protected management endpoint checks the accepted source version and selected uploaded files, produces metadata-stripped renditions and a manifest, and activates one versioned snapshot. | Private frontend Worker, publication job/state, separate public Worker |
| Public serving | One dedicated public hostname and Worker serve only active publication manifests and their public image variants from a separate publication bucket. The public Worker has no Ledger or private R2 binding and exposes no publish endpoint. | New public Worker and its generated deployment config |

### Media and event order

1. Validate and decode an import, record intrinsic dimensions and capture-date fallback, then durably stage the original and a preview in IndexedDB. A failed local stage creates no photo event.
2. Append a photo metadata command with a stable submission ID. Show **Saved on this device** while the event or original remains local. Keep pending originals pinned against cache eviction.
3. After Ledger accepts the reference, the upload queue sends the immutable version through the authenticated same-origin Worker. The Worker checks the accepted per-log reference before writing; retries use the same object/version and are idempotent. Reconcile accepted metadata with missing bytes after interruption.
4. Generate bounded thumbnail and viewer sizes, verify their availability, and show **Synced** only when the original and required derivatives are remotely present. An uncached offline photo says **Available when online**. Keep upload, sync, and backup claims distinct.
5. Preserve prior immutable versions while any current or recoverable log can reference them. Photo removal is an event; album removal does not delete member photos. Physical cleanup requires reference and recovery rules, not merely a UI delete.

The importer accepts JPEG, PNG, WebP, HEIC, and HEIF up to 20 MiB per original. It preserves original bytes when the browser cannot decode a preview. The public export uses Cloudflare Images to make bounded WebP copies. Real-device HEIC/HEIF decoding and public transformation still need a pilot check; a supported upload does not guarantee a publishable public copy.

### Query and layout contract

- The Gallery repository reads the timeline in SQL: `summary` returns its blocks (months, split into parts of 240), months with the busiest month's count for the spine, and the total; `blockPhotos`, `monthAlbums`, `monthPhotoIds`, `photoBlock`, and `strip` read one block, a month's albums or photo IDs, the block holding a photo, and a photo's neighbours. Search, favorites and album membership filter every read. Do not filter or aggregate loaded rows in Svelte.
- Store image width and height. The private Photos and Albums timelines break each block into justified rows chosen for the whole block, so rows stay near one height and fill the width; a short last row keeps the target height. Tile ratios are clamped to 1:2–3:1 in both SQL estimates and layout. Blocks reserve their estimated height before loading, and DOM/focus order follows the timeline: newest first in the private app, oldest first on the public page. The public preview and visitor page use the same rows (`JustifiedRows`).
- The viewer contains the original aspect ratio, uses URL state for the selected photo and active tab/filter, and restores the underlying scroll position. Photos and Favorites share a selection mode whose opaque URL token restores selected IDs from tenant- and log-scoped session storage after reload or Back. The selection can add eligible photos to an album or prepare a reviewed public gallery. Page loading follows `deferPage`, `PageResource`, `PageDataStatus`, and `app:gallery` invalidation.
- Use `--stor-*` colors, current page spacing and typography, accessible image labels and focus, reduced motion, touch targets, and a persistent **Add photos** action on mobile. The public preview and visitor page must use the same layout rules at matching widths.
- On phones, Photos and Favorites put search, Select, and the Backup overflow action in one compact toolbar so the month and photos begin sooner. The persistent Add photos action stays above the bottom navigation.
- A pending upload uses a small cloud marker on each photo instead of repeating the full message across the mosaic; hover or focus reveals the text. The viewer shows the full local state, and failures retain an explicit tile message.
- The phone viewer keeps Close and Favorite visible, moves edit/remove/download into Photo actions, and reveals camera/file/location details on demand. A deliberate horizontal swipe moves between the same SQL-ordered neighbors as the arrow keys; desktop keeps the direct actions and visible details.

## Public URLs and Cloudflare Access

The configured pilot URL is `https://st-gallery-public.example.workers.dev/g/<opaque-publication-id>`; staging uses a separate Worker and bucket. This is configuration, not evidence of a deployed or anonymously reachable endpoint. Image URLs stay on that public origin and include an immutable revision and opaque asset ID. Publication IDs are high-entropy and globally unique; neither the URL nor HTML reveals a tenant ID, log ID, private object key, original filename, or Access token. The public Worker returns no list of publications and serves only assets referenced by the active manifest.

| Request | Cloudflare entry | Result |
| --- | --- | --- |
| Owner opens private `/gallery` or calls the private media/publish API | Existing tenant hostname and Access-protected frontend Worker | Requires the tenant's Access session; Worker still enforces tenant/log/photo rights. |
| Visitor opens `/g/<id>` or one of its images | Separate public hostname and Worker | No Access login. Worker resolves the active publication and serves only reviewed copies. |
| Visitor guesses a missing, unpublished, or old asset | Public Worker | No private fallback or bucket listing; return an unavailable response. |

Hearthlog's deployment preflight currently requires an exact host-wide Access application for each private tenant hostname (`scripts/deployment-security.ts`). Leave that protection in place. The public Worker must be a distinct deployment with only its public bucket and publication-state bindings. Do not place a broad `/gallery/*` Bypass inside the private Hearthlog Worker. Calendar feeds use a narrow path Bypass, but a photo site has many page and image paths and merits a separate origin.

Before enabling the public host, inspect *all* matching Access layers: hostname/path applications and wildcards, Worker-level protection, account-wide Worker protection, and any account setting that blocks hostnames without an Access app. Cloudflare's current rule hierarchy gives hostname/path rules precedence over Worker rules; a separate public Worker may still need a narrowly scoped public Bypass or exemption if a broad protection setting covers it. Configure that exemption only for the public Worker/host, never the private tenant host. Test the actual public URL from a clean, unauthenticated browser and with `GET`/`HEAD` image requests; test that the private page and media requests still require Access. Also check alternate `workers.dev`, preview, and custom-domain entry points for both Workers. See [Cloudflare Access rule hierarchy](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [application path matching](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), and [account default-deny](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/require-access-protection/).

Cloudflare Workers [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) route an entire hostname to one Worker, which fits the public page and same-origin image paths. The link is *unlisted*, not secret authorization: use `noindex`, omit a gallery directory/sitemap, and make publishing deliberate. Anyone who obtains the URL can view and copy the published images. `Copy link` and `View public gallery` are owner actions in the private app; public visitors receive no Access cookie or private API access.

### Publication state and revocation

1. Require online status, accepted source metadata, and verified uploaded originals. In a private review drawer show the exact selected photos, order, cover, public title, captions, and phone/desktop preview. Warn that recognizable people and places inside pixels survive metadata removal.
2. Create normalized, resized, EXIF/GPS-stripped public variants and an immutable manifest in a **separate** publication bucket. No originals, private filenames, log details, or arbitrary user HTML reach that bucket. Capture time, camera, exposure, and location reach it only as reviewed manifest fields the owner kept switched on.
3. Verify all manifest assets, then atomically switch an active pointer. An incomplete attempt remains invisible; retrying one publish request is idempotent. Publication intent/audit is an Hearthlog event; progress and active serving state are reconciled in server-owned publication state. A fork does not inherit a live publication.
4. Updating repeats review and makes a new revision while retaining the stable `/g/<id>` page URL. Unpublish disables the active pointer first and then purges controlled caches and cleans assets. Never promise recall of copies already downloaded or cached elsewhere. Ensure public page and image routes consult active state before serving; cache policy must preserve revocation behavior.

## Delivery sequence and gates

| Phase | Work | Exit evidence |
| --- | --- | --- |
| 0. Spike and contract | Confirm image formats, derivative strategy, upload limits, IndexedDB quota behavior, 1k/10k-photo query and layout performance, original export format, and public-host Access posture. | Written decisions and fixture photos; no production data or deployment. |
| 1. Reference security | Add backward-compatible Ledger reference index and exact-photo authorization contract. Populate it only from accepted events; copy references at the chosen fork point without copying bytes. | Ledger and Worker tests for same-log, fork, wrong-log, wrong-tenant, rejected-event, and missing-reference cases. |
| 2. Private metadata | Add Gallery feature gating, event definitions/projections, schema migration, repository, route, and SQL timeline. Generate entity files from source definitions. | Route guard, replay/migration, pagination, search, and SQL-order tests. |
| 3. Private media | Add durable local staging, bounded upload/retry, private R2 endpoint, derivatives, availability reconciliation, and storage diagnostics. | Offline import, interruption/retry, fresh-device, quota, and denied-file tests. |
| 4. Experience | Build the variable mosaic, viewer, Favorites, then Albums and bulk actions; preserve URL and mobile behavior. | Desktop/mobile Playwright for layout, navigation, keyboard/touch, dark theme, and error states. |
| 5. Recovery and pilot | Export/restore private originals with events, drill a restore, measure fork time and large-library loading, document limitations, then enable one tenant. | Recovery drill and tenant-gated pilot acceptance. A public copy is not a backup. |
| 6. Public export | Add review, staging/activation, dedicated public Worker/host, unlisted URL, update/unpublish, and public cache checks. | Anonymous public access, private Access enforcement, no metadata leakage, idempotent retries, revision/race, and revocation tests. |

The implementation should update `tenants.json` and the existing tenant/config generators for new feature flags, bucket/host settings, and deployment checks. Never hand-write generated per-tenant Wrangler files or rename existing Durable Object classes/bindings. Plan a rollback that can disable Gallery/public publishing without deleting originals or breaking older clients. Remote provisioning and deployment require a later explicit user request under `AGENTS.md`.

## Verification during implementation

Use focused Vitest for pure Gallery logic and Ledger state, Playwright for the page and worker routes, and representative real-media fixtures. At each code slice run the relevant repository gates: `pnpm check:ts`, `pnpm test:unit --run`, `pnpm build`, focused `pnpm test -- tests/<spec>.spec.ts`, `pnpm frontend:worker:check` and dry-run for binding changes, `pnpm ledger:check`, `pnpm ledger:test`, Ledger dry-run for config changes, `pnpm check:scripts`, `pnpm test:scripts`, and `pnpm check:tenants`. Run the cross-cutting gate before release. Validate Access/public behavior on actual deployed hostnames with an anonymous session; local tests alone cannot prove Cloudflare policy routing.

## Current release boundary

- The configured pilot uses a separate `workers.dev` hostname, Worker, and R2 bucket. Public Worker code only reads the public bucket; the private Access-protected Worker owns publication writes. The public Worker deploys separately from the frontend Worker. New revisions no longer write the whole v1 manifest; the public Worker still reads one for revisions activated earlier.
- Private export and restore use a tar archive of original files and metadata. Accepted fork references keep immutable original objects reachable; private object reclamation across all recoverable forks is not part of this pilot.
- Local tests cover exact-log access, rejected references, publication retries, version conflicts, update, unpublish, revoked page and asset requests, and retired revision cleanup. The public Worker checks the active pointer on each request and returns `noindex` headers: `no-store` for pages and data, `private, max-age=60` for images.
- Before live release, run the anonymous/public and private/Access checks above on actual hostnames, exercise real HEIC/HEIF and large phone photos, and measure 1,000/10,000-photo query, layout, fork, and restore behavior on a representative device. These are release checks, not claims established by local unit tests.
