<script lang="ts">
    import { onDestroy } from "svelte";
    import {
        dismissNotification,
        notificationState,
        type AppNotification,
    } from "../state/notifications.svelte.js";
    import IconCheck from "~icons/mdi/check-circle-outline";
    import IconAlert from "~icons/mdi/alert-circle-outline";
    import IconInfo from "~icons/mdi/information-outline";
    import IconLoading from "~icons/mdi/loading";
    import IconClose from "~icons/mdi/close";

    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    $effect(() => {
        const ids = new Set(notificationState.items.map((item) => item.id));

        for (const item of notificationState.items) {
            // A non-positive duration marks a sticky notification that the
            // caller dismisses explicitly when its task settles.
            if (item.duration > 0 && !timers.has(item.id)) {
                timers.set(
                    item.id,
                    setTimeout(() => {
                        dismissNotification(item.id);
                        timers.delete(item.id);
                    }, item.duration),
                );
            }
        }

        for (const [id, timer] of timers) {
            if (!ids.has(id)) {
                clearTimeout(timer);
                timers.delete(id);
            }
        }
    });

    onDestroy(() => {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
    });

    function iconFor(item: AppNotification) {
        if (item.type === "success") return IconCheck;
        if (item.type === "error") return IconAlert;
        if (item.type === "progress") return IconLoading;
        return IconInfo;
    }

    async function runAction(item: AppNotification) {
        dismissNotification(item.id);
        await item.action?.run();
    }
</script>

<div
    class="stor-notifications pointer-events-none fixed inset-x-3 top-[calc(4rem+env(safe-area-inset-top))] z-[var(--stor-layer-toast)] flex flex-col items-end gap-2 md:left-[104px] md:top-[calc(1rem+env(safe-area-inset-top))] lg:bottom-5 lg:left-auto lg:right-5 lg:top-auto lg:w-[24rem]"
    aria-live="polite"
    aria-relevant="additions"
>
    {#each notificationState.items as item (item.id)}
        {@const Icon = iconFor(item)}
        <div
            class="pointer-events-auto flex w-full items-start gap-3 rounded-xl border bg-[var(--stor-surface-overlay)] px-4 py-3 shadow-[var(--stor-elevation-3)] {item.type ===
            'error'
                ? 'border-red-200'
                : item.type === 'success'
                  ? 'border-emerald-200'
                  : 'border-[var(--stor-border)]'}"
            role={item.type === "error" ? "alert" : "status"}
        >
            <Icon
                class="mt-0.5 h-5 w-5 shrink-0 {item.type === 'error'
                    ? 'text-red-600'
                    : item.type === 'success'
                      ? 'text-emerald-600'
                      : item.type === 'progress'
                        ? 'animate-spin text-[var(--stor-accent-strong)]'
                        : 'text-stone-600'}"
            />
            <div class="min-w-0 flex-1 text-sm font-medium text-stone-800">
                {item.message}
            </div>
            {#if item.action}
                <button
                    type="button"
                    class="shrink-0 text-sm font-semibold text-stone-950 underline decoration-stone-300 underline-offset-4 hover:decoration-stone-900"
                    onclick={() => runAction(item)}
                >
                    {item.action.label}
                </button>
            {/if}
            <button
                type="button"
                class="-mr-1 shrink-0 rounded-lg p-1 text-[var(--stor-muted-text)] hover:bg-[var(--stor-surface-muted)] hover:text-stone-700"
                aria-label="Dismiss notification"
                onclick={() => dismissNotification(item.id)}
            >
                <IconClose class="h-4 w-4" />
            </button>
        </div>
    {/each}
</div>
