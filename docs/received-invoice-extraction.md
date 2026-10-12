# Received-invoice extraction

Selecting a supplier PDF in the upload drawer prefills the **Received** tab form. Three paths are available, depending on what the supplier sent:

1. **Embedded ISDOC** — read on the device from the PDF's attachment (implemented).
2. **Standalone ISDOC file** — uploaded separately when the PDF carries none (implemented).
3. **AI reading** — an explicit click sends the PDF to Google Cloud (implemented).
4. Manual entry always remains available; nothing is saved without review.

The deterministic paths run entirely in the browser: the PDF never leaves the device to be read, and they work offline. AI reading sends the PDF to Google Cloud only after the user clicks **Read with AI**.

## Embedded ISDOC flow

1. Selecting a PDF in the upload drawer starts `readIsdocFromPdf()` (`modules/invoices/src/invoices/extraction/pdf-extract.ts`).
2. `pdf-lib` is loaded dynamically (a separate lazy bundle chunk) and the PDF's `/Names → /EmbeddedFiles` name tree is walked through pdf-lib's public low-level objects, because pdf-lib 1.17 can write attachments but has no attachment reader.
3. The ISDOC candidate is chosen by name/MIME (`*.isdoc`, ISDOC MIME) first, then by content: XML whose root is `Invoice` in an ISDOC or absent namespace.
4. `mapIsdocDocument()` (`modules/invoices/src/invoices/extraction/isdoc.ts`) maps the XML to the shared `ExtractedInvoice` model. Matching is namespace-tolerant (ISDOC 6.x and 5.x) and never invents values: absent elements become empty or warnings.
5. `totalWarnings()` recomputes line and document amounts with the invoice-generation rounding contract (`net = round(quantity × unitPrice)`, `vat = round(net × rate / 100)`) and reports mismatches without changing declared values.
6. The drawer merges the result through `mergeExtraction()` (`modules/invoices/src/invoices/extraction/merge.ts`): empty and untouched fields are filled; fields the user edited are kept and reported. Save stays a manual action.

## Standalone ISDOC file

When the PDF has no embedded ISDOC, the drawer offers **Upload ISDOC file** next to the AI and manual options. `readIsdocFile()` accepts `.isdoc`/`.xml` up to 5 MiB, rejects binary or non-ISDOC XML, and runs the same mapper and warnings as the embedded path. The uploaded bytes are stored verbatim as the invoice's electronic document, with `origin: "separate"` recorded in `extraction_metadata` so the details pane shows **Uploaded ISDOC file** instead of **Attached ISDOC**. Uploading the file replaces the current form values through the same merge rules; if AI had already filled the form, the user's edits are still preserved.

## Field mapping

| ISDOC element | Stored field |
| --- | --- |
| `Invoice/ID` | `invoice_number` |
| `IssueDate`, `TaxPointDate` | `issue_date`, `tax_point_date` |
| `VATApplicable` | `vat_applicable` |
| `LocalCurrencyCode` | `currency` (default CZK) |
| `AccountingSupplierParty/Party` name, ID, DIČ, address | `supplier_name`, `supplier_ico`, `supplier_dic`, and the display address used for the details pane |
| `LegalMonetaryTotal` `TaxExclusiveAmount`, `PayableAmount`, `TaxTotal/TaxAmount` | `subtotal`, `amount` (gross payable), `vat_total` |
| `Payment/Details` account, bank code, IBAN, symbols, `PaymentDueDate` | `bank_account`, `variable_symbol`, `due_date` |
| `InvoiceLines/InvoiceLine` | `items` (description, quantity, net unit price, VAT rate) |

## Warnings

Extraction is assistive, not authoritative. Warnings are stored with the invoice (`extraction_metadata`) and shown in the drawer and details pane:

- `missing-field` — a field the document usually carries is absent.
- `totals-mismatch` — declared totals disagree with line arithmetic.
- `zero-payable` — the document states nothing left to pay (usually already settled); the invoice total is used instead.
- `negative-amount` — credit-note-shaped total (not modeled yet).
- `foreign-currency` — non-CZK document.
- `unreadable-pdf` / `invalid-isdoc` — the file could not be read.

Supplier-declared line amounts (`LineExtensionAmount`, `LineExtensionTaxAmount`) are authoritative for validation: suppliers round VAT differently (Alza truncates `45.486` to `45.48`), and recomputing would flag legitimate invoices. Recalculation is only a fallback when a line carries no declared amounts. Money is canonicalized to two decimals everywhere (ISDOC commonly uses four, e.g. `216.6000`), so the form parser and stored values stay consistent.

The invoice status rule is unchanged: complete fields save as unpaid, incomplete as **To review**.

## Storage

The found or uploaded XML is retained as an immutable attachment alongside the PDF:

- Device: IndexedDB `stor-received-invoice-files` (`kind: 'pdf' | 'isdoc'`, defaulting to PDF for rows written before the field existed), queued and retried like the PDF.
- Server: `PUT|GET /api/received-invoice-files/v1/logs/{logId}/invoices/{invoiceId}/isdoc/{fileId}` (`modules/invoices/src/server/invoice-files.ts`), stored under `received-isdoc/v1/{appId}/{logId}/{invoiceId}/{fileId}` in the private `INVOICE_PDFS` bucket. Uploads are immutable versions; retries are idempotent. Standalone files use the same route.
- Entity: `isdoc_file_id`, `isdoc_file_name`, `isdoc_size_bytes`, `isdoc_storage_status`, plus `extraction_source` and `extraction_metadata` (schema v25). A separately uploaded file records `origin: "separate"` so the source label stays truthful.

Vite dev has no Worker/R2: `localReceivedInvoiceFilesPlugin()` keeps uploaded originals in the dev-server process for both kinds.

