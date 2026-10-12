<script lang="ts" module>
    /** A place in the list: the block in view, and where within it (a day, for example). */
    export interface EndlessPosition {
        key: string;
        at: string;
    }

    /** A place to scroll to. It counts as the one in view until the list is scrolled by hand. */
    export interface EndlessTarget {
        key: string;
        /** Where within the block; the key when missing. */
        at?: string;
        /** The element to bring to the line; the block's top when missing or not found. */
        find?: (block: HTMLElement) => HTMLElement | null;
        /** Share of the visible height the element settles at; 0 by default. */
        ratio?: number;
    }

    /** A block on screen, top to bottom. Its element is missing before it renders. */
    export interface EndlessBlock {
        key: string;
        element: HTMLElement | null;
    }

    /** The visible part of the list in viewport pixels; `edge` sits just below its top. */
    export interface EndlessView {
        edge: number;
        bottom: number;
    }
</script>

<script lang="ts" generics="T">
    import { flushSync, untrack, type Snippet } from "svelte";
    import type { HTMLAttributes } from "svelte/elements";
    import { createVirtualizer, defaultRangeExtractor, measureElement } from "@tanstack/svelte-virtual";
    import { nearestKey, type EndlessAxis } from "../../utils/endless-axis.js";
    import type { BucketStore } from "./bucket-store.svelte.js";
    import IconArrowUp from "~icons/mdi/arrow-up";
    import IconArrowDown from "~icons/mdi/arrow-down";

    /** The block under this many pixels below the top edge is the one in view. */
    const EDGE = 12;

    type Aim = { key: string; find?: (block: HTMLElement) => HTMLElement | null; ratio: number; behavior: ScrollBehavior; measured: boolean; tries: number };

    let {
        axis,
        store,
        opening,
        estimate,
        overscan = 1,
        revision,
        anchorSelector,
        openingPlaceholder,
        home,
        pick = (blocks) => ({ key: blocks[0].key, at: blocks[0].key }),
        onVisibleChange,
        item,
        class: className = "",
        ...attributes
    }: Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
        /** The keys listed. Its end may grow while the list is open; its keys never move. */
        axis: EndlessAxis;
        store: BucketStore<T>;
        /** Where the list opens, read once. It opens at the block's estimated start and settles once it has loaded. */
        opening: EndlessTarget;
        /**
         * A block's height before it is measured, for every block or per key;
         * loading blocks keep roughly this height.
         */
        estimate: number | ((key: string) => number);
        overscan?: number;
        /** Changes after a save or a sync; the blocks on screen then read again. */
        revision?: number;
        /** Stable elements to keep at their screen positions when loaded buckets change. */
        anchorSelector?: string;
        /** Stays visible until the opening window has loaded and been measured. */
        openingPlaceholder?: Snippet;
        /** A place to return to. While it is off screen, a button floats at the bottom of the list. */
        home?: EndlessTarget & { label: string };
        /** Names the place in view from the blocks on screen; the first one crosses the top edge. */
        pick?: (blocks: EndlessBlock[], view: EndlessView) => EndlessPosition;
        onVisibleChange?: (position: EndlessPosition) => void;
        /** Renders a block; `data` is missing while it loads. */
        item: Snippet<[key: string, data: T | undefined]>;
    } = $props();

    let scroller = $state<HTMLDivElement>();
    let openingReady = $state(false);

    function estimated(index: number): number {
        return typeof estimate === "number" ? estimate : estimate(axis.keyAt(index));
    }

    /** Where the block at an index starts before anything is measured. */
    function estimatedStart(index: number): number {
        if (typeof estimate === "number") return index * estimate;
        let start = 0;
        for (let before = 0; before < index; before++) start += estimated(before);
        return start;
    }

    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: untrack(() => axis.count),
        getScrollElement: () => scroller ?? null,
        estimateSize: estimated,
        getItemKey: (index) => axis.keyAt(index),
        // A hidden list measures zero; keep the last size so it never renders everything.
        measureElement: (element, entry, instance) => {
            const size = measureElement(element, entry, instance);
            const index = instance.indexFromElement(element);
            return size > 0 ? size : instance.itemSizeCache.get(instance.options.getItemKey(index)) ?? estimated(index);
        },
        overscan: untrack(() => overscan),
        initialOffset: () => untrack(() => estimatedStart(axis.indexOf(opening.key))),
    });

    /**
     * The part of the list on screen. On smaller screens the page scrolls
     * around the list too, so the fixed header and navigation can cover it.
     */
    function viewport(): { top: number; height: number } | null {
        if (!scroller) return null;
        const rect = scroller.getBoundingClientRect();
        let top = rect.top;
        let bottom = rect.top + scroller.clientHeight;
        const page = scroller.closest<HTMLElement>("[data-stor-main]");
        if (page) {
            const pageRect = page.getBoundingClientRect();
            const style = getComputedStyle(page);
            top = Math.max(top, pageRect.top + parseFloat(style.paddingTop));
            bottom = Math.min(bottom, pageRect.top + page.clientHeight - parseFloat(style.paddingBottom));
        }
        return { top, height: Math.max(0, bottom - top) };
    }

    /** Whether each block was last measured while still loading. */
    const measuredLoading = new Map<string, boolean>();
    let measuringAnchors = false;

    $effect(() => {
        if (!scroller) return;
        const instance = untrack(() => $virtualizer);
        // What is on screen stays put when a block above it changes height:
        // blocks entirely above the top edge, and a block straddling the edge
        // while it goes from its loading shape to its content (whichever way
        // the list scrolls). A loaded block that changes around the edge grows
        // below it, so nothing moves.
        instance.shouldAdjustScrollPositionOnItemSizeChange = (entry, _delta, self) => {
            const key = String(entry.key);
            const wasLoading = measuredLoading.get(key) ?? true;
            measuredLoading.set(key, store.get(key) === undefined);
            if (measuringAnchors) return false;
            // While opening, compensate only blocks before the target. Using
            // the moving offset during a batch can pull growing target/future
            // blocks above that offset and scroll the target out of the window.
            if (aiming && openingPlaceholder && !openingReady) return entry.index < axis.indexOf(aiming.key);
            const edge = (self.scrollOffset ?? 0) + self.scrollAdjustments;
            if (entry.start >= edge) return false;
            if (!self.itemSizeCache.has(entry.key)) return true;
            return entry.end <= edge || wasLoading;
        };
        instance._willUpdate();
    });

    // The axis can grow at its end, for example when done history gains a later month.
    $effect(() => {
        const next = axis.count;
        untrack(() => { if ($virtualizer.options.count !== next) $virtualizer.setOptions({ count: next }); });
    });

    const items = $derived($virtualizer.getVirtualItems());
    const keys = $derived(items.map((entry) => axis.keyAt(entry.index)));

    $effect(() => {
        void store.buckets.size;
        store.ensure(keys);
    });

    function measure(node: HTMLDivElement) {
        untrack(() => $virtualizer).measureElement(node);
    }

    let anchorRevision = 0;
    let anchorFrame = 0;
    let scrollIntent = 0;
    let disposed = false;

    $effect(() => {
        const selector = anchorSelector;
        if (!selector) return;
        const unsubscribe = store.beforePublish(() => {
            const view = viewport();
            if (!scroller || !view || aiming || !openingReady) return;
            const origin = scroller.getBoundingClientRect().top;
            const anchors: { element: HTMLElement; top: number }[] = [];
            for (const element of scroller.querySelectorAll<HTMLElement>(selector)) {
                const rect = element.getBoundingClientRect();
                if (rect.top >= view.top + view.height) break;
                if (rect.bottom > view.top + EDGE) anchors.push({ element, top: rect.top - origin });
            }
            if (anchors.length > 0) restoreAnchors(anchors, ++anchorRevision, scrollIntent);
        });
        return () => { unsubscribe(); anchorRevision += 1; };
    });

    function restoreAnchors(anchors: { element: HTMLElement; top: number }[], revision: number, intent: number): void {
        // Publication completes synchronously after beforePublish. Flush its
        // DOM and measure/correct in the next microtask, before the next paint;
        // tick() can defer to a frame when Svelte's async mode is enabled.
        queueMicrotask(() => {
            const current = () => !disposed && revision === anchorRevision && intent === scrollIntent;
            if (!current()) return;
            if (!scroller) return;
            const instance = untrack(() => $virtualizer);
            const first = Number(anchors[0].element.closest<HTMLElement>("[data-index]")?.dataset.index);
            const last = Number(anchors[anchors.length - 1].element.closest<HTMLElement>("[data-index]")?.dataset.index);
            if (!Number.isFinite(first) || !Number.isFinite(last)) return;
            cancelAnimationFrame(anchorFrame);
            // Shrinking preceding blocks can otherwise remove the anchor from
            // the virtual window before its scroll correction is applied. Keep
            // a contiguous window through its old visible months for this batch.
            measuringAnchors = true;
            try {
                instance.setOptions({ rangeExtractor: (range) => defaultRangeExtractor({
                    ...range,
                    startIndex: Math.min(range.startIndex, first),
                    endIndex: Math.max(range.endIndex, last),
                }) });
                flushSync();
                if (!current() || !scroller) return;
                // Correct against the reading anchor once, rather than letting
                // a moving offset trigger compensation for each growing block.
                flushSync(() => {
                    for (const element of scroller!.querySelectorAll<HTMLDivElement>("[data-endless-key]")) {
                        const height = Math.round(element.getBoundingClientRect().height);
                        if (height > 0) instance.resizeItem(instance.indexFromElement(element), height);
                    }
                });
                if (!current() || !scroller) return;
                const anchor = anchors.find(({ element }) => scroller!.contains(element));
                if (!anchor) return;
                const delta = anchor.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top;
                if (Math.abs(delta) > 1) scroller.scrollTop += delta;
            } finally {
                measuringAnchors = false;
                // Let the native scroll event update the virtual offset before
                // releasing the retained months. A newer batch owns its window.
                anchorFrame = requestAnimationFrame(() => {
                    if (!disposed && revision === anchorRevision) instance.setOptions({ rangeExtractor: defaultRangeExtractor });
                });
            }
        });
    }

    /** Re-reads the blocks on screen after a save or a sync. */
    export function refresh(): void {
        store.refresh(keys);
    }

    let refreshed = untrack(() => revision);
    $effect(() => {
        const current = revision;
        if (current === refreshed) return;
        refreshed = current;
        untrack(() => refresh());
    });

    // ---------------------------------------------------------------- scrolling

    let aiming: Aim | null = null;
    let settleFrame = 0;

    function block(key: string): HTMLElement | null {
        return scroller?.querySelector<HTMLElement>(`[data-endless-key="${CSS.escape(key)}"]`) ?? null;
    }

    function loaded(key: string): boolean {
        return store.get(key) !== undefined && !!block(key);
    }

    /**
     * Brings the target to its line once its block has loaded and been
     * measured. Near the block's top the top stays in view instead.
     */
    function settle(): void {
        cancelAnimationFrame(settleFrame);
        settleFrame = requestAnimationFrame(() => {
            const view = viewport();
            if (!aiming || !view || !scroller) return;
            aiming.tries -= 1;
            if (aiming.tries <= 0) { aiming = null; openingReady = true; return; }
            const windowReady = !openingPlaceholder || openingReady || keys.every((key) => {
                const element = block(key);
                return loaded(key) && element && Math.abs(($virtualizer.itemSizeCache.get(key) ?? -1) - element.getBoundingClientRect().height) < 1;
            });
            if (!loaded(aiming.key) || !aiming.measured || !windowReady) {
                // One extra frame after loading lets the list measure the block.
                if (loaded(aiming.key)) aiming.measured = true;
                settle();
                return;
            }
            const element = block(aiming.key)!;
            const top = element.getBoundingClientRect().top - view.top;
            const found = aiming.find?.(element) ?? null;
            const line = found ? found.getBoundingClientRect().top - view.top : top;
            const wanted = Math.min(view.height * aiming.ratio, line - top);
            const delta = line - wanted;
            const before = scroller.scrollTop;
            // Through the virtualizer, so an adjustment it deferred during the jump (iOS WebKit) is
            // dropped instead of landing on top of the place this settles on.
            if (Math.abs(delta) > 1) $virtualizer.scrollToOffset(before + delta, { behavior: aiming.behavior });
            if (openingPlaceholder && !openingReady && Math.abs(scroller.scrollTop - before) > 1) {
                settle();
                return;
            }
            aiming = null;
            openingReady = true;
        });
    }

    /** Scrolls to a place; a block that has not loaded yet is jumped to, loaded, then settled on. */
    export function scrollTo(target: EndlessTarget, behavior: ScrollBehavior = "auto"): void {
        if (!scroller) return;
        scrollIntent += 1;
        const key = nearestKey(axis, target.key);
        held = { key, at: target.at ?? key };
        const rendered = loaded(key);
        aiming = { key, find: target.find, ratio: target.ratio ?? 0, behavior: rendered ? behavior : "auto", measured: rendered, tries: 300 };
        if (!rendered) {
            // Jump to the block's estimated start; it loads there, then settles.
            const offset = $virtualizer.getOffsetForIndex(axis.indexOf(key), "start");
            if (offset) $virtualizer.scrollToOffset(offset[0]);
        }
        settle();
    }

    // The list opens at the opening block's estimated start (initialOffset),
    // then settles on the opening place once it has loaded.
    let opened = false;
    $effect(() => {
        if (!scroller || opened) return;
        opened = true;
        untrack(() => scrollTo(opening));
    });

    // ---------------------------------------------------------------- what is in view

    let visibleFrame = 0;
    let lastVisible: EndlessPosition = { key: "", at: "" };
    /**
     * After opening or a jump, the place it went to stays the one in view
     * until the list is scrolled by hand; with sparse blocks the top edge can
     * otherwise sit in an empty block far above what was asked for.
     */
    let held: EndlessPosition | null = null;

    const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

    function release(event: Event): void {
        if (event instanceof KeyboardEvent && (!SCROLL_KEYS.has(event.key) || (event.key === " " && event.target !== scroller))) return;
        // A pointer on the list itself (not a block) is its scrollbar.
        if (event instanceof PointerEvent && event.target !== scroller) return;
        scrollIntent += 1;
        aiming = null;
        openingReady = true;
        held = null;
        reportVisible();
    }

    /** Which way home lies when it is off screen. */
    let homeAway = $state<"up" | "down" | null>(null);

    function reportVisible(): void {
        cancelAnimationFrame(visibleFrame);
        visibleFrame = requestAnimationFrame(() => {
            const view = viewport();
            if (!view || !scroller) return;
            // The rendered blocks are the truth; the virtualizer's sizes can lag them by a frame.
            const edge = view.top + EDGE;
            const rendered = [...scroller.querySelectorAll<HTMLElement>("[data-endless-key]")];
            const start = rendered.findIndex((element) => element.getBoundingClientRect().bottom > edge);
            let blocks: EndlessBlock[] = (start < 0 ? [] : rendered.slice(start))
                .filter((element) => element.getBoundingClientRect().top < view.top + view.height)
                .map((element) => ({ key: element.dataset.endlessKey ?? "", element }));
            if (blocks.length === 0) {
                const entry = $virtualizer.getVirtualItemForOffset(scroller.scrollTop + Math.max(0, view.top - scroller.getBoundingClientRect().top) + EDGE);
                if (!entry) return;
                const key = axis.keyAt(entry.index);
                blocks = [{ key, element: block(key) }];
            }
            // However the list moved (find in page, a scrollbar, an assistive tool), a held place off screen lets go.
            if (held && !aiming) {
                const rect = block(held.key)?.getBoundingClientRect();
                if (!rect || rect.bottom <= view.top || rect.top >= view.top + view.height) held = null;
            }
            const position = held ?? pick(blocks, { edge, bottom: view.top + view.height });

            if (home) {
                const homeBlock = block(home.key);
                const rect = (homeBlock && home.find ? home.find(homeBlock) : homeBlock)?.getBoundingClientRect();
                // A pixel of slack: a home settled on the bottom edge can land a fraction past it.
                homeAway = rect
                    ? rect.bottom < view.top - 1 ? "up" : rect.top > view.top + view.height + 1 ? "down" : null
                    : axis.indexOf(home.key) < axis.indexOf(position.key) ? "up" : "down";
            }

            if (position.key === lastVisible.key && position.at === lastVisible.at) return;
            lastVisible = position;
            onVisibleChange?.(position);
        });
    }

    // The page can scroll around the list on smaller screens, which moves what is visible.
    $effect(() => {
        const page = scroller?.closest<HTMLElement>("[data-stor-main]");
        if (!page) return;
        page.addEventListener("scroll", reportVisible, { passive: true });
        return () => page.removeEventListener("scroll", reportVisible);
    });

    $effect(() => {
        void items;
        void store.buckets.size;
        reportVisible();
    });

    $effect(() => () => {
        disposed = true;
        cancelAnimationFrame(settleFrame);
        cancelAnimationFrame(visibleFrame);
        cancelAnimationFrame(anchorFrame);
    });
