/**
 * Databases older than this are not altered in place: their module projection tables are
 * dropped and recreated, and the next rebuild refills them from raw events. A module that raises
 * `projectionVersion` gets the same treatment, so no column repair is ever written again.
 */
export const MIN_IN_PLACE_SCHEMA_VERSION = 42;

/**
 * v43: persistent checkpoint replay inputs, entity claims, and prefix coverage.
 * v42: `module_migrations` records each module's projection version (baseline 1).
 * v41: Books, Vacations, and Web Archive are deleted; their projection tables
 *      are dropped.
 * v40: activity entries record the service integration that wrote them (`source`).
 *
 * v39: transactions record where their category came from (`category_source`)
 * and received invoices carry an expense type (`expense_type`).
 *
 * v38: raw events keep the author Ledger recorded for each accepted event.
 *
 * v37: an explicit null in an update payload clears the field instead of
 * being treated as omitted, so every log re-projects; the unused legacy
 * outbox_events table is dropped.
 *
 * v35: add Gallery albums and photo membership projections.
 *
 * v34: Gallery photos keep camera, exposure, and location metadata from EXIF.
 *
 * v33: add the tenant-scoped Gallery photo projection and timeline indexes.
 *
 * v32: calendar gains declarative date sources — entities declare one or more
 *      calendar dates, dynamic entity definitions persist a calendar config,
 *      and the unified month query uses new scoped date indexes.
 *
 * v31: budget plans become universal planning scenarios — the per-month
 *      column and its index are gone, so every plan is available in every
 *      month.
 *
 * v30: Finance adds monthly budget scenarios and their planned line items.
 *
 * v29: the party directory drops the supplier/customer split — one company
 *      record serves both invoice slots — and duplicates merged away point at
 *      their survivor through `merged_into`.
 *
 * v28: meal slots become a user-managed entity so the diary can add, rename,
 *      reorder, and hide parts of the day beyond the four built-in meals.
 *
 * v27: food items retain the source catalog's common servings so imported
 *      liquids and labeled portions can be logged in their source units.
 * v26: issued invoices retain imported originals (PDF + ISDOC) and their
 *      extraction provenance, matching received-invoice storage.
 * v25: received invoices keep the full document breakdown, supplier identity,
 *      payment details, the retained ISDOC XML, and extraction provenance.
 * v24: add received invoices with separately stored original PDF documents.
 * v23: preserve invoice document identity, fiscal fields and party/payment snapshots.
 *
 * v22: invoices keep the tax point date (DUZP) used on generated documents.
 *
 * v21: retain accepted action identity for history across devices.
 *
 * v20: opt-in Books reference entity (disabled for all family tenants).
 *
 * v19: repair overstated synchronization cursors and rebuild projections.
 *
 * v18: activity entries and behavior goals track steps and exercise separately
 * from Nutrition's fixed calorie target.
 *
 * v17: nutrition goals retain the inputs, selected result, and method version
 * used by the offline target-calorie calculator.
 *
 * v16: food items retain external catalog provenance and missing-nutrient
 * metadata while remaining compatible with manual foods.
 *
 * v15: entity tables are scoped to the tenant's approved entities — the
 * rebuild drops projection tables of non-approved entities (raw_events keeps
 * the full history, so re-enabling a feature re-projects cleanly).
 */
export const SCHEMA_VERSION = 43;
