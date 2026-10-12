# Private Gallery backup

Gallery backups use an uncompressed tar archive. Each current private photo
contributes its original bytes under an opaque ID path. A final `manifest.json`
records photo metadata, album structure, and a SHA-256 digest for each original.
The reader checks archive headers, names, byte sizes, and photo digests before
accepting content. The archive contains private filenames and camera metadata,
including location when present; handle it as private data.

The Gallery **Backup** dialog downloads the archive and previews a selected
archive before restoring it. Browsers with Save file support stream the archive
to disk; other browsers use a download capped at 512 MiB. Export stops if any
original is unavailable, so a partial archive is never offered as a finished
backup. The reader verifies all original digests before appending events.

Restore creates fresh photo and album IDs through ordinary commands and stages
each original for the normal upload queue. It works offline and does not rewrite
existing events or replace the current log. If storage or a command fails after
restore begins, the Gallery reports how many photos were completed; those
photos remain in the log. Removed photos are outside the current read model;
their accepted history remains recoverable through log history, not this
snapshot format.

The archive format is implemented in `modules/gallery/src/gallery/backup-archive.ts` and
versioned as `stor-gallery` version 1. The public gallery is never treated as a
backup.
