# Received-invoice extraction from PDF — implementation plan

**Status:** Phase 1 implemented; Phase 2 implemented — preflight and model bake-off pending GCP credentials
**Scope:** Invoices page → **Received** tab (`/invoices`)
**Phases:** 1) deterministic ISDOC extraction (client-side), 2) LLM extraction (frontend Worker ↔ Vertex Gemini)
**Last updated:** 2026-09-13

---

## 1. Outcome

Adding a received invoice currently requires typing every field by hand. This plan makes the PDF itself the source of the data:

- **Phase 1 — ISDOC (automatic, offline, free):** detect an embedded ISDOC XML attachment in the supplier PDF (PDF/A-3), parse it locally, prefill the form, and keep the XML as an immutable document on the invoice.
- **Phase 2 — LLM (explicit button, online):** for PDFs without ISDOC, send the PDF to Gemini via Vertex AI and prefill the same fields from structured output.

Both paths converge on one extraction model and one review UI. **Nothing is saved without the user pressing Save.** Phase 2 reuses Phase 1's schema, merge logic and UI, so it is purely additive.

---

## 2. Current state (grounding)

| Area | Today |
| --- | --- |
| Upload UI | `src/lib/components/invoices/ReceivedInvoices.svelte` — manual supplier/number/amount/issue/due fields; PDF validated as `%PDF-` ≤ 25 MiB |
| Device storage | `src/lib/invoices/received-file-store.ts` — IndexedDB `stor-received-invoice-files` v1, one PDF per invoice, upload queue with backoff |
| Remote storage | R2 `INVOICE_PDFS`, key `received/v1/{appId}/{logId}/{invoiceId}/{fileId}` via `/api/received-invoice-files/v1/logs/{logId}/invoices/{invoiceId}/files/{fileId}` (`worker/received-invoice-files.ts`) |
| Entity | `received_invoice` in `src/lib/event/entity-definitions.ts` (schema v24): supplier name/id, number, gross amount, currency, dates, status, file fields, storage status |
| Commands | `RECEIVED_INVOICE_ADDED/UPDATED/REMOVED` (existing; payload fields are optional-friendly) |
| PDF parsing / AI | None anywhere. No AI binding in `wrangler.jsonc`. |
| Relevant infra | External Cloud Run renderer in GCP project `your-gcp-project` (generation only); Worker already calls it with a bearer token |

---

## 3. Decision log (locked)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Extraction paths | Both available as user choices; ISDOC auto-attempted on file select, AI behind an explicit button | Deterministic data whenever present; user controls cost/network |
| AI results | Always prefilled for review; never auto-saved | LLM output is probabilistic |
| Stored document | Keep the ISDOC XML as an immutable attachment | Audit value; enables future re-import; mirrors PDF versioning |
| Field scope | Full document: header + supplier identity + payment + line items + VAT | ISDOC carries it all; one schema serves both paths |
| AI provider | **Gemini via Vertex AI** (`aiplatform.googleapis.com`), model as config (`gemini-3.8-flash` default candidate) | Native PDF input; document/OCR strength; postpaid on the existing GCP project |
| AI hosting | Frontend Worker calls Vertex directly | Same pattern as the existing renderer proxy; no new GCP service |
| Billing | GCP postpay on `your-gcp-project`; **AI Studio (`ai.google.dev`) rejected** | AI Studio Gemini API is force-migrating to Prepay (deadline 2026-09-14): $5–10 minimum, credits expire after 12 months. Vertex stays on the normal monthly GCP bill. |
| Phase order | Phase 1 ISDOC first, Phase 2 LLM | Smallest risk, fully offline, validates the data model before the provider work |
| DeepSeek | Deferred | Its API accepts images only (JPEG/PNG/WebP), not PDFs — would require client-side rasterization |
| OpenAI / Anthropic | Deferred adapters | OpenAI direct requires a $5 prepaying balance that expires yearly; revisit via Bedrock/Azure only if a bake-off favors GPT-5.6 Luna |

---

## 4. Cost reference (2026-09 rate cards, ≈ 21 CZK/USD)

