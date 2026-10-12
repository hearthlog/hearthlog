# Developer page

`/developer` has five URL-backed views: Overview, Events, Storage, Performance,
and (for configured administrators) Ledger. The default Overview shows local
readiness, synchronization and outbox status, SQLite and IndexedDB storage,
recent sync activity, inspection shortcuts, and recovery actions. Events contains event-log
management and the event stream. Storage contains storage statistics and the
existing read-only table browser.

Performance separates **Current page** (the current resource's rendered-data
sample) from **App launch** (elapsed document-navigation milestones). Launch
milestones overlap and must not be added together. A direct page load includes
app setup; client navigation measures from that navigation, and a background
refresh retains the previous content. Required-loader completion can follow
earlier shell paint or streamed regions and does not measure every visible
timeline bucket's settlement.

New baseline samples carry the build timestamp. History and recent samples show
only the current build, keeping earlier builds' slower launches out of its
averages. Older and untagged samples remain available in the full Export while
retained in the bounded diagnostic log.

The SQLite card deliberately separates two scopes:

- **This browser · all local logs:** SQLite `page_count × page_size` is the
  allocated main database size. `freelist_count × page_size` is space SQLite
  can reuse inside that file. Occupied pages are the difference; they include
  indexes and database structures, so they are not the size of user payloads.
  Table and index counts come from `sqlite_schema`, and the schema version
  comes from `PRAGMA user_version`. These figures do not include browser
  storage overhead or a write-ahead log.
- **Active log:** event and queued-operation counts use both the active tenant
  and log IDs. Queued operations include pending, syncing, failed, and
  needs-attention statuses. If no log is selected, or its counts cannot be
  read, the card still shows file-wide statistics and marks those counts
  unavailable.

SQLite statistics are read-only and refreshed with `app:developer`. The page does not
create an export to calculate its size; Download SQLite remains an explicit
recovery action. The table browser remains scoped to approved tables and to
the active tenant/log where a table has scope columns.

The IndexedDB card inventories the browser's databases without creating new
ones. It counts entries in each object store and totals stored Blob payloads
for generated invoice PDFs, issued and received invoice originals, and gallery
photos. Original invoice rows also show PDF and ISDOC counts. These payload
sizes do not include IndexedDB metadata, indexes, or disk overhead. The
browser-reported site storage estimate includes SQLite, IndexedDB, caches and
other origin storage, and cannot be attributed precisely to individual
databases. Use the card's Refresh button after files change.
