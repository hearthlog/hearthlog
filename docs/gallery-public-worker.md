# Public Gallery serving boundary

`modules/gallery/public/` (part of the Gallery module) is a standalone Worker for unlisted Gallery snapshots. It
only reads its `GALLERY_PUBLIC` publication bucket. It has no Ledger, private
Gallery bucket, Access token, or Hearthlog asset binding. Its canonical origin is
checked on every request so alternate Worker URLs do not silently become
another serving path.

The public bucket stores an active pointer per opaque publication ID, a small
immutable index (`index.json`), 100-photo page shards and `ids/` lookup shards
(asset ID to position, 256 at most) per revision, and WebP thumbnail/display
assets. Revisions activated before sharding keep a whole v1 `manifest.json`;
this Worker reads `index.json` first and falls back to `manifest.json` for
them, and searches the page shards for a photo in a revision that predates the
lookup shards. New revisions write no manifest. `GET` and `HEAD` for the gallery
page, photo detail page, and each image reread the active pointer. A missing
pointer, old revision, or asset absent from the active revision returns 404.
Pages, page JSON and photo pages use `no-store`; images use
`private, max-age=60`, so an unpublished gallery's images can stay in a
visitor's browser for up to a minute. All responses are `noindex`, and
`/robots.txt` disallows crawling. The index, page shards and lookup shards of a
revision never change, so the Worker keeps the 256 most recent in isolate
memory; only the pointer is read on every request.

The page is Svelte (`modules/gallery/public/app/`), rendered on the server by the
Worker and then taken over by a small browser bundle the same Worker serves
from `/_app/`. It uses the private Gallery's own presentation components from
`modules/gallery/src/components/gallery/view/` (justified rows, tiles, month headings, the
month spine, and the dark viewer), so both pages share one design. Without
scripts the page still reads and links: rows flow in CSS, each photo opens on
its own page, and page links lead on. With the bundle, rows are balanced to
the measured width, photos open in the viewer over the page with the arrow
keys, swipes, and a filmstrip, later pages load as the visitor scrolls from
`/g/:id/pages/:n.json`, and a month spine appears when the gallery is dated.

The page renders only reviewed fields: title, description, captions, alt text,
image geometry, and the photo details the owner kept switched on in the review
(date taken, camera and exposure, and location). A dated gallery in time order
also gets a month summary in its index for the headings and spine. Image
and page URLs contain the position in the reviewed order; the Worker checks
that position against one page shard before serving, which keeps reads bounded
for a large gallery. A photo's own address is `/g/:id/photos/:assetId`: it names
the asset alone, resolves its position through one lookup shard, and survives a
republish when the photo is unchanged (the private Worker reuses its asset ID).
Addresses of the earlier form, `/g/:id/photos/:revision/:position/:assetId`,
redirect to the new one when the asset is in the active revision. Each page and
photo read checks the active revision, and a browser that sees a newer
revision reloads. There is no private Hearthlog shell or API call. Public filenames, tenant/log IDs, private object keys,
and Access tokens are outside the manifest contract. The Content Security
Policy allows scripts and requests only from the Worker's own origin, and the
server output carries no inline handlers. Anyone with a live link can view and copy the published images.
Unpublish revokes the active pointer first. The private Worker then deletes
retired public revision keys in resumable batches, and a daily scheduled sweep
on the `st` site finishes interrupted cleanups and removes revisions that were
never activated (see the publication controller); the public Worker never
performs cleanup or gains a private bucket binding.

`hearthlog gallery-public:build [--site <id>]` (`pnpm gallery:public:build` here) builds the browser bundle and then the
Worker from the module's `public/` source into `dist/` beside the stack's generated
config, `.generated/shared/gallery-public/` (or `.generated/sites/<id>/gallery-public/` for a site on its own stack).
Run it before every deploy or dry run. Svelte's server
renderer needs the `nodejs_als` compatibility flag. `hearthlog build` writes the config from the
infrastructure names and canonical origins of the stack. The private frontend Worker
also binds the publication bucket for the authenticated management
endpoint. `pnpm gallery:public:check` builds and type-checks the public code,
`pnpm gallery:public:dry-run` compiles its deployment package without upload,
and `pnpm gallery:public:smoke` verifies that the anonymous production hostname
reaches this Worker. The smoke check expects its exact `/robots.txt` response
and its `noindex` 404 for a missing gallery; Cloudflare's placeholder page,
Access redirects, and error 1042 fail the check.

The private management endpoint is implemented. The production deploy workflow
deploys this Worker once after tenant provisioning and runs the anonymous smoke
check. A successful private publish only proves the snapshot reached the public
bucket; it does not prove the public hostname is routed. For an existing broken
hostname, deploy the generated `.generated/shared/gallery-public/wrangler.jsonc` Worker
and run the probe:

```bash
pnpm gallery:public:check
pnpm exec wrangler deploy --config .generated/shared/gallery-public/wrangler.jsonc
pnpm gallery:public:smoke
```

If the smoke check still fails, inspect
Workers & Pages → `st-gallery-public` → Settings → Domains & Routes and any
account-wide or Worker-level Access protection. Keep every storage change
readable by the previously deployed public Worker.
