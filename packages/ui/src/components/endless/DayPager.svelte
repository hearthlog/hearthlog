<script lang="ts" generics="T">
    import { flushSync, tick, untrack, type Snippet } from "svelte";
    import type { HTMLAttributes } from "svelte/elements";
    import type { EndlessAxis } from "../../utils/endless-axis.js";
    import type { BucketStore } from "./bucket-store.svelte.js";
    import IconArrowLeft from "~icons/mdi/arrow-left";
    import IconArrowRight from "~icons/mdi/arrow-right";

    /** How much of the day before and after stays in view. */
    const PEEK = 12;
    /** The space between two days. */
    const GAP = 8;
    /** Where `scrollend` is missing, this long without a scroll counts as resting. */
    const QUIET = 150;

    /**
     * One day at a time, sideways: across moves between days, down reads one,
     * and each day scrolls on its own. Every swipe ends on a day, and the days
     * either side peek in. Days have a fixed width, so only the day in view and
     * one either side are drawn and read.
     *
     * With `flow` the page scrolls the day instead (phones): the day it rests on
     * is as tall as its content, and the days either side are drawn from the
     * reading edge down, so a swipe from far down a day shows the next day's
     * start. Landing on a day brings its start to the reading edge.
     */
    let {
        axis,
        store,
        opening,
        revision,
        home,
        flow = false,
        edge,
        shift = $bindable(0),
        onVisibleChange,
        onSettle,
        item,
        class: className = "",
        ...attributes
    }: Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
        /** The keys listed, one per day. Its end may grow while the pager is open. */
        axis: EndlessAxis;
        store: BucketStore<T>;
        /** The day the pager opens at, read once. */
        opening: string;
        /** Changes after a save or a sync; the days on screen then read again. */
        revision?: number;
        /** A day to return to. While it is off screen, a button floats at the bottom. */
        home?: { key: string; label: string };
        /** The page scrolls the days instead of each day scrolling itself. */
        flow?: boolean;
        /** With `flow`, the screen line a day's start lands on; the top of the page's scrolling area by default. */
        edge?: () => number | undefined;
        /** How far the list sits past the day in view, in days, from -0.5 to 0.5. */
        shift?: number;
        /** The day in view changed, while scrolling too. */
        onVisibleChange?: (key: string) => void;
        /** Scrolling came to rest with this day in view. */
        onSettle?: (key: string) => void;
        /** Renders a day; `data` is missing while it loads. */
        item: Snippet<[key: string, data: T | undefined]>;
    } = $props();

    let scroller = $state<HTMLDivElement>();
    let width = $state(0);
    /** The scroll position, read once per frame. */
    let offset = $state(0);
    /** The day a scroll is on its way to; it is drawn before the scroll starts. */
    let aim = $state<number | null>(null);
    /** With `flow`, the day the page rests on; it alone gives the pager its height. */
    let rested = $state(untrack(() => axis.indexOf(opening)));

    const count = $derived(axis.count);
    /** Where a day's edge settles, so the day before it peeks in. */
    const inset = $derived(PEEK + GAP / 2);
    const pitch = $derived(width > 0 ? Math.max(1, width - 2 * inset) : 0);

    const clamp = (index: number) => Math.max(0, Math.min(count - 1, index));

    const position = $derived(pitch > 0 ? offset / pitch : 0);
    const visibleIndex = $derived(clamp(Math.round(position)));

    /** The days drawn: the one in view and one either side. */
    const range = $derived.by(() => {
        if (pitch === 0) return [] as { index: number; key: string }[];
        let first = clamp(Math.floor(position));
        let last = clamp(Math.ceil(position));
        if (aim !== null) {
            first = Math.min(first, aim);
            last = Math.max(last, aim);
        }
        first = clamp(first - 1);
        last = clamp(last + 1);
        const indexes = Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
        // The day the page rests on holds the pager's height, so it stays drawn through a far jump.
        if (flow && (rested < first || rested > last)) indexes.push(rested);
        return indexes.map((index) => ({ index, key: axis.keyAt(index) }));
    });
    const keys = $derived(range.map((day) => day.key));

    $effect(() => {
        void store.buckets.size;
        store.ensure(keys);
    });

    $effect(() => {
        shift = position - Math.round(position);
    });

    let reported = "";
    $effect(() => {
        if (pitch === 0) return;
        const key = axis.keyAt(visibleIndex);
        if (key === reported) return;
        reported = key;
        untrack(() => onVisibleChange?.(key));
    });

    /** Re-reads the days on screen after a save or a sync. */
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

    /** The day kept in view while the width changes. */
    let anchor = untrack(() => axis.indexOf(opening));
    let aligning = false;

    /** With `flow`, how far the page had scrolled past the pager's top when a swipe began. */
    let lift = $state(0);
    let swiping = false;

    function page(): HTMLElement | null {
        return scroller?.closest<HTMLElement>("[data-stor-main]") ?? null;
    }

    /** Draws the days either side from the reading edge, before a swipe or a jump moves across. */
    function beginSwipe(): void {
        if (!flow || swiping || !scroller) return;
        swiping = true;
        const main = page();
        const line = edge?.() ?? (main ? main.getBoundingClientRect().top + parseFloat(getComputedStyle(main).paddingTop) : 0);
        lift = Math.max(0, Math.round(line - scroller.getBoundingClientRect().top));
    }

    /** The day landed on takes the pager's height, and the page brings its start to the reading edge. */
    function endSwipe(): void {
        if (!flow) return;
        swiping = false;
        const main = page();
        // The new day was drawn `lift` lower: scroll back by as much before it moves up, so nothing jumps.
        // Scrolling first, while the old day still holds the height, keeps a shorter day from clamping the page.
        if (main && lift > 0 && rested !== visibleIndex) main.scrollTop -= lift;
        flushSync(() => {
            rested = visibleIndex;
            lift = 0;
        });
    }

    function reducedMotion(): boolean {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }

    /** Scrolls to a day. */
    export function scrollTo(key: string, behavior: ScrollBehavior = "auto"): void {
        if (!scroller || pitch === 0) return;
        const index = axis.indexOf(key);
        anchor = index;
        if (Math.abs(index * pitch - scroller.scrollLeft) < 1) return;
        beginSwipe();
        // A far day has no element yet, and a snapping scroll needs one to land on.
        aim = index;
        void tick().then(() => {
            if (aim !== index || !scroller) return;
            scroller.scrollTo({ left: index * pitch, behavior: reducedMotion() ? "auto" : behavior });
        });
    }

    // Opening, and every change of width, puts the anchored day back in view.
    $effect.pre(() => {
        const step = pitch;
        void flow;
        if (!scroller || step === 0) return;
        untrack(() => {
            // Resizing and changing the scrolling layout can snap to a neighbour
            // before the anchored day's new geometry has reached the DOM.
            aligning = true;
            cancelAnimationFrame(frame);
            clearTimeout(quiet);
            scroller.style.scrollSnapType = "none";
            // Draw the days there first: a snapping scroll lands only on a day that exists.
            const target = anchor * step;
            offset = target;
            rested = anchor;
            void tick().then(() => {
                if (!scroller || step !== pitch) return;
                scroller.scrollLeft = target;
                offset = scroller.scrollLeft;
                scroller.style.scrollSnapType = "";
                aligning = false;
            });
        });
    });

    let frame = 0;
    let quiet: ReturnType<typeof setTimeout> | undefined;

    function handleScroll(): void {
        if (aligning) return;
        beginSwipe();
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            if (!scroller) return;
            offset = scroller.scrollLeft;
            if (aim === null && pitch > 0) anchor = visibleIndex;
        });
        if (!("onscrollend" in window)) {
            clearTimeout(quiet);
            quiet = setTimeout(settle, QUIET);
        }
    }

    function settle(): void {
        if (aligning || !scroller || pitch === 0) return;
        offset = scroller.scrollLeft;
        aim = null;
        anchor = visibleIndex;
        endSwipe();
        // A day that has left the screen starts at its top when it comes back.
        for (const column of scroller.querySelectorAll<HTMLElement>("[data-pager-index]")) {
            if (Number(column.dataset.pagerIndex) !== visibleIndex && column.scrollTop !== 0) column.scrollTop = 0;
        }
        onSettle?.(axis.keyAt(visibleIndex));
    }

    // Opening on a day counts as resting there, so the address follows a day the opening had to move.
    let settledOnce = false;
    $effect(() => {
        if (pitch === 0 || settledOnce) return;
        settledOnce = true;
        untrack(() => onSettle?.(axis.keyAt(visibleIndex)));
    });

    const homeIndex = $derived(home ? axis.indexOf(home.key) : null);
    const homeAway = $derived(
        homeIndex === null || pitch === 0 ? null
            : homeIndex < visibleIndex ? "left"
            : homeIndex > visibleIndex ? "right"
            : null,
    );

    $effect(() => () => {
        cancelAnimationFrame(frame);
        clearTimeout(quiet);
    });
