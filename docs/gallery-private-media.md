# Gallery private originals

The private frontend Worker owns `PUT`, `GET`, and `HEAD` at
`/api/gallery-files/v1/logs/:logId/photos/:photoId/versions/:fileVersionId/original`.
Every request requires the tenant's Cloudflare Access identity and the Ledger
service binding. The Worker resolves the app and log through Ledger, then asks
Ledger whether the exact photo version appears in accepted history for that
log. Missing or preparing logs, and unreferenced versions, cannot read or write
R2. Cross-origin browser requests are rejected.

Objects use `v1/<appId>/<photoId>/<fileVersionId>/<variant>` in the private
`GALLERY_FILES` bucket. Forked logs therefore reuse the same original bytes;
their separate Ledger reference index decides access. The key contains no log
ID. Upload is limited to 20 MiB and JPEG, PNG, WebP, HEIC, or HEIF signatures.
The Worker calculates SHA-256, stores it with the object, uses a conditional
create, returns success for an identical retry, and rejects different bytes
for the same version. There is no delete endpoint because accepted history and
forks may still need the object. All responses are `no-store` and `nosniff`.

The bucket binding and names come from `tenants.json` and generated tenant
Wrangler configuration. `ensure-tenant` will provision the production and
staging Gallery buckets when remote provisioning is explicitly requested.
This repository change does not provision a bucket or deploy a Worker.

The Worker uses its `IMAGES` binding to create immutable 480 px thumbnail
and 2048 px display WebP variants after storing the original. If processing
fails, the original remains and a retry fills only missing variants. A
variant read that finds no derivative but finds the original rebuilds the
derivative on demand, so previews never depend on the uploading device. The
browser does not count that upload as synced until all three objects exist.
Only the original can be uploaded by the browser. Every variant read repeats
the same Ledger reference check.

Local browser staging, upload retry, and the Gallery page are described in
[Private Gallery page](gallery-page.md). A `HEAD` 404 means that an accepted
photo reference has no uploaded variant yet; the client presents it as pending
or unavailable, not as a synced photo.

Developer → Local storage reports the Gallery IndexedDB Blob count and byte
total alongside its upload queue entry count. These are local browser figures;
the browser quota also includes SQLite, caches, and overhead, and they are not
a count of remote R2 objects.
