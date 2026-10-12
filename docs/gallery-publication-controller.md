# Private Gallery publication controller

The private frontend Worker owns public export preparation. Its endpoints are
under `/api/gallery-publications/v1/logs/:logId/publications/:publicationId`.
They require the normal tenant Cloudflare Access session and the exact source
log scope. The public Worker has only the separate `GALLERY_PUBLIC` bucket and
cannot call Ledger or read private originals.

1. `PUT /revisions/:revision` accepts the reviewed title, description, ordered
   photo IDs, immutable file version IDs, public captions, alt text,
   dimensions, and the photo details the owner kept (date taken, camera,
   lens, exposure, location). Unknown fields are dropped and details are
   checked for shape. Repeating the same revision with identical content resumes it;
   changed content receives `409`. A source log owns the publication ID.
   `GET` on the revision returns that same private review for an interrupted
   publish or later edit.
   A photo that is unchanged since the live revision (same source photo and file
   version) keeps its public asset ID, so its public address survives a
   republish; other photos get new IDs.
2. `POST /revisions/:revision/chunks/:index` verifies every selected file
   reference against accepted Ledger history and checks the original in
   `GALLERY_FILES`. It makes 640px thumbnail and 2400px display WebP copies via
   Cloudflare Images and stores them under immutable revision keys in
   `GALLERY_PUBLIC`. Each eight-photo chunk has a durable completion marker.
3. `POST /revisions/:revision/activate` requires all chunk markers and every
   public variant. It writes immutable 100-photo page shards, `ids/` lookup
   shards (asset ID to position), and a small publication index (with a month
   summary when every photo is dated and the photos run in time order), then
   changes the active pointer conditionally. It no longer writes the whole v1
   manifest, so a public Worker older than page sharding cannot read new
   revisions. If another revision or unpublish changed the pointer
   since review, activation returns `409` for a fresh review.
4. `GET` on the publication root returns the active revision and public URL.
   `POST /unpublish` replaces the pointer with a tombstone. The public page and
   each asset read check this pointer and use `no-store`, so revocation takes
   effect at the Worker; already downloaded copies cannot be recalled.
5. Activation and unpublish record each retired revision in a private cleanup
   queue before changing the pointer. `GET` status includes those revisions;
   `POST /revisions/:revision/cleanup` deletes up to 1,000 public objects per
   call, then drops the revision's chunk markers; the draft stays so a review can
   be reopened later. The private UI resumes cleanup on a later Shared visit if
   interrupted.
   Cleanup conditionally rewrites the active pointer before deletion, so a
   stale publish attempt cannot activate the revision being cleaned. A
   simultaneous fresh review may receive `409` and need to be reviewed again.

6. A daily scheduled sweep (`scheduled` in `packages/cloudflare/src/gateway.ts`, cron in
   `wrangler.jsonc`, `sweepGalleryPublications`) finishes every queued cleanup and
   retires public revisions that are not active, not queued, and had no write for
   14 days, such as a review whose publish was abandoned. It puts them through
   the same cleanup, and writes a `{ revision: null }` pointer first for a
   gallery that was never published, so a stale review cannot activate. The
   buckets are shared by every site, so only the `st` Worker carries the trigger.
   Each run takes up to 100 publications and the next continues after them.

The browser should append a `gallery_publication` intent event before calling
these endpoints. Durable progress is owned by the Worker and R2, so a browser
can retry an interrupted publish with the same revision. A new review uses a
new revision ID. Public URLs are unlisted links, not authorization tokens.
