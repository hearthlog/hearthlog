<script lang="ts">
    import { formatHistoryDateTime } from "@hearthlog/runtime/history/history.js";
    import {
        nearestBucket,
        type HistoryActivity,
        type HistoryGhost,
        type HistoryMarker,
    } from "@hearthlog/runtime/history/timeline.js";

    let {
        version,
        activity = null,
        markers = [],
        ghosts = [],
        loading = false,
        pointLabel = "",
        onSeek,
        onStep,
    }: {
        version: number;
        activity?: HistoryActivity | null;
        markers?: HistoryMarker[];
        ghosts?: HistoryGhost[];
        loading?: boolean;
        pointLabel?: string;
        onSeek: (version: number) => void | Promise<void>;
        onStep: (direction: "previous" | "next") => void | Promise<void>;
    } = $props();

    const TRACK_HEIGHT = 46;
    const MAX_BAR_HEIGHT = 32;

    let track = $state<HTMLElement | null>(null);
    let width = $state(0);
    let hover = $state<{ x: number; version: number } | null>(null);
    let dragVersion = $state<number | null>(null);

    const minVersion = $derived(activity?.minVersion ?? 1);
    const maxVersion = $derived(activity?.maxVersion ?? Math.max(version, 1));
    const range = $derived(Math.max(1, maxVersion - minVersion + 1));
    const activeVersion = $derived(dragVersion ?? version);
    const playheadX = $derived(width > 0 ? ((activeVersion - minVersion) / range) * width : 0);
    const hoverBucket = $derived(
        activity && hover ? nearestBucket(activity, hover.version) : null,
    );
    const hoverMarker = $derived(
        hover
            ? markers.find(
                  (marker) =>
                      marker.version !== null &&
                      Math.abs(xFor(marker.version) - hover!.x) < 7,
              ) ?? null
            : null,
    );
    const hoverLabel = $derived.by(() => {
        if (hoverMarker) return hoverMarker.label;
        if (!hoverBucket) return "";
        const date = formatHistoryDateTime(hoverBucket.endTimestamp);
        return `${date} · ${hoverBucket.count} change${hoverBucket.count === 1 ? "" : "s"}`;
    });

    function xFor(value: number): number {
        return ((value - minVersion) / range) * width;
    }

    function versionAt(clientX: number): number {
        if (!track) return version;
        const rect = track.getBoundingClientRect();
        if (rect.width <= 0) return version;
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        return Math.round(minVersion + ratio * (range - 1));
    }

    function barX(startVersion: number): number {
        return xFor(startVersion);
    }

    function barWidth(startVersion: number, endVersion: number): number {
        return Math.max(1.5, xFor(endVersion + 1) - xFor(startVersion) - 1);
    }

    function barHeight(count: number): number {
        if (!activity) return 2;
        return Math.max(2, (count / activity.maxCount) * MAX_BAR_HEIGHT);
    }

    function handlePointerDown(event: PointerEvent): void {
        if (!activity || loading) return;
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        dragVersion = versionAt(event.clientX);
        hover = { x: xFor(dragVersion), version: dragVersion };
    }

    function handlePointerMove(event: PointerEvent): void {
        if (!activity) return;
        const value = versionAt(event.clientX);
        hover = { x: xFor(value), version: value };
        if (dragVersion !== null) dragVersion = value;
    }

    function handlePointerUp(): void {
        if (dragVersion === null) return;
        const target = dragVersion;
        dragVersion = null;
        void onSeek(target);
    }

    function handleKeydown(event: KeyboardEvent): void {
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            void onStep("previous");
        } else if (event.key === "ArrowRight") {
            event.preventDefault();
            void onStep("next");
        } else if (event.key === "Home") {
            event.preventDefault();
            void onSeek(minVersion);
        } else if (event.key === "End") {
            event.preventDefault();
            void onSeek(maxVersion);
        }
    }

    function formatDay(timestamp: number | undefined): string {
        if (!timestamp) return "";
        return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
            new Date(timestamp),
        );
    }
</script>

