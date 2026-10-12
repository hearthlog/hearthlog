# Invoice document generation contract

[invoice-generation.openapi.yaml](./invoice-generation.openapi.yaml) defines the stateless API for generating PDF and ISDOC XML from a complete invoice snapshot. It describes the current invoices page and its detail pane, including inline party creation, and matches the deployed renderer at `https://renderer.example` under `/api/invoice-generation`.

## Application integration

The invoices page previews and downloads PDFs through these routes:

| Layer | Location | Responsibility |
| --- | --- | --- |
| Browser client | `modules/invoices/src/api/invoice-renderer.ts` | Map the stored invoice and resolved parties to `InvoiceGenerationRequest`; keep the unscoped stateless request helpers. |
| Browser cache | `modules/invoices/src/api/invoice-pdf-cache.ts` | Cache one resolved PDF per tenant/log/invoice in IndexedDB, coalesce identical requests, queue deletion cleanup, and trigger the explicit download. |
| Frontend Worker cache | `modules/invoices/src/server/invoice-pdf-cache.ts` | Authenticate, verify the Ledger log scope, compute the shared fingerprint, serve matching private R2 objects, render on a miss, and write deletion markers. |
| Frontend Worker gateway | `modules/invoices/src/server/invoice-renderer.ts` | Unchanged same-origin `POST /api/invoice-generation/{pdf,isdoc}` gateway for the stateless renderer; attaches `Authorization: Bearer $INVOICE_RENDERER_TOKEN` and strips Access cookies and headers. |
| Renderer | external Cloud Run service | Stateless document rendering; rejects unauthenticated requests. |

The renderer does not answer CORS preflights and validates a bearer credential that must not be shipped to the browser. `pnpm ensure:tenant -- --set-secret` populates the `INVOICE_RENDERER_TOKEN` Worker secret for every site from the `renderer-tokens` Google Secret Manager value (`your-gcp-project`); locally the gcloud CLI must be authenticated, while in CI the `INVOICE_RENDERER_TOKEN` repository secret is used (see [GitHub deployment](github-deployment.md)). Without the secret the gateway answers `503`. Local `pnpm dev` reads the same name from `.dev.vars` or `.env` and proxies through the Vite server when it is present; the scoped cache routes fall back to the stateless renderer locally because the Vite server has no R2 binding.

Selecting **View PDF** switches the selected invoice's pane to its PDF tab immediately. While the document is being resolved the pane shows only a centered spinner and **Loading invoice…**; no file is downloaded automatically and no generation toast is shown. Once the PDF is ready the pane displays it inline (or explains that the browser cannot preview it) and offers **Download** and **Open in new tab**, both reusing the already-resolved bytes, plus **Regenerate**, which discards the saved device and server copies, shows **Regenerating invoice…**, requests a fresh render, and replaces both copies. Downloads happen only after an explicit action.

Both directions share one detail layout (`InvoiceDetailSummary`, `InvoiceDetailCard`, `InvoiceDetailLineItems`, `InvoiceIsdocCard`). The issued drawer's **Electronic invoice (ISDOC)** card offers **View** and **Download** for an imported invoice's stored original and, for a document created in the app, exports the ISDOC embedded in its PDF (`modules/invoices/src/invoices/isdoc-source.ts`): an imported original is read first when present, otherwise the cache-first PDF render is. The stateless `/isdoc` endpoint is not used by the page. When the snapshot is missing facts the ISDOC profile requires, the card names them and keeps the actions disabled, mirroring the PDF pane's message.

## Caching and fingerprinting

`POST /api/invoice-generation/logs/{logId}/pdf` keeps the existing invoice snapshot body and binary PDF response. The Worker resolves the Ledger application and log from the authenticated session, computes the fingerprint itself, and checks the private `INVOICE_PDFS` bucket for a matching object before rendering. A miss calls the original renderer, validates that the response is a non-empty `application/pdf` starting with `%PDF-`, and stores it with a conditional write. `?force=1` skips the cache hit and always calls the renderer, while still replacing the stored object conditionally on the etag read before rendering. The response carries `X-Invoice-Pdf-Cache: hit|miss`, `X-Invoice-Pdf-Fingerprint`, and `X-Invoice-Renderer-Revision` for diagnostics; responses are always `private, no-store`.

`DELETE /api/invoice-generation/logs/{logId}/invoices/{invoiceId}` replaces the stored object with a small deletion marker carrying a unique marker id. Because renderer writes are conditional on the object they read, a render that started before the deletion cannot restore the old bytes; a valid render after Undo replaces the marker again.