## Details pane

The selected invoice shows the document breakdown (line items, VAT groups, subtotal/VAT/total), supplier identity, payment details, DUZP, the extraction source and warnings, and an **Electronic invoice (ISDOC)** card with view/download actions. Both directions share the issued drawer's detail layout, so the received drawer shows the same summary, party, line-item and document cards; its **Data source** section keeps the received-specific provenance. The source label distinguishes **Attached ISDOC**, **Uploaded ISDOC file**, and **AI (provider model)**. Viewing and downloading read the device copy first and fall back to the same-origin route.

## Duplicate warning

Saving a received or issued invoice first compares its normalized number and counterparty with the existing records of the same direction: the IČO when both sides have one, otherwise the case- and whitespace-insensitive name. A match opens a dialog listing the existing invoice(s); only **Import anyway** records the new copy, and cancelling leaves the form untouched. The check runs on every save — imports, manual creates and edits — and the edited record never matches itself. Matching lives in `modules/invoices/src/invoices/duplicates.ts`; `findInvoicesByNumber` / `findReceivedInvoicesByNumber` scope the number lookup to the tenant and log.

## Party directory

`invoice_parties` is one company directory: a record has no supplier/customer type, and the invoice slot (`supplier_id` / `customer_id`) decides the role, so one company serves both sides of an invoice. The **Parties** tab (`InvoiceParties.svelte`) searches, edits, removes and merges records; `INVOICEPARTY_UPDATED` / `INVOICEPARTY_REMOVED` are ordinary commands, and editing never rewrites issued documents — they keep their stored snapshots.

Creating or importing a party compares the normalized IČO first, then the case-insensitive name, and offers the existing record with **Use existing** or **Create anyway**. A merge writes one `INVOICEPARTY_UPDATED` on the losing record setting `merged_into` to the survivor: pickers hide aliases, `resolveInvoiceParty` / `resolveDirectoryParty` follow them, and one Undo reverts the merge. The duplicate list groups active records sharing an IČO or name, and the delete confirmation names how many invoices reference the record.

## Tests

- `modules/invoices/src/invoices/extraction/decimal.test.ts` — decimal parsing and rounding.
- `tests/received-invoices.spec.ts` — browser journey: a PDF kept on the device while offline and uploaded after reconnecting.

## Phase 2 — AI reading

For PDFs without a usable ISDOC, the drawer offers **Read with AI** alongside the standalone-ISDOC and manual options. Nothing is sent until it is clicked; the result flows through the same review UI and merge rules, and Save still requires the user.

- **Route:** `POST /api/received-invoice-extraction/v1/logs/{logId}` with the raw PDF (≤ 10 MiB), implemented in `modules/invoices/src/server/received-invoice-extraction.ts`. Access authentication, log verification, same-origin and size checks mirror the file routes.
- **Provider:** Gemini through Vertex AI (`aiplatform.googleapis.com`). The model is `INVOICE_EXTRACTION_MODEL` (default `gemini-3.8-flash`), the location is `INVOICE_EXTRACTION_LOCATION` (default `global`); both are non-secret vars in `wrangler.jsonc`. Vertex bills the normal Google Cloud account, so there are no prepaid credits or expiring balances.
- **Auth:** `INVOICE_EXTRACTION_API_KEY` (express-mode key) is preferred; `INVOICE_EXTRACTION_SERVICE_ACCOUNT` (JSON) is the fallback, where the Worker signs a JWT and caches the resulting OAuth token. `pnpm ensure:tenant -- --set-secret` pushes whichever is present in the environment; in CI, set the `VERTEX_API_KEY` / `VERTEX_SERVICE_ACCOUNT` repository secret (see [GitHub deployment](github-deployment.md)). Without a credential the route answers `503` and the UI hides the button.
- **Contract:** the provider request uses `EXTRACTION_SYSTEM_INSTRUCTION` and `EXTRACTION_RESPONSE_SCHEMA` (`modules/invoices/src/invoices/extraction/prompt.ts`); the response is validated against the shared TypeBox schema (`isExtractedInvoice`) before it is returned. Missing-field and totals warnings are computed server-side with the same validator as the ISDOC path.
- **Response:** `{ extraction, provider, model, warnings, usage }`. The client (`modules/invoices/src/invoices/extraction/ai.ts`) stores `extraction_source = 'ai'` and provider/model/token usage in `extraction_metadata`. An ISDOC XML found earlier is kept when AI refines the fields.
- **Failure behavior:** offline, timeout, rate limiting, oversized documents and invalid provider output each produce a specific message; the form stays editable and manual entry always remains possible.
- **Local development:** Vite has no Worker or Access session, so the local route answers `503` with the same error shape and the AI button hides. AI reading is exercised against a deployed environment; the browser flow is covered by a Playwright test that mocks the provider response.

## Phase 2 setup

1. Enable the Vertex AI API on the Google Cloud project used for the invoice renderer (`your-gcp-project`): `gcloud services enable aiplatform.googleapis.com --project your-gcp-project`.
2. Create an express-mode API key for Vertex, or a service account with `roles/aiplatform.user` and a JSON key.
3. Export one credential and push it to every site:

   ```sh
   INVOICE_EXTRACTION_API_KEY=... pnpm ensure:tenant -- --set-secret
   # or
   INVOICE_EXTRACTION_SERVICE_ACCOUNT="$(cat service-account.json)" pnpm ensure:tenant -- --set-secret
   ```

   In CI, set the `VERTEX_API_KEY` or `VERTEX_SERVICE_ACCOUNT` repository secret instead; the deploy pipeline pushes it automatically.
4. Deploy the frontends (`pnpm deploy:tenant -- --site <id>`, or push to `main`) so the `run_worker_first` routes and vars take effect.
