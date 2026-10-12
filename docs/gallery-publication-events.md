# Gallery publication intent

The `gallery_publication` entity records an owner's publish or unpublish
request in accepted Hearthlog history. It stores an opaque publication ID, source log,
revision ID, public title and description, request time, and last requested
operation. Its read model is scoped to the active tenant and log, then filtered
to `owner_log_id = current log`. A fork inherits historical events but does not
gain the original log's publication management UI or server ownership.

The event is an audit and retry anchor. It does not make images public by
itself. Only the authenticated private Worker can stage safe copies and change
the public Worker's active pointer. The Worker state is authoritative for what
is currently live; a failed or interrupted request can leave an intent with no
active public revision.