</script>

<div class="endless">
    <div
        {...attributes}
        aria-busy={openingPlaceholder && !openingReady ? true : undefined}
        bind:this={scroller}
        class={["scroller", className]}
        onscroll={reportVisible}
        onwheel={release}
        ontouchmove={release}
        onkeydown={release}
        onpointerdown={release}
    >
        <div class="track" style:height={`${$virtualizer.getTotalSize()}px`}>
            <!-- Positioned with top, not a transform: sticky headers inside blocks break under a transform. -->
            <div class="window" style:top={`${items[0]?.start ?? 0}px`} style:visibility={openingPlaceholder && !openingReady ? "hidden" : undefined}>
                {#each items as entry (entry.key)}
                    {@const key = axis.keyAt(entry.index)}
                    <div data-index={entry.index} data-endless-key={key} {@attach measure}>
                        {@render item(key, store.get(key))}
                    </div>
                {/each}
            </div>
        </div>
    </div>
    {#if openingPlaceholder && !openingReady}
        <div class="opening-placeholder">{@render openingPlaceholder()}</div>
    {/if}
    {#if home && homeAway}
        <button type="button" class="home-jump" onclick={() => home && scrollTo(home)}>
            {#if homeAway === "up"}<IconArrowUp class="h-4 w-4" />{:else}<IconArrowDown class="h-4 w-4" />{/if}{home.label}
        </button>
    {/if}
</div>

<style>
    .endless { position: relative; height: 100%; }
    .scroller { position: relative; height: 100%; overflow-y: auto; overflow-anchor: none; overscroll-behavior: contain; }
    .track { position: relative; width: 100%; }
    .window { position: absolute; left: 0; width: 100%; }
    .opening-placeholder { position: absolute; top: 0; left: 0; width: 100%; padding: 1rem; pointer-events: none; }
    .home-jump {
        position: absolute;
        /* A page can move the way back, for example clear of an action floating over the list. */
        bottom: var(--endless-home-bottom, 1rem);
        left: var(--endless-home-left, 50%);
        z-index: 3;
        display: inline-flex;
        height: var(--endless-home-height, 2.25rem);
        align-items: center;
        gap: 0.25rem;
        padding: 0 0.875rem 0 0.625rem;
        border: 0;
        border-radius: 999px;
        background: var(--stor-surface-raised);
        box-shadow: var(--stor-shadow-md);
        font-size: 13px;
        font-weight: 600;
        color: var(--stor-ink);
        transform: var(--endless-home-transform, translateX(-50%));
    }
    .home-jump:hover { background: var(--stor-surface-hover); }
    .home-jump:focus-visible { outline: 2px solid var(--stor-focus); outline-offset: 2px; }
</style>
