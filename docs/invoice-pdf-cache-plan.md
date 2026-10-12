# Cache invoice PDFs in R2 and on the device, with a large preview modal

Agreed on 2026-09-12. This is an implementation handoff; saving this document does not mean the feature has been implemented or deployed.

Historical plan: its history-mode restrictions no longer apply after the Log fork cleanup. See [Log history and forking](history-and-restore.md) for current behavior.

## Summary

Open a large PDF preview modal immediately when the user requests an invoice PDF. While the document is being loaded or generated, keep the modal visible with a simple “Loading invoice…” indicator. Show the PDF in that same modal when it is ready, with an explicit Download action.

Generate PDFs only when requested. Check the device cache first, then private R2 storage, and call the renderer only when neither contains a matching document. Viewing and downloading share the same PDF bytes and cache lookup.

Keep one saved PDF per invoice. Edits invalidate it immediately through a content fingerprint; its stored bytes are replaced after the next successful generation. Use R2 alone, accepting occasional duplicate renders and extra cache misses from concurrent or outdated devices.

## Existing architecture and ownership

The user explicitly confirmed that caching belongs in the existing Hearthlog Worker. The original external renderer continues generating every new PDF. No additional Worker or Durable Object is required.

The SvelteKit frontend remains a static export. `/Users/neo/personal/st/vite.config.ts` (the `sveltekit()` plugin options) uses `adapter-static` to produce the frontend files. `/Users/neo/personal/st/wrangler.jsonc` deploys those assets together with `/Users/neo/personal/st/worker/index.ts` and routes `/api/invoice-generation/*` through that Worker's fetch handler. API logic belongs in the Worker, without introducing SvelteKit SSR or dynamic `+server.ts` routes.

The current browser client is `/Users/neo/personal/st/src/lib/api/invoice-renderer.ts`; its existing gateway is `/Users/neo/personal/st/worker/invoice-renderer.ts`. The gateway already calls the external renderer because its bearer credential must stay out of the browser and the renderer does not support browser CORS preflights. Extend this existing gateway with caching.

The intended preview and download flow is:

```text
User selects View PDF
  -> Open the large modal immediately with “Loading invoice…”
  -> Browser: build current invoice snapshot and fingerprint
  -> Matching local IndexedDB PDF: show the saved document
  -> Otherwise: same-origin Hearthlog Worker endpoint
       -> Matching private R2 PDF: return saved document
       -> Otherwise: original PDF renderer -> save in R2 -> return PDF
  -> Save successful current result in IndexedDB and show it in the modal
  -> User selects Download: download those same PDF bytes without another request
```

Reuse the authorization and private-object scoping pattern in `/Users/neo/personal/st/worker/vacation-files.ts` and the offline-storage patterns in `/Users/neo/personal/st/src/lib/vacations/file-store.ts`. The renderer contract is documented in `/Users/neo/personal/st/docs/invoice-generation.md` and `/Users/neo/personal/st/docs/invoice-generation.openapi.yaml`.

## Storage and invalidation

