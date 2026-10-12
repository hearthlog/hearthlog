<script lang="ts">
    import {
        SIDEBAR_DEFAULT_WIDTH,
        SIDEBAR_KEY_STEP,
        SIDEBAR_MAX_WIDTH,
        SIDEBAR_MIN_WIDTH,
        SIDEBAR_RAIL_WIDTH,
        clampSidebarWidth,
        resolveSidebarDrag,
    } from './sidebar-size.js';

    // The edge of the sidebar card. A drag reports every frame with `final` false and once on release;
    // Escape or a cancelled pointer reports the starting state as final.
    let {
        width,
        folded,
        onChange,
    }: {
        width: number;
        folded: boolean;
        onChange: (width: number, folded: boolean, final: boolean) => void;
    } = $props();

    type Drag = { moved: boolean; x: number; start: number; width: number; folded: boolean; raw: number; frame: number };
    let drag: Drag | null = null;
    let handle = $state<HTMLElement>();

    const current = $derived(folded ? SIDEBAR_RAIL_WIDTH : width);

    function setResizing(on: boolean): void {
        document.documentElement.toggleAttribute('data-sidebar-resizing', on);
    }

    function apply(final: boolean): void {
        if (!drag) return;
        const resolved = resolveSidebarDrag(drag.raw);
        onChange(resolved.width ?? drag.width, resolved.folded, final);
    }

    function onPointerDown(event: PointerEvent): void {
        if (event.button !== 0 || !handle) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        drag = { moved: false, x: event.clientX, start: current, width, folded, raw: current, frame: 0 };
        setResizing(true);
    }

    function onPointerMove(event: PointerEvent): void {
        if (!drag) return;
        drag.raw = drag.start + (event.clientX - drag.x);
        drag.moved = true;
        if (drag.frame) return;
        drag.frame = requestAnimationFrame(() => {
            if (!drag) return;
            drag.frame = 0;
            apply(false);
        });
    }

    function finish(cancel: boolean): void {
        if (!drag) return;
        cancelAnimationFrame(drag.frame);
        const ended = drag;
        drag = null;
        setResizing(false);
        if (!ended.moved) return;
        if (cancel) onChange(ended.width, ended.folded, true);
        else {
            const resolved = resolveSidebarDrag(ended.raw);
            onChange(resolved.width ?? ended.width, resolved.folded, true);
        }
    }

    function onKeyDown(event: KeyboardEvent): void {
        const open = (next: number) => onChange(clampSidebarWidth(next), false, true);
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            if (folded) return;
            if (width - SIDEBAR_KEY_STEP < SIDEBAR_MIN_WIDTH) onChange(width, true, true);
            else open(width - SIDEBAR_KEY_STEP);
        } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            open(folded ? width : width + SIDEBAR_KEY_STEP);
        } else if (event.key === 'Home') {
            event.preventDefault();
            open(SIDEBAR_MIN_WIDTH);
        } else if (event.key === 'End') {
            event.preventDefault();
            open(SIDEBAR_MAX_WIDTH);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            onChange(width, !folded, true);
        }
    }

    $effect(() => () => {
        if (drag) cancelAnimationFrame(drag.frame);
        setResizing(false);
    });
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && drag) finish(true); }} />

<div
    bind:this={handle}
    class="stor-sidebar-handle"
    role="separator"
    tabindex="0"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    aria-valuemin={SIDEBAR_MIN_WIDTH}
    aria-valuemax={SIDEBAR_MAX_WIDTH}
    aria-valuenow={current}
    aria-valuetext={folded ? 'Folded to rail' : `${width} pixels`}
    data-stor-no-drag
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={() => finish(false)}
    onpointercancel={() => finish(true)}
    ondblclick={() => onChange(SIDEBAR_DEFAULT_WIDTH, false, true)}
    onkeydown={onKeyDown}
></div>
