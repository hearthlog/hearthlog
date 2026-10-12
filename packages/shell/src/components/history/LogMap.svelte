<script lang="ts">
    import type { LogSummary } from '@hearthlog/runtime/ledger/index.js';
    import type { HistoryPoint } from '@hearthlog/runtime/history/contracts.js';
    import type { LogNode } from '@hearthlog/runtime/history/lineage.js';
    import { logMap, type MapSpan } from '@hearthlog/runtime/history/log-map.js';
    import { formatForkPoint } from '@hearthlog/runtime/history/log-format.js';

    let {
        nodes,
        logs,
        currentLogId,
        points = [],
        span,
        openActionId = null,
        range = null,
        disabled = false,
        onOpen,
        onPick,
        onReveal,
    }: {
        /** Shown logs in tree order. */
        nodes: LogNode[];
        /** Every log, to place copied actions on the source's line even past hidden logs. */
        logs: LogSummary[];
        currentLogId: string | null;
        /** The current log's actions within the map. */
        points?: HistoryPoint[];
        /** The time the map covers. */
        span: MapSpan;
        /** The action open in the list. */
        openActionId?: string | null;
        /** The time span of the actions on screen in the list below. */
        range?: { from: number; to: number } | null;
        disabled?: boolean;
        /** Open another log. */
        onOpen: (logId: string) => void;
        /** Open an action in the list. */
        onPick: (actionId: string) => void;
        /** Scroll the list to an action without opening it. */
        onReveal: (actionId: string) => void;
    } = $props();

    // One clock per panel visit; the map does not need to tick.
    const now = Date.now();
    const model = $derived(logMap(nodes, { currentLogId, now, span }));
    const currentRow = $derived(model.rows.find(row => row.node.log.id === currentLogId) ?? null);

    /** Each action on the line of the log it was made in: copied ones on their source's line. */
    const marks = $derived.by(() => {
        if (!currentRow) return [];
        const byId = new Map(logs.map(log => [log.id, log]));
        const rowY = new Map(model.rows.map(row => [row.node.log.id, row.y]));
        return points.map(point => {
            let log = byId.get(currentLogId ?? '');
            let y = currentRow.y;
            while (log?.sourceLogId && point.version !== null && point.version <= (log.sourceVersion ?? 0)) {
                log = byId.get(log.sourceLogId);
                const shown = log ? rowY.get(log.id) : undefined;
                if (shown !== undefined) y = shown;
            }
            return { ...point, x: model.x(point.timestamp), y, copied: y !== currentRow.y };
        });
    });

    const bracket = $derived.by(() => {
        if (!currentRow || !range) return null;
        const from = model.x(range.from) - 4;
        const to = model.x(range.to) + 4;
        return { x: from, width: Math.max(8, to - from) };
    });

    let svg = $state<SVGSVGElement | null>(null);
    let box = $state<HTMLDivElement | null>(null);
    let hover = $state<(typeof marks)[number] | null>(null);
    let scrubbing = $state(false);
    let pressed: string | null = null;
    let suppressOpen = false;
    let frame = 0;

    function path(row: (typeof model.rows)[number]): string {
        if (!row.fork) return `M${row.x0} ${row.y} H${row.x1}`;
        const bend = Math.min(6, row.y - row.fork.y);
        return `M${row.fork.x} ${row.fork.y} V${row.y - bend} Q${row.fork.x} ${row.y} ${row.fork.x + bend} ${row.y} H${Math.max(row.x1, row.fork.x + bend)}`;
    }

    function openable(node: LogNode): boolean {
        return node.log.id !== currentLogId && node.log.status !== 'preparing';
    }

    /** The pointer in map units. */
    function local(event: PointerEvent): { x: number; y: number } | null {
        const rect = svg?.getBoundingClientRect();
        if (!rect || rect.width === 0) return null;
        return {
            x: ((event.clientX - rect.left) / rect.width) * model.width,
            y: ((event.clientY - rect.top) / rect.height) * model.height,
        };
    }

    /** The mark under the pointer, if one is close enough to aim at. */
    function markAt(at: { x: number; y: number }, reach: number) {
        let best: (typeof marks)[number] | null = null;
        let distance = reach * reach;
        // Marks come newest first; within a stack the newest answers unless another is clearly closer.
        for (const mark of marks) {
            const d = (mark.x - at.x) ** 2 + ((mark.y - at.y) * 1.5) ** 2;
            if (best ? d < distance - 1 : d <= distance) { best = mark; distance = d; }
        }
        return best;
    }

    /** The action closest in time to a place on the axis. */
    function nearestInTime(x: number) {
        let best: (typeof marks)[number] | null = null;
        for (const mark of marks) if (!best || Math.abs(mark.x - x) < Math.abs(best.x - x)) best = mark;
        return best;
    }

    function scrubTo(x: number): void {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            frame = 0;
            const mark = nearestInTime(x);
            if (mark) { hover = mark; onReveal(mark.id); }
        });
    }

    function reach(event: PointerEvent): number {
        return event.pointerType === 'touch' ? 16 : 9;
    }

    function pointerdown(event: PointerEvent): void {
        const at = local(event);
        if (!at || disabled || event.button !== 0) return;
        const mark = markAt(at, reach(event));
        if (mark) {
            pressed = mark.id;
            suppressOpen = true;
            return;
        }
        suppressOpen = false;
        if ((event.target as Element | null)?.closest('[data-log]')) return;
        scrubbing = true;
        svg?.setPointerCapture(event.pointerId);
        scrubTo(at.x);
    }

    function pointermove(event: PointerEvent): void {
        const at = local(event);
        if (!at) return;
        if (scrubbing) { scrubTo(at.x); return; }
        hover = markAt(at, reach(event));
    }

    function pointerup(event: PointerEvent): void {
        const at = local(event);
        if (pressed && at && markAt(at, reach(event))?.id === pressed) onPick(pressed);
        pressed = null;
        if (scrubbing) {
            scrubbing = false;
            if (svg?.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
        }
    }

    function openLog(logId: string): void {
        if (suppressOpen) { suppressOpen = false; return; }
        if (!disabled) onOpen(logId);
    }

    function keydown(event: KeyboardEvent, node: LogNode): void {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (openable(node) && !disabled) onOpen(node.log.id);
    }

    // The wheel over the map scrolls the list, as a minimap does.
    $effect(() => {
        const element = box;
        if (!element) return;
        const wheel = (event: WheelEvent) => {
            const body = element.closest('[data-stor-drawer]')?.querySelector<HTMLElement>('.stor-drawer-body');
            if (!body) return;
            event.preventDefault();
            body.scrollBy({ top: event.deltaY + event.deltaX });
        };
        element.addEventListener('wheel', wheel, { passive: false });
        return () => element.removeEventListener('wheel', wheel);
    });

    $effect(() => () => { if (frame) cancelAnimationFrame(frame); });

    /** Other actions drawn on the same spot, which the label can only count. */
    const nearby = $derived(hover ? marks.filter(mark => mark.id !== hover!.id && mark.y === hover!.y && Math.abs(mark.x - hover!.x) < 2.5).length : 0);

    const tooltip = $derived(hover ? {
        left: (hover.x / model.width) * 100,
        top: (hover.y / model.height) * 100,
        shift: hover.x < model.width * 0.25 ? '-8px' : hover.x > model.width * 0.75 ? 'calc(-100% + 8px)' : '-50%',
    } : null);
</script>

<div bind:this={box} class="log-map rounded-2xl bg-[var(--stor-surface-muted)] px-1.5 pt-0.5">
    <div class="relative">
        <svg
            bind:this={svg}
            viewBox="0 0 {model.width} {model.height}"
            class="block w-full touch-none select-none {scrubbing ? 'cursor-grabbing' : hover ? 'cursor-pointer' : 'cursor-ew-resize'}"
            role="group"
            aria-label="Map of your logs over time. Drag along it to move through the list."
            onpointerdown={pointerdown}
            onpointermove={pointermove}
            onpointerup={pointerup}
            onpointercancel={pointerup}
            onpointerleave={() => { if (!scrubbing) hover = null; }}
        >
            <line class="axis" x1="8" x2={model.width - 8} y1={model.axisY} y2={model.axisY} />
            {#each model.ticks as tick (tick.label + tick.x)}
                <text class="tick" x={tick.x} y={model.axisY + 11} text-anchor={tick.anchor}>{tick.label}</text>
            {/each}
            {#if bracket}
                <rect class="range" x={bracket.x} y="4" width={bracket.width} height={model.axisY - 4} rx="5" />
            {/if}
            {#each model.rows as row (row.node.log.id)}
                {@const log = row.node.log}
                {@const current = log.id === currentLogId}
                {#if row.clipped}
                    <line class="lead-in" x1="2" x2={row.x0 + 10} y1={row.y} y2={row.y} />
                {/if}
                {#if openable(row.node)}
                    <g
                        class="log"
                        class:hidden-log={Boolean(log.hiddenAt)}
                        data-log={log.id}
                        role="button"
                        tabindex="0"
                        aria-label={`Open ${log.name}`}
                        aria-disabled={disabled}
                        onclick={() => openLog(log.id)}
                        onkeydown={(event) => keydown(event, row.node)}
                    >
                        <path class="hit" d={path(row)} />
                        <path class="line" d={path(row)} />
                        <text class="name" x={row.label.x} y={row.y - 6} text-anchor={row.label.anchor}>{log.name}</text>
                    </g>
                {:else}
                    <g class="log" class:current class:preparing={log.status === 'preparing'} aria-hidden="true">
                        <path class="line" d={path(row)} />
                        <text class="name" x={row.label.x} y={row.y - 6} text-anchor={row.label.anchor}>{log.name}{log.status === 'preparing' ? ' · preparing' : ''}</text>
                    </g>
                {/if}
            {/each}
            <g aria-hidden="true">
                {#each marks as mark (mark.id)}
                    <circle class="mark" class:copied={mark.copied} cx={mark.x} cy={mark.y} r="2.3" />
                {/each}
                {#each marks.filter(mark => mark.id === openActionId || mark.id === hover?.id) as mark (mark.id)}
                    <circle class="mark-on" cx={mark.x} cy={mark.y} r="4.2" />
                {/each}
            </g>
        </svg>
        {#if hover && tooltip}
            <div
                class="pointer-events-none absolute z-10 w-max max-w-[16rem] rounded-lg bg-[var(--stor-ink)] px-2 py-1 text-xs leading-snug text-[var(--stor-surface)] shadow-[var(--stor-shadow-md)]"
                style="left: {tooltip.left}%; top: {tooltip.top}%; transform: translate({tooltip.shift}, calc(-100% - 8px));"
                aria-hidden="true"
            >
                <span class="block truncate font-semibold">{hover.label}</span>
                <span class="block whitespace-nowrap opacity-75">{formatForkPoint(hover.timestamp)}{hover.copied ? ' · copied' : ''}{nearby ? ` · +${nearby} nearby` : ''}</span>
            </div>
        {/if}
    </div>
</div>

<style>
    .axis { stroke: var(--stor-border); stroke-width: 1; }
    .tick { font-size: 9.5px; fill: var(--stor-muted-text); }
    .line { fill: none; stroke: color-mix(in srgb, var(--stor-muted-text) 75%, transparent); stroke-width: 2; stroke-linecap: round; }
    .hit { fill: none; stroke: transparent; stroke-width: 12; }
    .name { font-size: 10.5px; font-weight: 550; fill: var(--stor-muted-text); }
    .log[role='button'] { cursor: pointer; outline: none; }
    .log[role='button']:hover .line, .log[role='button']:focus-visible .line { stroke: var(--stor-ink); }
    .log[role='button']:hover .name, .log[role='button']:focus-visible .name { fill: var(--stor-ink); }
    .log[role='button']:focus-visible .hit { stroke: color-mix(in srgb, var(--stor-focus) 22%, transparent); }
    .current .line { stroke: var(--stor-ink); stroke-width: 3; }
    .current .name { fill: var(--stor-ink); font-weight: 700; }
    .preparing .line { stroke-dasharray: 3 4; }
    .hidden-log { opacity: 0.55; }
    .lead-in { stroke: color-mix(in srgb, var(--stor-muted-text) 60%, transparent); stroke-width: 2; stroke-dasharray: 2 3; }
    .mark { fill: var(--stor-ink); stroke: var(--stor-surface-muted); stroke-width: 1.2; pointer-events: none; }
    .mark.copied { fill: var(--stor-muted-text); }
    .mark-on { fill: var(--stor-surface); stroke: var(--stor-ink); stroke-width: 2; pointer-events: none; }
    .range { fill: color-mix(in srgb, var(--stor-ink) 7%, transparent); stroke: color-mix(in srgb, var(--stor-ink) 30%, transparent); stroke-width: 1; pointer-events: none; }
</style>