Assumptions: 1-page ≈ 3,000 input / 900 output tokens; 3-page ≈ 8,000 / 1,500. Retries and thinking tokens excluded (~ +20% in practice). ISDOC path costs **0 Kč**.

| Model | $/1M in → out | 1-page | 3-page | 50 invoices/mo |
| --- | --- | --- | --- | --- |
| DeepSeek V4.1 Flash (off-peak, needs rasterization) | 0.15 → 0.60 | ~0.015 Kč | ~0.03 Kč | ~0.7 Kč |
| GPT-5.6 Luna | 0.20 → 1.20 | ~0.035 Kč | ~0.07 Kč | ~1.8 Kč |
| Gemini 3.1 Flash-Lite | 0.25 → 1.50 | ~0.04 Kč | ~0.09 Kč | ~2 Kč |
| **Gemini 3.8 Flash (Vertex, intro through 2026-12-31)** | 0.75 → 3.75 | ~0.12 Kč | ~0.24 Kč | ~6 Kč |
| Gemini 3.8 Flash from 2027-01-01 | 1.50 → 7.50 | ~0.24 Kč | ~0.49 Kč | ~12 Kč |
| Claude Opus 5 | 5.00 → 25.00 | ~0.79 Kč | ~1.63 Kč | ~39 Kč |

Vertex pricing matches AI Studio; the global endpoint is the cheapest tier (EU/non-global is +10%). Vertex bills monthly on the existing GCP billing account — no top-up, no expiring credits.

---

## 5. Architecture

```text
ReceivedInvoices.svelte (Drawer)
  │ file select
  ├─ Phase 1: ISDOC (browser, offline)
  │    pdf-lib (dynamic import, optionally Web Worker)
  │    └─ getAttachments() → find *.isdoc → XML → map → ExtractedInvoice
  │
  ├─ Phase 2: [Read with AI] (online)
  │    POST /api/received-invoice-extraction/v1/logs/{logId}
  │      frontend Worker ── Access auth + log verification + caps
  │        └─ fetch aiplatform.googleapis.com (Vertex Gemini, express key or SA OAuth)
  │
  └─ merge → form fields + warnings + provenance
       └─ Save → RECEIVED_INVOICE_ADDED/UPDATED (existing commands)
            ├─ PDF       → IndexedDB + R2 `received/v1/...` (existing)
            └─ ISDOC XML → IndexedDB + R2 `received-isdoc/v1/...` (Phase 1)
```

New client modules: `src/lib/invoices/extraction/` — `types.ts`, `schema.ts` (TypeBox, shared with the Worker like `src/lib/api/invoice-pdf-fingerprint.ts`), `isdoc.ts`, `pdf-extract.ts`, `ai.ts` (Phase 2), `merge.ts`.

New Worker module (Phase 2 only): `worker/received-invoice-extraction.ts` (+ `worker/extraction/vertex.ts`).

---

## 6. Shared data model (delivered in Phase 1, reused by Phase 2)

### 6.1 Entity fields — `received_invoice` (`src/lib/event/entity-definitions.ts`)

| Group | Fields | Notes |
| --- | --- | --- |
| Full document | `items` (TEXT JSON, default `'[]'`), `subtotal` (REAL), `vat_total` (REAL, payloadKey `vatTotal`), `tax_point_date` (TEXT, payloadKey `taxPointDate`), `vat_applicable` (BOOLEAN, optional) | `amount` keeps its current meaning: **gross payable**. Items use the generated-invoice shape (`description, quantity, unitPrice, vatRate`). |
| Supplier identity | `supplier_ico`, `supplier_dic` | Match `invoice_parties` by IČO first, then the existing name match; never auto-create a party |
| Payment | `bank_account`, `variable_symbol` | Display-only in the first iteration |
| ISDOC attachment | `isdoc_file_id`, `isdoc_file_name`, `isdoc_size_bytes`, `isdoc_storage_status` | Mirrors the PDF fields; empty string / `0` means no attachment |
| Provenance | `extraction_source` (`'isdoc' | 'ai' | 'manual' | ''`), `extraction_metadata` (TEXT JSON: source, provider, model, token usage, extractedAt, warnings) | `'ai'` stays unused until Phase 2 — no second migration needed |

### 6.2 Migration