One PDF is retained per invoice. Its SHA-256 fingerprint (shared by browser and Worker in `modules/invoices/src/api/invoice-pdf-fingerprint.ts`) covers the normalized document snapshot, full supplier and customer details, locale, and an explicit renderer revision. Line-item order is preserved. Audit timestamps, sync metadata, and the calculated overdue state are excluded; the workflow status is normalized to **draft** versus **issued** so `sent`, `paid` and `overdue` share the issued identity. Any document edit — including a party address or bank-account change — produces a different fingerprint. The revision constant is bumped whenever templates, calculations, fonts, or embedded-document behavior change, and existing PDFs regenerate lazily.

The browser stores the same fingerprint and revision in a dedicated `stor-invoice-pdfs` IndexedDB database. An exact local match supports preview and download without network access; an offline miss explains in the PDF pane that the current invoice version must be loaded online first. The pane's **Regenerate** action skips the device copy and sends `?force=1`, so it needs the network even when a local copy exists and reports an explicit offline message. Before a result is saved, displayed, or downloaded, the client rechecks the active tenant/log scope and rebuilds the fingerprint from the current invoice and parties, so results superseded by edits, deletion, or navigation are discarded. Switching away from the PDF tab while loading takes effect immediately; a user-requested render may still finish and populate the cache, but it never reopens the tab or starts a download. Reopening the same invoice joins the in-flight cache-first request; forced regenerations never join one.

Invoice deletion removes the device copy immediately and queues a scoped remote cleanup tied to the removal event. Cleanup waits for the event to synchronize, retries across reconnects, and is cancelled when Undo or restore makes the invoice exist again. History mode disables PDF preview and downloads in both action menus and the detail pane, with a handler-level guard in the page.

Rendering takes several seconds. The PDF pane shows **Loading invoice…** during cache-first resolution and **Regenerating invoice…** during a forced render; errors keep the pane in place with **Retry**, and an invoice edited while its preview is loading or open shows **Reload preview** instead of a stale document.

The two operations share the same JSON structure:

| Operation | Request schema | Successful response |
| --- | --- | --- |
| `POST /api/invoice-generation/pdf` | `InvoiceGenerationRequest` | `application/pdf`, attachment `.pdf` |
| `POST /api/invoice-generation/isdoc` | `IsdocGenerationRequest` | `application/xml`, UTF-8 attachment `.isdoc` |

`IsdocGenerationRequest` adds validation to the shared model. The complete example embedded in the OpenAPI document works for either operation. Its minimal draft example works for PDF and deliberately fails ISDOC validation. All example parties and account details are fictional.

## Mapping from the current page

The mapping is grounded in these sources:

- [`+page.svelte`](../modules/invoices/src/pages/invoices.svelte): save behavior, list amounts, workflow status, search and overdue calculations.
- [`+page.ts`](../modules/invoices/src/pages/invoices.ts): party resolution from the unified company directory.
- [`InvoicePartyForm.svelte`](../modules/invoices/src/components/invoices/InvoicePartyForm.svelte): party names, addresses, IDs and bank accounts.
- [`InvoiceDrawer.svelte`](../modules/invoices/src/components/invoices/InvoiceDrawer.svelte): invoice draft and line-item fields.
- [`InvoicePartyForm.svelte`](../modules/invoices/src/components/invoices/InvoicePartyForm.svelte): party names, addresses, IDs and bank accounts.
- [`InvoiceDetailsDrawer.svelte`](../modules/invoices/src/components/invoices/InvoiceDetailsDrawer.svelte): invoice summary, VAT breakdown and notes.
- [`entity-definitions.ts`](../packages/contracts/src/event/entity-definitions.ts): persisted invoice and party fields.

Request properties below are relative to `invoice` unless stated otherwise.