</script>

<div class="pager" class:flow>
    <div
        {...attributes}
        bind:this={scroller}
        bind:clientWidth={width}
        class={["scroller", className]}
        style:scroll-padding-inline="{inset}px"
        onscroll={handleScroll}
        onscrollend={settle}
    >
        <div class="rail" style:width="{2 * inset + count * pitch}px">
            {#each range as day (day.key)}
                <div
                    class="column"
                    class:rested={flow && day.index === rested}
                    style:left={flow && day.index === rested ? undefined : `${inset + day.index * pitch}px`}
                    style:margin-left={flow && day.index === rested ? `${inset + day.index * pitch}px` : undefined}
                    style:top={flow && day.index !== rested ? `${lift}px` : undefined}
                    style:width="{pitch}px"
                    style:padding-inline="{GAP / 2}px"
                    data-pager-index={day.index}
                    data-days-scroll
                >
                    {@render item(day.key, store.get(day.key))}
                </div>
            {/each}
        </div>
    </div>
    {#if home && homeAway}
        <button type="button" class="home-jump" onclick={() => home && scrollTo(home.key, "smooth")}>
            {#if homeAway === "left"}<IconArrowLeft class="h-4 w-4" />{home.label}{:else}{home.label}<IconArrowRight class="h-4 w-4" />{/if}
        </button>
    {/if}
</div>

<style>
    .pager { position: relative; height: 100%; }
    .scroller {
        position: relative; height: 100%; overflow-x: auto; overflow-y: hidden;
        overscroll-behavior-x: contain; scrollbar-width: none;
    }
    .scroller::-webkit-scrollbar { display: none; }
    .scroller { scroll-snap-type: x mandatory; }
    .rail { position: relative; height: 100%; }
    .column {
        position: absolute; top: 0; bottom: 0; overflow-x: hidden; overflow-y: auto;
        overscroll-behavior-y: contain; scrollbar-width: none;
    }
    .column::-webkit-scrollbar { display: none; }
    .column { scroll-snap-align: start; scroll-snap-stop: always; }
    /* The page scrolls: nothing here has a height of its own but the day it rests on. */
    .flow, .flow .scroller, .flow .rail { height: auto; }
    .flow .column { bottom: auto; overflow: visible; overflow-x: clip; }
    .flow .column.rested { position: relative; }
    .home-jump {
        position: absolute;
        bottom: 1rem;
        left: 50%;
        z-index: 3;
        display: inline-flex;
        height: 2.25rem;
        align-items: center;
        gap: 0.25rem;
        padding: 0 0.75rem;
        border: 0;
        border-radius: 999px;
        background: var(--stor-surface-raised);
        box-shadow: var(--stor-shadow-md);
        font-size: 13px;
        font-weight: 600;
        color: var(--stor-ink);
        transform: translateX(-50%);
    }
    /* Paged by the page, the way back floats at the screen's bottom-left, level with the page's action. */
    .flow .home-jump {
        position: fixed;
        left: 12px;
        bottom: calc(var(--stor-mobile-bottom-inset) + var(--stor-mobile-nav-height) + var(--stor-mobile-stack-gap));
        z-index: 40;
        height: var(--stor-mobile-action-height);
        padding: 0 1rem;
        font-size: 14px;
        transform: none;
    }
    @media (min-width: 768px) { .flow .home-jump { left: 116px; } }
    .home-jump:hover { background: var(--stor-surface-hover); }
    .home-jump:focus-visible { outline: 2px solid var(--stor-focus); outline-offset: 2px; }
</style>
