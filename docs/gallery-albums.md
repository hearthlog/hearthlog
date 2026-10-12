# Gallery albums

Albums are private, log-scoped event-sourced metadata. `gallery_album` stores
the title, description, and optional chosen cover. `gallery_album_photo`
records membership, so one photo can belong to several albums without copying
its original or display images. Removing an album does not remove photos or
their immutable file references.

The Gallery repository counts distinct existing photos, picks a surviving
cover when the chosen cover is no longer a member, and reads membership using
scoped SQL. The tables are materialized projections; writes must use the
generated commands and accepted event history remains authoritative.

The Albums tab can create, rename, and remove albums; add multiple photos;
remove selected photos; and open the same private viewer. The album detail and
picker use keyset pages so large libraries do not require loading every row.
The cover defaults to the newest added surviving member until a chosen cover
is set. Public export remains a separate reviewed snapshot, never an automatic
consequence of album membership.
