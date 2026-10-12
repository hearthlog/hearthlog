<script lang="ts">
    import { eventLogFilename } from "@hearthlog/runtime/store/event-log.svelte.js";
    import { MODULE_REFRESH_KEYS } from '#generated/modules';

    import { LedgerClient, loadLedgerConfig } from "@hearthlog/runtime/ledger/index.js";
    import { createAndActivateLog } from "@hearthlog/runtime/log-management.js";
    import { logs } from "@hearthlog/runtime/store/logs.svelte.js";

    import { refreshPageData as invalidate } from "@hearthlog/runtime/runtime/refresh.js";
    import {
        syncStatus,
        loadStoredLogSnapshot,
        runSyncCoordinator,
        stopRealtime,
    } from "@hearthlog/runtime/store/sync.svelte.js";
    import ConfirmDialog from "@hearthlog/ui/components/ConfirmDialog.svelte";
    import IconDeleteOutline from "~icons/mdi/delete-outline";
    import IconPlus from "~icons/mdi/plus";
    import IconRefresh from "~icons/mdi/refresh";

    let files = $state(logs.value);
    let newFileName = $state("");
    let status = $state("");
    let showDeleteConfirm = $state(false);
    let logToDelete = $state<{ id: string; name: string } | null>(null);

    let client: LedgerClient | null = null;

    function getClient(): LedgerClient {
        if (!client) {
            const config = loadLedgerConfig();
            client = new LedgerClient(config);
        }
        return client;
    }

    function requestDeleteLog(logId: string, logName: string) {
        logToDelete = { id: logId, name: logName };
        showDeleteConfirm = true;
    }

    async function confirmDeleteLog() {
        if (!logToDelete) return;

        const { id, name } = logToDelete;
        showDeleteConfirm = false;

        try {
            status = `Deleting log "${name}"...`;

            const client = getClient();
            await client.deleteLog(id);

            // If we deleted the active log, clear it
            if (eventLogFilename.value === id) {
                await stopRealtime();
                await eventLogFilename.set("", "");
                await loadStoredLogSnapshot(null, []);
                await invalidateAllViews();
            }

            await logs.refresh();
            files = logs.value;
            status = `Successfully deleted "${name}".`;
        } catch (error) {
            status = `Error deleting log: ${error instanceof Error ? error.message : String(error)}`;
            syncStatus.hasError = true;
            syncStatus.errorMessage = "Failed to delete log";
        } finally {
            logToDelete = null;
        }
    }

    function cancelDeleteLog() {
        showDeleteConfirm = false;
        logToDelete = null;
    }

    async function invalidateAllViews() {
        await Promise.all([
            ...MODULE_REFRESH_KEYS.map((key) => invalidate(key)),
            invalidate("app:entities"),
            invalidate("app:entity-types"),
        ]);
    }

    async function loadFiles() {
        try {
            await logs.loadCached();
            files = logs.value;
            await logs.refresh();
            files = logs.value;
        } catch (error) {
            status = `Error loading logs: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    async function createNewLog() {
        const fileName = newFileName.trim();
        try {
            status = `Creating new log "${fileName}"...`;

            await createAndActivateLog(fileName);

            newFileName = "";
            files = logs.value;
            status = `Successfully created and selected "${fileName}".`;
        } catch (error) {
            status = `Error creating new log: ${error instanceof Error ? error.message : String(error)}`;
            syncStatus.hasError = true;
            syncStatus.errorMessage = "Failed to create log";
        }
    }

    async function onFileSelectionChange(event: Event) {
        const target = event.target as HTMLSelectElement;
        const selectedLogId = target.value;

        if (!selectedLogId) return;

        const selectedLog = files.find((log) => log.id === selectedLogId);
        if (!selectedLog) return;

        try {
            status = `Loading log "${selectedLog.name}"...`;
            await stopRealtime();
            await eventLogFilename.set(selectedLog.id, selectedLog.name);

            await loadStoredLogSnapshot(selectedLog.id, []);
            await runSyncCoordinator("manual");
            await invalidateAllViews();

            status = `Successfully loaded and applied "${selectedLog.name}".`;
        } catch (error) {
            status = `Error loading log: ${error instanceof Error ? error.message : String(error)}`;
            syncStatus.hasError = true;
            syncStatus.errorMessage = "Failed to load log";
        }
    }

    $effect(() => {
        loadFiles();
    });
</script>

<div class="stor-panel min-w-0 p-[var(--stor-panel-padding)]">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
            <h2 class="text-base font-semibold text-stone-900">
                Event logs
            </h2>
        </div>
        <div class="self-start rounded-full bg-[var(--stor-surface-muted)] px-3 py-1 text-xs font-semibold text-stone-600">
            {files.length} logs
        </div>
    </div>

    <div class="mt-4 space-y-3">
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
                <label
                    for="event-log-select"
                    class="mb-1.5 block text-xs font-semibold text-[var(--stor-muted-text)]"
                >
                    Active log
                </label>
                <div class="relative">
                    <select
                        id="event-log-select"
                        class="block w-full appearance-none rounded-lg border border-[var(--stor-field-border)] bg-white py-2.5 pl-3 pr-10 text-sm outline-none focus:border-[var(--stor-focus)] focus:ring-2 focus:ring-[var(--stor-selected)]"
                        onchange={onFileSelectionChange}
                        value={eventLogFilename.value}
                    >
                    {#if files.length === 0}
                            <option disabled>No logs found in Ledger Service</option>
                        {:else}
                            {#each files as log}
                                <option value={log.id}>{log.name}</option>
                            {/each}
                        {/if}
                    </select>
                    <div
                        class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-[var(--stor-muted-text)]"
                    >
                        <svg
                            class="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            ><path
                                d="M19 9l-7 7-7-7"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                            /></svg
                        >
                    </div>
                </div>
            </div>

            <div>
                <label
                    for="new-log-name"
                    class="mb-1.5 block text-xs font-semibold text-[var(--stor-muted-text)]"
                >
                    New log
                </label>
                <input
                    id="new-log-name"
                    type="text"
                    bind:value={newFileName}
                    placeholder="Log name..."
                    class="block w-full rounded-lg border border-[var(--stor-field-border)] px-3 py-2.5 text-sm outline-none focus:border-[var(--stor-focus)] focus:ring-2 focus:ring-[var(--stor-selected)]"
                />
            </div>
        </div>

        <div class="grid gap-2 sm:grid-cols-3">
            <button
                type="button"
                class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--stor-action)] px-4 text-sm font-semibold text-[var(--stor-action-text)] transition-colors hover:bg-[var(--stor-action-hover)] disabled:opacity-50 sm:min-h-9"
                onclick={createNewLog}
                disabled={!newFileName}
            >
                <IconPlus class="h-4 w-4" />
                Create
            </button>
            <button
                type="button"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--stor-surface-muted)] px-4 py-2.5 text-sm font-semibold text-stone-700 transition-colors hover:bg-stone-200"
                onclick={loadFiles}
            >
                <IconRefresh class="h-4 w-4" />
                Refresh
            </button>
            <button
                type="button"
                class="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
                onclick={() => {
                    const log = files.find(
                        (f) => f.id === eventLogFilename.value,
                    );
                    if (log) requestDeleteLog(log.id, log.name);
                }}
                disabled={!eventLogFilename.value}
            >
                <IconDeleteOutline class="h-4 w-4" />
                Delete
            </button>
        </div>

        {#if status}
            <div
                class="rounded-lg bg-[var(--stor-surface-muted)] p-3 text-sm text-stone-700"
            >
                {status}
            </div>
        {/if}
    </div>
</div>

<ConfirmDialog
    show={showDeleteConfirm}
    title="Delete Event Log"
    message={`Are you sure you want to delete "${logToDelete?.name}"? This action cannot be undone.`}
    onConfirm={confirmDeleteLog}
    onCancel={cancelDeleteLog}
/>