- Add a dedicated private `INVOICE_PDFS` bucket binding, with separate production and staging buckets. Scope every object by server-verified Ledger application, log, and invoice ID.
- Store one PDF object per invoice, with its fingerprint, filename, generation time, renderer revision, and existing PDF/ISDOC response metadata. Keep cache state outside invoice events and projections.
- Share a deterministic SHA-256 fingerprint implementation between browser and Worker. Include the normalized document snapshot, full supplier/customer details, locale, and an explicit renderer revision. Preserve line-item order.
- Exclude audit timestamps, sync metadata, and calculated overdue state. Normalize status to **draft versus issued**: this distinction changes the renderer's heading; sent, paid, and overdue share the issued identity.
- Any document edit—including party address or bank-account changes—produces a different fingerprint. Recompute from current data whenever resolving a PDF for preview or download; no edit-triggered network invalidation is required.
- Bump the shared renderer revision whenever templates, calculations, fonts, or embedded-document behavior change. Existing PDFs regenerate lazily.
- Replace the PDF and metadata together using conditional R2 writes. A competing write may cause the new result to remain uncached, but the requesting user still receives the correct generated PDF. R2 supports conditional writes and strongly consistent object replacement. [Cloudflare R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

## Gateway and client behavior

### Gateway

- Add `POST /api/invoice-generation/logs/{logId}/pdf`, retaining the existing invoice snapshot body and binary PDF response. The Worker computes the fingerprint itself.
- Verify the Access identity, tenant authorization, and log membership before accessing R2 or generating a document. Reuse the vacation-file authorization pattern; never accept a client-supplied bucket key.
- On an exact match, stream the saved PDF. Otherwise call the existing stateless renderer, validate the successful PDF response, save it, and return it.
- Preserve attachment and PDF/ISDOC metadata headers. Add cache-source, fingerprint, and renderer-revision response headers for diagnostics.
- Keep the existing unscoped renderer endpoints compatible and uncached. The external renderer contract stays unchanged.
- Keep buckets private and responses `private, no-store`; application-managed IndexedDB provides offline storage.
- Never cache errors, authentication pages, empty responses, or interrupted output. A storage failure may return a successfully generated PDF without caching it; never substitute a mismatching old PDF.

### Device cache and UI

- Add a dedicated IndexedDB cache containing one PDF per tenant/log/invoice, with the same fingerprint and revision.
- An exact local match supports preview and download without network access. An offline miss explains inside the modal that the current invoice version needs to be loaded online first.
- Coalesce identical requests within the current tab. Before saving, displaying, or downloading a result, recheck the active scope, invoice existence, and fingerprint; discard results superseded by edits or navigation.
- Disable PDF preview and download in history mode in both action menus and the details drawer, with a handler-level guard.
- Treat browser storage eviction or quota failure as a cache miss, without breaking an otherwise successful download.

### Large PDF preview modal

- Replace the current immediate-download entry points in the invoice action menu and details drawer with **View PDF**. Both open the same modal. Opening it does not automatically save a file to the user's Downloads folder.
- Open the modal before awaiting snapshot preparation, IndexedDB, network requests, or generation. Keep its large dimensions stable while loading, showing only a centered spinner and **Loading invoice…** in the document area. Keep the invoice number/title and Close control visible. Do not show the existing generation progress toast in parallel or expose cache/renderer implementation details in the modal.
- Use a dedicated `InvoicePdfModal.svelte` built with the existing Bits UI Dialog primitives. The current shared `Modal.svelte` is limited to a small desktop width; keep its existing consumers unchanged. Center the PDF modal on desktop at approximately `96vw`, capped at `1440px`, and `92dvh` high. On mobile use the full available viewport with safe-area insets. Keep the header/actions fixed and allow the document area to fill and scroll within the remaining space.
- Once ready, display the actual PDF through an embedded browser PDF viewer using a blob URL; do not reconstruct an HTML approximation. Provide **Download** and **Open in new tab** actions using the same resolved blob, including a usable fallback when inline PDF viewing is unsupported. Enable these actions only after the current document is ready. Keep a loading indicator until the viewer is ready, and present an error rather than an indefinite spinner if loading fails.
- Separate resolving the PDF blob and filename from initiating a download in the client API. The modal owns the displayed blob URL, and its Download action reuses the prepared document without another gateway or renderer request.
- Model the modal states explicitly as loading, ready, and error. For generation, network, or offline-cache errors, keep the modal open with a concise message and **Retry**/**Close** controls. Retry runs the same cache-first flow. If the invoice changes while its preview is loading or open, remove the stale preview, disable Download, and offer **Reload preview**; never show or download the previous snapshot as current.
- Closing the modal while loading must take effect immediately. An already user-requested render may finish and populate the cache if its scope and fingerprint remain valid, but must not reopen the modal or trigger a download. Reopening the same invoice joins the existing in-flight request where possible. Revoke viewer blob URLs when replaced or closed, while preserving any URL still needed by a just-started download or separately opened PDF.
- Preserve dialog accessibility: accessible title and PDF-frame title, trapped focus, Escape/Close dismissal, focus restoration, and an announced loading/error state. When opened from the invoice details drawer, close the drawer first so there is only one active modal focus trap. Handle focus restoration to the invoice action when the original trigger is no longer mounted. Respect tenant colors and dark mode around the document; preserve the PDF's original colors.

### Deletion

- Remove the local PDF after invoice deletion and persist a cleanup operation tied to the removal event.
- Process remote cleanup after that event synchronizes. Reconcile cleanup on startup and after commits/sync, and cancel pending cleanup if Undo or restore makes the invoice exist again.
- Add an authenticated, scoped deletion endpoint. Replace the R2 PDF with a small, uniquely identified deletion marker so conditional writes from pre-deletion renders cannot restore its bytes. A later valid download after Undo can replace that marker.
- Retry failed cleanup across reconnects. Cleanup remains pending while the app is offline or closed.

## Validation and rollout

- Verify first preview renders once, its Download action makes no additional request, repeat preview uses IndexedDB, and a fresh device retrieves from R2 without rendering.
- With a deliberately delayed PDF response, verify the large modal opens before the request resolves and visibly shows “Loading invoice…” throughout generation. The PDF must appear in the same modal without an automatic file download or duplicate progress toast.
- Verify ready/error/retry states, cached offline preview, offline misses, close and reopen during generation, stale-result suppression, and object-URL cleanup. Confirm closing does not cause a late modal reopen or unsolicited download, and reopening joins the pending request rather than generating again.
- Check desktop and mobile sizing, multi-page PDF viewing, fixed accessible actions, keyboard dismissal/focus restoration, and the Open in new tab/Download fallback. Verify preview and download stay disabled in history mode.
- Verify invoice content, party details, draft/issued transitions, locale, and renderer revision invalidate; sent-to-paid changes and becoming overdue do not.
- Cover offline edits, Undo, deletion/reconnect cleanup, history restrictions, tenant/log switching, and edits during generation.
- Exercise concurrent requests, conditional-write conflicts, deletion during rendering, invalid renderer responses, R2 failures, and IndexedDB quota failures.
- Verify unauthorized and cross-tenant requests cannot read, replace, or remove PDFs.
- Update tenant configuration generation, provisioning, Worker types, local development routing, and documentation. Exercise the real Worker with local R2 during integration tests.
- Run application checks, unit tests, invoice/history browser tests, tenant configuration checks, Worker checks, and build validation. Verify staging cache hits and Access protection before production rollout.
- Record cache hits/misses, renderer calls, generation duration, and storage/cleanup failures without logging invoice contents.

## Accepted defaults and handoff constraints

- PDF caching only; no historical PDF archive, background generation, or Durable Object.
- The invoice PDF action opens a large preview modal immediately. Its loading body shows “Loading invoice…” until the PDF is available; downloading is an explicit action inside the modal and reuses the displayed bytes. An already user-requested render may finish caching after the modal closes; edits alone still never start generation.
- “Latest” means one retained export per invoice, not an authoritative server revision: outdated devices may cause additional renders, but fingerprint checks always prevent serving a different document snapshot.
- Edits make the old document ineligible immediately, but do not delete its stored bytes until a replacement is successfully generated. No time-based expiration was selected.
- History mode disables PDF preview and downloads. Returning to a previous state through Undo or restore in the current view can generate a PDF again.
- Invoice deletion removes the device copy and queues remote cleanup after synchronization.
- Keep both the static SvelteKit export and the original stateless renderer. Caching and access control belong in Hearthlog's existing Worker.
- The repository contained substantial unrelated changes when this plan was prepared. Inspect the current tree before implementing and preserve unrelated work.