1. `src/lib/db/schema-version.ts`: bump **24 → 25** with a new comment line.
2. `src/lib/db/index.ts`: explicit `addColumn` statements for every new column (the v23/v24 pattern; `CREATE TABLE IF NOT EXISTS` does not alter existing tables).
3. `pnpm generate:entities` regenerates `src/lib/event/types.generated.ts`, `src/lib/db/schema.generated.ts`, `src/lib/commands/standard.generated.ts`; `generate:entities:check` must pass.
4. Read model rebuilds automatically via `rebuildIfSchemaChanged()` from `raw_events`. No event-type changes are required.

### 6.3 Device file store (`src/lib/invoices/received-file-store.ts`)

- IndexedDB `stor-received-invoice-files` v1 → **v2**: add `kind: 'pdf' | 'isdoc'` to `files` and `uploads` entries. Existing rows without `kind` are treated as `'pdf'`.
- Generalize queue/upload/retry/coordinator internals per kind (endpoint + content type); keep exported function names stable where the component uses them.
- Separate statuses: `storage_status` (PDF) and `isdoc_storage_status`.

### 6.4 Remote storage routes

- Existing PDF route unchanged.
- New route in `worker/received-invoice-files.ts`:
  `GET|PUT /api/received-invoice-files/v1/logs/{logId}/invoices/{invoiceId}/isdoc/{fileId}`
  - `PUT`: `Content-Type: application/xml` (accept `application/x-isdoc`), ≤ 5 MiB, light payload check (starts with `<?xml` / contains `<Invoice`); immutable conditional write like the PDF route.
  - `GET`: returns `application/xml; charset=utf-8` with safe inline/download disposition.
  - R2 key: `received-isdoc/v1/{appId}/{logId}/{invoiceId}/{fileId}`.
- Local dev: extend `localReceivedInvoiceFilesPlugin()` in `vite.config.ts` to accept the ISDOC route and content type.

---

## 7. Phase 1 — ISDOC (deterministic, client-side)

### 7.1 Extraction flow

1. On file selection, dynamically import `pdf-lib` (same lazy pattern as `@zxing` in `src/lib/calories/browser-barcode.ts`), load the PDF, read `getAttachments()`.
   - Move into a module Web Worker if 25 MiB documents jank the UI.
2. Find the ISDOC attachment (see 7.2).
3. Parse XML with `DOMParser`; map to `ExtractedInvoice` tolerantly (missing element → warning, not failure).
4. Validate numerics by recomputing line net/VAT/gross and totals with exact decimal handling (half-up rounding, same rules as `docs/invoice-generation.md`). Mismatches become warnings; never silently correct.
5. Show status in the drawer, prefill the form, queue the XML bytes for storage, and let the user review/save.

### 7.2 Attachment detection rules

- Prefer attachment file names ending in `.isdoc` (case-insensitive) or MIME `application/x-isdoc` / `application/isdoc`.
- Otherwise scan embedded file contents for XML whose root element is `Invoice` (local-name matching, namespace-agnostic). Accept ISDOC 6.x (`http://isdoc.cz/namespace/2013`) and older 5.x namespaces.
- Multiple candidates: prefer `.isdoc` names, then the first parseable ISDOC document.

### 7.3 ISDOC mapping

| ISDOC element | Field |
| --- | --- |
| `Invoice/ID`, `UUID` | invoice number; document UUID (metadata only for now) |
| `IssueDate`, `TaxPointDate` | issue date, DUZP |
| `AccountingSupplierParty/Party` `PartyName/Name`, `PartyIdentification/ID`, `PartyTaxScheme/CompanyID`, `PostalAddress` | supplier name, IČO, DIČ, address |
| `LegalMonetaryTotal` (`PayableAmount`, `TaxExclusiveAmount`, `TaxInclusiveAmount`), `TaxTotal/TaxAmount` | amount (gross), subtotal, vat_total |
| `LocalCurrencyCode` | currency (default CZK) |
| `Payment/Details` (`ID`, `BankCode`, `IBAN`, `BIC`, `VariableSymbol`, `PaymentDueDate`) | bank account, variable symbol, due date |
| `InvoiceLines/InvoiceLine` (`InvoicedQuantity`, `UnitPrice`, `Item/Description`, `ClassifiedTaxCategory/Percent`) | items |
| `VATApplicable` | vat_applicable |

