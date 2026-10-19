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
            class="stor-toast pointer-events-auto"
            role={item.type === "error" ? "alert" : "status"}
            data-type={item.type}
        >
            <Icon class="h-[18px] w-[18px] shrink-0 {item.type === 'progress' ? 'animate-spin' : 'opacity-80'}" />
            <div class="min-w-0 flex-1 py-1.5">{item.message}</div>
            {#if item.action}
                <button type="button" class="stor-toast-action" onclick={() => runAction(item)}>{item.action.label}</button>
            {/if}
            <button type="button" class="stor-toast-close" aria-label="Dismiss notification" onclick={() => dismissNotification(item.id)}>
                <IconClose class="h-4 w-4" />
            </button>
        </div>
    {/each}
</div>
