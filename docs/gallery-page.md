# Private Gallery page

The `gallery` feature is enabled for the `st` tenant. The page lives at
`/gallery` under Life navigation, with Photos, Favorites, Albums, and Shared tabs.

Photos, Favorites, search results and an open album are one endless timeline
built on `EndlessList` (`modules/gallery/src/components/gallery/GalleryTimeline.svelte`).
It reads newest first: months and the photos inside them run from the newest
at the top to the oldest below, the page opens at the top, and a **Latest**
button returns there after scrolling into older months. Each month is a block
read from SQL as it scrolls into view; a month over 240 photos splits into
parts that keep one pinned header. Rows are
justified at each photo's true proportions (`justifiedRows` in
`modules/gallery/src/gallery/layout.ts`), cropping only past 3:1 or 1:2, and the minus and
plus buttons change the row height on this device. The spine beside the list
is a month-by-month time scale sized by photo count; hover, drag, click or use
the arrow keys to move through it. `?month=` follows the month in view.

The viewer is always dark and lit by a blurred copy of the photo. A filmstrip
shows up to eight neighbours either side, the arrows and swipes move within
the timeline it was opened from, and closing it brings the last photo shown
back into view. Selection checks single photos or a whole month. The selected
photo, tab, search query, month and selection are URL state.

The browser stages each original and its pending upload in one IndexedDB
transaction before appending the photo event. A failed local stage creates no
photo. The coordinator retries uploads after Ledger accepts the photo
reference. Pending bytes remain on the device. The page says **Saved on this
device** until its upload succeeds, and a fresh device can fetch the original
through the private Worker. Imports read EXIF from JPEG, PNG, WebP, and
HEIC/HEIF originals: the capture time places the photo on the timeline, and
camera, lens, exposure, and GPS location appear in the viewer. Photos without a
capture date use the workspace import day. A tile that failed to load retries
when the window regains focus or the device comes back online. HEIC/HEIF originals are retained
even if the current browser cannot preview them.

This is the first private slice. New devices load small thumbnail and display
renditions; a device holding the staged original can preview it immediately.
Albums and bulk membership actions are available. The viewer can edit a caption
or remove a photo through events; removal leaves the immutable original for
accepted history and other logs. The Backup dialog exports current originals,
albums, and metadata to a verified archive and can restore them into this log
with fresh IDs. Do not treat current local
staging or the public concept images as a backup or public gallery.

The Shared tab shows the server's active publication status and offers copy
link, review update, and unpublish. An owner can prepare a public review from
an album or by selecting photos in Photos or Favorites. The review drawer shows
the cover and the same justified rows as the public page at desktop and phone
widths, oldest photo first, and lets the owner reorder photos and edit public
title, description, captions, and image descriptions. Three switches choose
the photo details visitors see in the public viewer: camera and exposure, date
taken, and location, all on by default. New reviews start with empty public
captions and generic image descriptions; private filenames stay inside Hearthlog. An explicit publish creates an intent event,
then the private Worker verifies accepted photo references and uploaded
originals, prepares safe public copies, and activates one immutable revision.
An interrupted request can retry the same revision. Private edits and new
album members never update an active public gallery automatically. Unpublish
turns off the active pointer; downloaded visitor copies cannot be recalled.
The public hostname and Access separation still require a real deployment
check before sharing links outside the local pilot.