### 7.4 Edge cases and warnings

- Encrypted PDFs (pdf-lib throws) → warning, manual/AI fallback.
- No attachments / no ISDOC → neutral status, manual entry unchanged.
- Malformed XML or missing required elements → warnings, partial prefill.
- Credit notes / negative amounts, non-CZK currency, multiple VAT rates → flagged as review warnings (no credit-note modeling in v1).
- Totals that disagree with line arithmetic → warning shown next to totals.

### 7.5 Storage of the found ISDOC

- Queue XML bytes in IndexedDB with `kind: 'isdoc'`; upload to the new R2 route; track `isdoc_storage_status` with the same retry/backoff semantics as the PDF.
- Replacing the PDF does not delete an existing ISDOC unless the user removes it or the new PDF provides a replacement.
- Removal/Undo follows the existing file-retention semantics (objects stay; events restore visibility).

### 7.6 UI/UX (Drawer)

- On file select: "Looking for an attached ISDOC…" → "Filled from attached ISDOC" or "No attached ISDOC found."
- Extraction fills fields; fields the user has edited since the last extraction are never overwritten silently (dirty-set tracking; re-run asks before replacing).
- Source badge + warning list shown above the form fields; Save flow unchanged.
- Completeness still derives `unpaid` vs `review` (see open decision about warnings).

### 7.7 Details pane additions

- Line items table with VAT breakdown and totals (net/VAT/gross), DUZP, IČO/DIČ, bank account, variable symbol.
- Extraction source badge + warnings.
- "Electronic invoice (ISDOC)" document row next to the PDF, with view/download.

### 7.8 Tests

- Unit: ISDOC 6.0.2 and 5.x fixtures, Czech decimals ("1 234,56"), missing elements, multi-rate VAT, non-CZK, credit note, totals mismatch; decimal recomputation.
- PDF fixtures generated in test setup with pdf-lib: PDF+ISDOC, PDF without attachments, encrypted PDF.
- Worker: extend `src/lib/invoices/received-file.worker.test.ts` for the ISDOC route (auth, content type, size, immutability, retry semantics).
- Browser/E2E: upload with ISDOC → prefilled form → save → line items + attachment visible; upload without ISDOC unchanged.

### 7.9 Files touched

`src/lib/event/entity-definitions.ts` · `src/lib/db/schema-version.ts` · `src/lib/db/index.ts` · generated files via `pnpm generate:entities` · new `src/lib/invoices/extraction/*` · `src/lib/invoices/received-file-store.ts` · `src/lib/components/invoices/ReceivedInvoices.svelte` · `worker/received-invoice-files.ts` · `vite.config.ts` · tests/fixtures · README + a new `docs/received-invoice-extraction.md` describing the pipeline.

---

## 8. Phase 2 — LLM extraction (Vertex Gemini)

### 8.1 Preflight verification (before coding)

1. Verify the express-mode API key path with one curl: `POST https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent?key=...` with a small PDF as `inline_data`.
2. If the key is rejected for `aiplatform` (API-key restrictions tightened 2026-06), fall back to service-account auth (8.3).
3. Confirm `responseSchema` + `application/pdf` inline input behavior, token usage fields, and the request-size limit (inline request ≤ 20 MB; see caps).

### 8.2 Route contract

```
POST /api/received-invoice-extraction/v1/logs/{logId}
Content-Type: application/pdf     Body: raw PDF bytes (AI cap ≈ 10 MiB to stay under
                                  Vertex's 20 MB inline request limit after base64)
→ 200 { extraction, provider: "vertex", model, warnings[] }
→ 401/403 auth · 404 unknown log · 413 too large · 415 not a PDF
→ 502 provider failure/schema invalid · 503 not configured · 504 timeout
Cache-Control: no-store
```

Follows `worker/received-invoice-files.ts`: same-origin check, `authorizeStorRequest`, `verifyLogAppId`, `%PDF-` signature check, strict `no-store`/`nosniff`, cookies stripped, key never exposed.

