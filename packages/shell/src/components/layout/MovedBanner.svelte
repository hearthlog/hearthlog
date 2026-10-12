<script lang="ts">
    import { onMount } from "svelte";
    import Button from "@hearthlog/ui/components/ui/Button.svelte";
    import { clearMovedWorkspace, movedWorkspace, restoreMovedWorkspace } from "@hearthlog/runtime/store/moved.svelte.js";
    import { exportPendingWork } from "@hearthlog/runtime/store/pending-work-transfer.js";
    import { notify } from "@hearthlog/ui/state/notifications.svelte.js";
    import { sync } from "@hearthlog/runtime/store/sync.svelte.js";

    let busy = $state(false);
    onMount(() => { void restoreMovedWorkspace(); });

    const destination = $derived(movedWorkspace.value?.destination ?? null);

    async function exportWork(): Promise<void> {
        busy = true;
        try {
            const { file, name } = await exportPendingWork();
            const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
            const link = Object.assign(document.createElement("a"), { href: url, download: name });
            link.click();
            URL.revokeObjectURL(url);
            notify.success(file.operations.length === 0 ? "Nothing was waiting to be sent" : `Exported ${file.operations.length} pending change${file.operations.length === 1 ? "" : "s"}`);
        } catch (error) {
            notify.error(error instanceof Error ? error.message : "Could not export the pending changes");
        } finally {
            busy = false;
        }
    }

    async function tryAgain(): Promise<void> {
        await clearMovedWorkspace();
        void sync("manual").catch(() => undefined);
    }
</script>

{#if movedWorkspace.value}
    <div class="m-2.5 sm:m-3 rounded-xl border border-[var(--stor-border)] bg-[var(--stor-surface-muted)] p-3 text-sm" role="alert">
        <p class="font-medium text-[var(--stor-ink)]">This workspace moved</p>
        <p class="mt-1 text-[var(--stor-muted-text)]">
            {#if destination}It lives at {destination} now.{:else}It lives somewhere else now.{/if}
            Changes made here stay on this device until you export them.
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onclick={exportWork} disabled={busy}>Export pending changes</Button>
            {#if destination}
                <Button variant="secondary" size="sm" onclick={() => location.assign(destination)}>Open new location</Button>
            {/if}
            <Button variant="ghost" size="sm" onclick={tryAgain} disabled={busy}>Try again here</Button>
        </div>
    </div>
{/if}
