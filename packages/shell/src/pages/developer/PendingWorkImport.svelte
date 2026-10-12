<script lang="ts">
    import Button from "@hearthlog/ui/components/ui/Button.svelte";
    import { importPendingWork } from "@hearthlog/runtime/store/pending-work-transfer.js";
    import { parsePendingWorkFile, type ImportReport } from "@hearthlog/runtime/store/pending-work.js";

    let busy = $state(false);
    let error = $state<string | null>(null);
    let report = $state<ImportReport | null>(null);
    let input = $state<HTMLInputElement | null>(null);

    async function run(): Promise<void> {
        const file = input?.files?.[0];
        if (!file) return;
        busy = true;
        error = null;
        report = null;
        try {
            report = await importPendingWork(parsePendingWorkFile(await file.text()));
        } catch (cause) {
            error = cause instanceof Error ? cause.message : "Could not read the file";
        } finally {
            busy = false;
        }
    }
</script>

<div class="mt-4 border-t border-[var(--stor-border)] pt-4">
    <h3 class="text-sm font-semibold text-[var(--stor-ink)]">Pending changes from a moved workspace</h3>
    <p class="mt-1 text-sm text-[var(--stor-muted-text)]">Send the changes a device exported before the move. Ones already accepted are recognized.</p>
    <div class="mt-3 flex flex-wrap items-center gap-2">
        <input bind:this={input} type="file" accept="application/json,.json" class="text-sm" disabled={busy} data-testid="pending-work-file" />
        <Button variant="secondary" onclick={run} disabled={busy}>{busy ? "Sending" : "Send changes"}</Button>
    </div>
    {#if error}
        <p class="mt-3 text-sm text-[var(--stor-negative)]" role="alert">{error}</p>
    {/if}
    {#if report}
        <div class="mt-3 text-sm" role="status">
            <p class="text-[var(--stor-ink)]">{report.applied} applied, {report.notApplied} not applied.</p>
            {#if report.notApplied > 0}
                <ul class="mt-1 list-disc pl-5 text-[var(--stor-muted-text)]">
                    {#each report.results.filter((result) => result.outcome !== "applied") as result (result.requestId)}
                        <li>{result.message}</li>
                    {/each}
                </ul>
            {/if}
        </div>
    {/if}
</div>