| Page / stored field | Contract property | Meaning / conversion |
| --- | --- | --- |
| `id` | `id` | Application identity; never a remote lookup key. |
| `invoice_number`, draft `invoiceNumber` | `invoiceNumber` | Displayed invoice number. |
| `status` | `status` | Preserve the recorded state. Current actions write `draft`, `sent`, `paid`; legacy `overdue` is accepted. |
| Computed overdue badge/filter | `isOverdue`, `source.evaluatedAt` | Optional snapshot of `status !== 'paid' && due_date < view clock`. Use the original timestamp for this comparison. |
| `description` | `description` | Notes, including multiline text, empty text and null. |
| `issue_date` (form Issue date) | `issueDate`, `source.issueDate` | Document calendar date plus optional original timestamp. |
| `due_date` (derived from form Issue date + Payment term) | `dueDate`, `source.dueDate` | Document calendar date plus optional original timestamp; null remains absent. The form collects a payment term in whole days from the issue date, and the stored date is computed from it. |
| `tax_point_date` (form DUZP) | `taxPointDate` | Tax point date collected by the invoice form; falls back to `issueDate` for records created before the field existed. |
| Page's fixed `CZK` formatting | `currency: CZK` | Explicit currency, shared by all monetary values. |
| `amount` | `amount` | Preserved list amount **before VAT**, as a decimal string. It is not the gross amount due. |
| Fixed `bank_transfer` payment method | `payment.method` | Renderer payment method; the PDF maps it to the Czech payment label. |
| Digits of `invoice_number` | `payment.variableSymbol` | 1-10 digits, as required by the contract; a number without digits falls back to the issue date. |
| `supplier_id` | `supplierId` | Keep original reference; resolve to `supplier`. |
| `customer_id` | `customerId` | Keep original reference; resolve to `customer`. |
| Party `id`, `name` | `{supplier,customer}.id`, `.name` | Full party snapshots, not just dropdown labels. |
| Party `street`, `city` | `{supplier,customer}.street`, `.city` | Original display strings. `city` may already include the postal code. The structured `postalAddress` is derived from these fields: a trailing building number in `street` and a leading or trailing `123 45`/`12345` postal code in `city`. A stored structured address is only kept when the display address cannot be parsed. |
| Party `ico`, `dic` | `{supplier,customer}.ico`, `.dic` | Strings preserve leading zeroes; optional DIČ preserves null/empty values. |
| Party `bank_account` | `{supplier,customer}.bankAccount` | Original display value, including optional customer account data. The supplier account is also parsed into `payment.bankAccount` for the payment QR. |
| Party `party_type` (legacy) | `{supplier,customer}.partyType` | The invoice slot decides the role; the directory record no longer stores one. |
| `items` | `items[]` | Parse the stored JSON exactly once; preserve array order. |
| Item `description` | `items[].description` | Preserve blank descriptions; PDF can display `Item N`. |
| Item `quantity` | `items[].quantity` | Positive decimal string. |
| Item `unitPrice` | `items[].unitPrice` | Nonnegative decimal string, **before VAT**. |
| Item `vatRate` | `items[].vatRate` | Percentage number, e.g. `21`. Preserve each recorded rate even though the current editor does not expose a VAT input. |
| Line amount | Computed `round(quantity × unitPrice)` | Net line amount. |
| Details subtotal | `totals.subtotal` | Sum of rounded net lines. |
| Details VAT by rate | `totals.vatBreakdown[]` | Taxable amount, VAT amount and gross amount for each rate. |
| Details VAT amount | `totals.vatTotal` | Sum of rounded line VAT. |
| Details total | `totals.total` | Subtotal plus VAT. |
| `tenant_id`, `log_id` | `source.tenantId`, `source.logId` | Optional invoice provenance. Resolve both parties in the same scope. |
| Legacy `asOfVersion` | `source.asOfVersion` | Optional field retained in the renderer contract for old requests; the app no longer sends a history snapshot version. |
| Invoice `created_at`, `updated_at` | `source.createdAt`, `source.updatedAt` | Optional original audit timestamps. |

The page's search, tabs and aggregate counts/amounts describe a collection of invoices. They are derived presentation state, not fields of a single invoice document. The sync badge describes local delivery state and does not belong in a fiscal document. Party audit timestamps are not exposed by the page's party options.

For incomplete PDFs, use `supplier: null` or `customer: null` while preserving the original reference. Do not resolve an ID using another log, tenant, or the live state when generating from history. When a party is present, its ID and role must match the corresponding reference. A missing party may be a failed page load rather than an unselected party; the caller should distinguish these before export.

## Additional document fields

The page cannot currently supply every fact required by the ISDOC profile. These fields must come from explicit generation input or confirmed configuration:

| Field | Purpose |
| --- | --- |
| `documentUuid` | Stable ISDOC UUID. Reuse the invoice ID if it is already a UUID; otherwise maintain a stable mapping. |
| `vatApplicable` | Explicit VAT applicability; a DIČ or the default 21% rate does not establish this fact. |
| `taxPointDate` | Date of taxable supply; the invoice form collects it as DUZP. When an older record has none, the exporter sends the issue date so an issued document still carries ISDOC; record the real DUZP to override it. Required by this profile when VAT applies. |
| `{supplier,customer}.postalAddress` | Derived from the single display address (`street`, `city`); the party form does not collect it separately. The building number is the trailing number of `street`; the postal code is split from `city`; the country is `CZ`/`Česká republika`. Preserve the original display address too. |
| `electronicAgreementReference` | Explicit reference string for the mandatory ISDOC element. Empty is allowed by this contract and does not assert consent. |
| `payment.method` | Payment instructions; this ISDOC profile requires `bank_transfer`. PDF also accepts `cash` or `card`. |
| `payment.bankAccount` | Account number and bank code; optional bank name, IBAN and BIC. Must agree with the supplier's display account if recorded. |
| `payment.variableSymbol`, `.constantSymbol`, `.specificSymbol` | Optional payment symbols, always strings. Never fabricate them from an alphanumeric invoice number. |
| `{supplier,customer}.registration` | Optional register text for the PDF footer; the source ISDOC profile does not carry it. |
| `items[].unitCode` | Optional unit code/label. Omit when unknown. |
| Request `locale` | PDF labels and formatting; defaults to `cs-CZ`. |

The existing PDF template's number, parties, locality, account, payment method/symbol, dates, item values, totals and register footer can all be populated from this model. The integration sends `payment.bankAccount`, parsed from the supplier's display account, so the renderer can generate the QR Platba from the account, the computed total and the variable symbol; unparseable account formats are sent without it and produce no QR. No opaque image input is required by this contract. The template itself is not changed here.

## Calculations and validation

Treat decimal strings as exact base-10 values. For this contract, use half-up rounding to two decimal places at each indicated step:

```text
line.net   = round(quantity × unitPrice, 2)
line.vat   = round(line.net × vatRate / 100, 2)
line.gross = line.net + line.vat
subtotal   = sum(line.net)
vatTotal   = sum(line.vat)
total      = subtotal + vatTotal
```

Group the same line values by VAT rate and sort numerically, including a zero-rate group when used. Do not recalculate the group VAT independently. The subtotal must be positive. `totals` is optional; if supplied, every amount, rate group and sum must exactly match the calculations. A mismatch returns `422` with field pointers. PDF and XML must use the same calculation result.

The current UI uses floating-point arithmetic and rounds at display time. Line rounding in this contract can therefore differ from the UI by cents in fractional cases. For example, two lines of `1 × 0.03` at 21% yield net `0.06`, VAT `0.02`, gross `0.08` under this contract; rounding aggregate VAT would yield `0.01`. When implementing the exporter, omit asserted totals until the caller uses the same decimal calculation. Preserve the original `amount` separately for traceability; it is not a total assertion.

Workflow `paid` does not contain an actual payment amount, date or deposit record. Preserve it for PDF presentation; it must not manufacture deposits or alter the invoice's original fiscal totals. `total` and ISDOC `PayableAmount` represent the original document liability in this profile, not a current receivables balance.

The schema enforces shapes, types, required fields, decimal syntax and the extra ISDOC fields. The renderer must additionally enforce positive quantities/subtotal, matching party IDs, coherent structured/display addresses and bank accounts, valid calendar dates/UUIDs, supplied IBAN checksum/account agreement, totals and supported fiscal scope. Reject contradictory VAT applicability, including nonzero rates on a non-VAT document, for either output. Do not infer or automatically correct missing facts.

Convert source timestamps to date-only strings in the selected application timezone before sending. Do not take `timestamp.slice(0, 10)` from UTC blindly. For example, `2026-09-10T22:30:00Z` corresponds to document date `2026-09-11` in Prague. Preserve original timestamp strings in `source` if exact traceability is needed.

## ISDOC serialization profile