### 8.3 Auth options (config-switchable)

| Option | Mechanics | Status |
| --- | --- | --- |
| Express-mode API key | `?key=...` query param; secret `INVOICE_EXTRACTION_API_KEY` | Preferred if the curl passes |
| Service account | SA JSON secret; Worker signs JWT (`jose`, RS256) → OAuth token cached ~55 min → `Authorization: Bearer`; project/location endpoint | Fallback / production-grade |
| Cloud Run renderer proxy | Reuse the renderer's GCP identity | Rejected for now — code lives outside this repo, extra hop; only if credential hygiene in Cloudflare demands it |

### 8.4 Provider request

- Model config: `INVOICE_EXTRACTION_PROVIDER=vertex`, `INVOICE_EXTRACTION_MODEL=gemini-3.8-flash` (alternatives `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`).
- Body: PDF as `inline_data` (`application/pdf`, base64) + extraction prompt; `generationConfig.responseMimeType = application/json` + `responseSchema` (TypeBox-derived); temperature 0; minimize thinking.
- One retry only on invalid/unparseable output; then fail with 502.
- Flow `gemini-3.1-flash-lite` fallback on quota/overload errors (`429`/`5xx`) is optional.

### 8.5 Prompt and output schema

- Extraction-only system instruction (Czech invoices, ISO dates, decimal strings, `null` for unknown; never invent).
- Shared TypeBox schema in `src/lib/invoices/extraction/schema.ts` imported by both client and Worker (precedent: `invoice-pdf-fingerprint.ts`).
- Output mirrors the ISDOC path: supplier name/IČO/DIČ/address, number, gross/subtotal/VAT totals, currency, issue/due/DUZP dates, bank account + variable symbol, items[], `uncertainFields[]` / `warnings[]`.

### 8.6 UI/UX

- "Read with AI" button in the drawer: visible when a PDF is chosen and the endpoint is configured; disabled offline with an explanation; first use explains the PDF leaves to Google Cloud.
- Spinner while running; result banner shows provider/model + "check the values" and warnings.
- Same dirty-field merge rules as Phase 1; both paths are re-runnable independently; Save unchanged.
- Details pane shows the same warnings/badge; `extraction_metadata` records provider, model, token usage, timestamp.

### 8.7 Provisioning and local dev

- `wrangler.jsonc`: add `/api/received-invoice-extraction/v1` (+ `/*`) to `assets.run_worker_first`; tenant configs regenerate from the base.
- `worker/index.ts`: dispatch the new prefix.
- `scripts/provision-tenants.ts`: push the Vertex key/SA secret via the existing bulk-secret path when present in the environment (same as `INVOICE_RENDERER_TOKEN`), with a warning when absent; update `.dev.vars.example`, `.env.example`, README.
- Local dev: Vite middleware proxy to Vertex using `gcloud auth print-access-token` or the express key; otherwise the endpoint returns 503 locally and the button stays hidden.

### 8.8 Tests

- Worker route: auth, origin, log verification, size/type caps, provider 4xx/5xx mapping, schema rejection, missing key → 503 (pattern: `src/lib/invoices/received-file.worker.test.ts`).
- Adapter: mocked `fetch` for key and SA paths; token caching; error mapping.
- Schema: TypeBox validation of representative good/bad payloads.
- Bake-off harness (manual, 5–10 real invoices): field-level accuracy vs GPT-5.6 Luna / Claude Sonnet 5; pin the default model from results.

### 8.9 Files touched

`worker/received-invoice-extraction.ts` · `worker/extraction/vertex.ts` · `worker/index.ts` · `wrangler.jsonc` (+ generated tenant configs) · `scripts/provision-tenants.ts` · `vite.config.ts` (local proxy) · `src/lib/invoices/extraction/{ai,schema,merge}.ts` · `ReceivedInvoices.svelte` · README / `.dev.vars.example` · worker tests.

---

## 9. Security and privacy