<div class="space-y-1.5">
    <div
        bind:this={track}
        bind:clientWidth={width}
        class="relative w-full touch-none select-none overflow-hidden rounded-xl bg-[var(--stor-surface-muted)] {activity && !loading
            ? 'cursor-pointer'
            : 'cursor-default'} {loading ? 'motion-safe:animate-pulse' : ''}"
        style="height: {TRACK_HEIGHT}px"
        role="slider"
        tabindex="0"
        aria-label="History timeline"
        aria-valuemin={minVersion}
        aria-valuemax={maxVersion}
        aria-valuenow={version}
        aria-valuetext={pointLabel || `Version ${version}`}
        aria-busy={loading}
        onpointerdown={handlePointerDown}
        onpointermove={handlePointerMove}
        onpointerup={handlePointerUp}
        onpointercancel={() => (dragVersion = null)}
        onpointerleave={() => (hover = null)}
        onkeydown={handleKeydown}
    >
        {#if activity && !loading}
            {#each activity.buckets as bucket (bucket.bucket)}
                <div
                    class="absolute bottom-0 rounded-t-[3px] bg-[var(--stor-info-border)]"
                    style="left: {barX(bucket.startVersion)}px; width: {barWidth(bucket.startVersion, bucket.endVersion)}px; height: {barHeight(bucket.count)}px"
                    title={`${formatHistoryDateTime(bucket.endTimestamp)} · ${bucket.count} change${bucket.count === 1 ? "" : "s"}`}
                ></div>
            {/each}

            {#each ghosts as ghost (ghost.id)}
                <div
                    class="absolute bottom-0 w-[3px] rounded-t-[2px] border border-dashed border-[var(--stor-muted-text)]/70 bg-[var(--stor-surface)]"
                    style="left: {xFor(ghost.version)}px; height: {MAX_BAR_HEIGHT}px"
                    title={`Removed · ${ghost.label}`}
                ></div>
            {/each}

            {#each markers.filter((marker) => marker.version !== null) as marker (marker.id)}
                <div
                    class="absolute top-0 w-[2px] {marker.type === 'restore'
                        ? 'bg-[var(--stor-warning)]'
                        : marker.active
                            ? 'bg-[var(--stor-accent-strong)]'
                            : 'bg-[var(--stor-muted-text)]/50'}"
                    style="left: {xFor(marker.version!)}px; height: 9px"
                    title={marker.label}
                ></div>
            {/each}

            {#if hover}
                <div
                    class="pointer-events-none absolute inset-y-0 w-px bg-[var(--stor-ink)]/20"
                    style="left: {hover.x}px"
                ></div>
            {/if}

            <div
                class="pointer-events-none absolute inset-y-0 w-[2px] bg-[var(--stor-info)]"
                style="left: {playheadX}px"
            ></div>
            <div
                class="pointer-events-none absolute -top-[1px] h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 border-[var(--stor-surface-muted)] bg-[var(--stor-info)]"
                style="left: {playheadX}px"
            ></div>

            {#if hover && hoverLabel}
                <div
                    class="pointer-events-none absolute top-1 z-10 max-w-[min(16rem,80%)] -translate-x-1/2 whitespace-nowrap rounded-lg border border-[var(--stor-border)] bg-[var(--stor-surface-raised)] px-2 py-1 text-xs font-medium text-[var(--stor-ink)] shadow-[var(--stor-shadow-sm)]"
                    style="left: {Math.min(Math.max(hover.x, 70), Math.max(70, width - 70))}px"
                >
                    {hoverLabel}
                </div>
            {/if}
        {:else if loading}
            <div class="absolute inset-0 flex items-center justify-center text-xs font-medium text-[var(--stor-muted-text)]" role="status">
                Building timeline…
            </div>
        {:else}
            <div class="absolute inset-0 flex items-center justify-center text-xs font-medium text-[var(--stor-muted-text)]">
                No synced history yet
            </div>
        {/if}
    </div>

    <div class="flex items-center justify-between gap-3 text-[10.5px] font-medium uppercase tracking-wide text-[var(--stor-muted-text)]">
        <span>{formatDay(activity?.firstTimestamp)}</span>
        {#if ghosts.length > 0 || markers.length > 0}
            <span class="flex items-center gap-2 normal-case tracking-normal">
                {#if markers.some((marker) => marker.type === "restore")}
                    <span class="inline-flex items-center gap-1">
                        <span class="h-2 w-[2px] bg-[var(--stor-warning)]"></span>
                        restore
                    </span>
                {/if}
                {#if markers.some((marker) => marker.type === "excision")}
                    <span class="inline-flex items-center gap-1">
                        <span class="h-2 w-[2px] bg-[var(--stor-accent-strong)]"></span>
                        removed
                    </span>
                {/if}
                {#if ghosts.length > 0}
                    <span class="inline-flex items-center gap-1">
                        <span class="h-2 w-[3px] rounded-sm border border-dashed border-[var(--stor-muted-text)]/70"></span>
                        ghost
                    </span>
                {/if}
            </span>
        {/if}
        <span>{formatDay(activity?.lastTimestamp)}</span>
    </div>
</div>