This profile targets the [official ISDOC 6.0.2 specification](https://isdoc.github.io/doc/isdoc.html) and [invoice XSD](https://isdoc.github.io/xsd/isdoc-invoice-6.0.2.xsd). The official distribution also supplies [Schematron checks](https://isdoc.github.io/sch/isdoc-6.0.2.sch). A future implementation must validate XML structure and the applicable arithmetic/business rules; OpenAPI validation alone is insufficient.

| ISDOC destination | Source / rule |
| --- | --- |
| `Invoice/@version`, default namespace | `6.0.2`, `http://isdoc.cz/namespace/2013`. |
| `DocumentType` | `1` (ordinary invoice). |
| `ID`, `UUID`, `IssueDate` | `invoiceNumber`, `documentUuid`, `issueDate`. |
| `TaxPointDate`, `VATApplicable` | Explicit values; omit tax point date when absent and not required. |
| `ElectronicPossibilityAgreementReference`, `Note` | Corresponding reference and invoice description; omit null notes, preserve multiline text. |
| `LocalCurrencyCode`, `CurrRate`, `RefCurrRate` | `CZK`, `1`, `1`; omit foreign-currency elements. |
| `AccountingSupplierParty/Party`, `AccountingCustomerParty/Party` | Resolved supplier and customer. |
| `PartyIdentification/ID`, `PartyName/Name` | Party `ico`, `name`. |
| `PostalAddress` | Structured fields; `postalCode` maps to `PostalZone`, with nested `Country/IdentificationCode` and `Country/Name`. |
| `PartyTaxScheme` | Nonempty DIČ as `CompanyID`; `TaxScheme=VAT`. Omit the collection if DIČ is missing. |
| `RegisterIdentification/Preformatted` | Not emitted; the source profile omits it. |
| `InvoiceLines/InvoiceLine/ID` | One-based array index as a string; unique within the invoice. |
| `InvoicedQuantity`, optional `@unitCode`, `Item/Description` | Item quantity, optional unit code, description. |
| `UnitPrice`, `UnitPriceTaxInclusive` | Net price; `round(unitPrice × (1 + vatRate/100), 2)` for the informational gross unit price. Line gross remains computed from the extended net amount. |
| `LineExtensionAmount`, `LineExtensionTaxAmount`, `LineExtensionAmountTaxInclusive` | Computed net, VAT and gross line values. |
| `ClassifiedTaxCategory` | `Percent=vatRate`, `VATCalculationMethod=0` (from net), explicit document `VATApplicable`. |
| `TaxTotal/TaxSubTotal` | One per rate: taxable, VAT and inclusive amounts; `TaxCategory/Percent`, `TaxScheme=VAT`, explicit `VATApplicable`. |
| `TaxTotal/TaxAmount` | Computed `vatTotal`. |
| `LegalMonetaryTotal/TaxExclusiveAmount`, `TaxInclusiveAmount` | `subtotal`, `total`. |
| Required `AlreadyClaimed*` values in tax and monetary totals | `0.00`; this profile has no advance settlement. |
| Required `Difference*` values in tax and monetary totals | Equal the corresponding original taxable/VAT/inclusive amounts. |
| `PaidDepositsAmount`, optional `PayableRoundingAmount` | `0.00`; this profile has no deposits or additional payable rounding. |
| `LegalMonetaryTotal/PayableAmount` | Computed `total`. |
| `PaymentMeans/Payment/PaidAmount`, `PaymentMeansCode` | Computed `total`, `42`. Despite the element name, `PaidAmount` here describes the amount to be paid, not a recorded settlement. |
| `Payment/Details/PaymentDueDate` | `dueDate`. |
| `Payment/Details/ID`, `BankCode`, `Name`, `IBAN`, `BIC` | Structured beneficiary account. Emit mandatory empty Name/IBAN/BIC elements for omitted values. |
| `Payment/Details/VariableSymbol`, `ConstantSymbol`, `SpecificSymbol` | Optional explicit symbols. |

Emit mandatory XML elements in XSD order, with XML escaping. Internal party/invoice IDs, raw display strings, source audit data, list amount and workflow badges are available to the renderer but have no dedicated standard fiscal field; do not repurpose standard ISDOC fields for them. Preserve the submitted snapshot separately in the calling app if lossless application-data round trips are needed. The renderer itself is stateless.

This contract does not model foreign currency, credit/debit notes, advance settlements, discounts, reverse charge, mixed VAT applicability, signatures, ISDOC archives or PDF/A-3 embedded ISDOC. Supporting those cases requires an explicit extension of the payload and calculation rules.

## Contract validation

Validate the standalone OpenAPI document without adding application dependencies:

```sh
uv run --with openapi-spec-validator --with pyyaml python - <<'PY'
import yaml
from openapi_spec_validator import validate
with open('docs/invoice-generation.openapi.yaml') as source:
    validate(yaml.safe_load(source))
print('OpenAPI contract valid')
PY
```

The embedded complete and draft requests must also be checked against their referenced JSON schemas, with date/UUID format checking enabled. When implementing the renderer, add document-level tests for fractional rounding, multiple VAT rates, a non-VAT supplier, missing enrichment, mismatched totals and date conversion near midnight; validate generated ISDOC against the official XSD and applicable business rules.