- ISDOC parsing is fully local; invoice data never leaves the device on that path.
- AI runs only on an explicit user action and only from the Worker (key never reaches the browser); the paid Vertex tier keeps data out of model training.
- Route hardening as in 8.2; output validated against a strict schema; extraction-only prompt with no tool use; results are review-only data (prompt injection cannot execute anything).
- Raw AI responses are not stored; `extraction_metadata` keeps only provider/model/usage/warnings.
- Size caps protect Worker memory (10 MiB AI path, 25 MiB storage path, 5 MiB ISDOC).

---

## 10. Out of scope

Standalone `.isdoc` uploads are supported as a choice when the PDF carries none · automatic AI extraction without a button · duplicate-invoice detection · credit notes, foreign-currency conversion, non-CZK display work · auto-creating supplier parties · PDF/A validation or signature verification · OpenAI/Anthropic/DeepSeek adapters (deferred) · storing the raw LLM response.

---

## 11. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| pdf-lib performance on large PDFs | Dynamic import first, Web Worker if profiling shows jank; cap ahead of the 25 MiB limit |
| LLM accuracy on scans/Czech | Review-first UI + warnings; bake-off before pinning the model; model is config, not code |
| Vertex express key restrictions | Preflight curl; service-account fallback; provider behind an adapter |
| Provider request-size limits | 10 MiB AI cap; clear message above it; ISDOC path unaffected |
| Read-model rebuild on schema bump | Established v23/v24 pattern; ships in Phase 1 alone so failures are isolated |
| Pathological retries inflating cost | One retry max; usage logged per extraction |

---

## 12. Open decisions (resolve during implementation)

1. Warnings → `review` status rule (recommended: any unresolved extraction warning keeps the invoice in **To review**).
2. Whether replacing/clearing the PDF may also clear an older ISDOC attachment (recommended: only explicit action, or when a new ISDOC replaces it).
3. Exact default model after the bake-off (`gemini-3.8-flash` vs `gemini-3.1-flash-lite`).
4. Whether the AI button gets a tenant opt-in flag on top of key presence (recommended: key presence is the gate).
5. Non-CZK formatting in list/detail views.

---

## 13. Milestones

### Phase 1 — ISDOC

- [x] P1.1 Entity fields + schema v25 migration + `pnpm generate:entities` + tests green
- [x] P1.2 `extraction/` types, TypeBox schema, decimal validation helper
- [x] P1.3 PDF attachment detection + ISDOC parser + fixtures (6.0.2 / 5.x, edge cases)
- [x] P1.4 Drawer prefill, status/warnings UI, dirty-field merge rules
- [x] P1.5 ISDOC immutable storage (IndexedDB v2, R2 route, local dev plugin)
- [x] P1.6 Details pane: line items, VAT, payment, supplier identity, document row
- [x] P1.7 E2E coverage + README/doc updates; `pnpm check:all` green

Implementation notes:

- pdf-lib 1.17 has no attachment **reader**; the embedded-file name tree is walked through its public low-level objects, and the library is type-only imported with a dynamic module load so it stays a separate lazy bundle chunk (~174 KiB gzip).
- E2E generates an ISDOC-bearing PDF in the test with pdf-lib and verifies prefill, save, breakdown, and XML download.

### Phase 2 — LLM (Vertex Gemini)

- [ ] P2.1 Preflight curl: express key, `responseSchema`, PDF inline limits
- [x] P2.2 Worker route + Vertex adapter + schema validation + worker tests
- [x] P2.3 Provisioning, secrets, local-dev fallback, `run_worker_first`
- [x] P2.4 AI button, merge/review UI, offline behavior
- [ ] P2.5 Bake-off on 5–10 real invoices; pin model; usage logging review
- [x] P2.6 Docs + `pnpm check:all` green

Implementation notes:

- The Vertex AI API was not enabled on `your-gcp-project` when this landed, so P2.1 (a real provider call) and P2.5 (a real-document bake-off) still need credentials; setup steps are in `docs/received-invoice-extraction.md`.
- Local Vite dev has no Worker or Access session, so the extraction route answers `503` there (same error shape as an unconfigured Worker) instead of proxying to Vertex; the AI flow is covered by Worker/adapter unit tests and a Playwright test with a mocked provider response.
- Auth supports the express-mode API key first and a service-account JSON fallback; model and location are non-secret vars (`gemini-3.8-flash`, `global`).
