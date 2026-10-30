<script lang="ts">
    import { page } from "$app/state";
    import { localStoreStatus } from "@hearthlog/runtime/store/local-store.svelte.js";
    import { onMount } from "svelte";
    import { buttonVariants } from "@hearthlog/ui/components/ui/button-variants.js";
    import type { LocalRecoverySummary } from "@hearthlog/runtime/recovery/local-recovery.js";

    type LocalRecoveryModule = typeof import("@hearthlog/runtime/recovery/local-recovery.js");
    let { error = null }: { error?: unknown } = $props();

    let recoverySummary = $state<LocalRecoverySummary>({ pending: null, blocked: null });
    let recoveryBusy = $state(false);
    let recoveryMessage = $state("");
    let confirmReset = $state(false);
    let isOffline = $state(false);
    let recoveryModulePromise: Promise<LocalRecoveryModule> | null = null;

    const localStoreFailed = $derived(localStoreStatus.phase === "failed");
    const offlinePageError = $derived(!localStoreFailed && isOffline);
    const title = $derived(
        localStoreFailed
            ? "Local data could not be opened"
            : offlinePageError
                ? "Could not open this page offline"
                : "stor could not open this page",
    );
    const description = $derived(
        localStoreFailed
            ? localStoreStatus.errorMessage ??
                  "The local database did not finish starting. Your Ledger data has not been changed."
            : offlinePageError
                ? "The offline app bundle or local data may be unavailable. Connect and retry."
                : error instanceof Error ? error.message : page.error?.message ?? "An unexpected error interrupted this page.",
    );

    function getRecoveryModule(): Promise<LocalRecoveryModule> {
        recoveryModulePromise ??= import("@hearthlog/runtime/recovery/local-recovery.js");
        return recoveryModulePromise;
    }

    async function retry(): Promise<void> {
        if (!localStoreFailed) {
            window.location.reload();
            return;
        }
        recoveryBusy = true;
        recoveryMessage = "Retrying the local migration…";
        try {
            const recovery = await getRecoveryModule();
            await recovery.retryLocalMigration();
            window.location.reload();
        } catch (error) {
            recoveryMessage = error instanceof Error ? error.message : "The migration still could not complete.";
            recoveryBusy = false;
        }
    }

    async function download(): Promise<void> {
        try {
            const recovery = await getRecoveryModule();
            await recovery.downloadLocalDatabase();
            recoveryMessage = "SQLite backup downloaded.";
        } catch (error) {
            recoveryMessage = error instanceof Error ? error.message : "SQLite could not be downloaded.";
        }
    }

    async function reset(): Promise<void> {
        if (!confirmReset) {
            confirmReset = true;
            return;
        }
        recoveryBusy = true;
        recoveryMessage = "Stopping synchronization and deleting local data…";
        try {
            const recovery = await getRecoveryModule();
            await recovery.resetLocalDataFromLedger();
        } catch (error) {
            recoveryMessage = error instanceof Error ? error.message : "Local data could not be reset.";
            recoveryBusy = false;
        }
    }

    onMount(() => {
        window.dispatchEvent(new CustomEvent("stor:app-mounted"));
        const updateOnlineState = () => (isOffline = !navigator.onLine);
        updateOnlineState();
        window.addEventListener("online", updateOnlineState);
        window.addEventListener("offline", updateOnlineState);
        return () => {
            window.removeEventListener("online", updateOnlineState);
            window.removeEventListener("offline", updateOnlineState);
        };
    });

    $effect(() => {
        if (!localStoreFailed) return;
        void getRecoveryModule()
            .then((recovery) => recovery.getLocalRecoverySummary())
            .then((summary) => (recoverySummary = summary));
    });
</script>

<svelte:head>
    <title>{title} | stor</title>
</svelte:head>

<main class="flex min-h-screen items-center justify-center bg-[var(--stor-bg)] px-4 py-12">
    <section class="stor-panel w-full max-w-lg p-6 sm:p-8">
        <p class="stor-overline">
            {localStoreFailed ? "Local store" : error ? "Workspace unavailable" : `Error ${page.status}`}
        </p>
        <h1 class="stor-title-2 mt-2 text-[var(--stor-ink)]">{title}</h1>
        <p class="mt-3 text-sm leading-6 text-[var(--stor-muted-text)]">{description}</p>
        <div class="mt-6 flex flex-wrap gap-2">
            <button
                type="button"
                class={buttonVariants({ variant: localStoreFailed ? "default" : "secondary" })}
                onclick={() => void retry()}
                disabled={recoveryBusy}
            >
                Retry
            </button>
            {#if !localStoreFailed}
                <a href="/" class={buttonVariants({ variant: "default" })}>
                    Go to start
                </a>
            {/if}
            {#if localStoreFailed}
                <button type="button" class={buttonVariants({ variant: "secondary" })} onclick={() => void download()} disabled={recoveryBusy}>Download SQLite</button>
                <button type="button" class={buttonVariants({ variant: "destructive" })} onclick={() => void reset()} disabled={recoveryBusy}>{confirmReset ? "Confirm reset" : "Reset from Ledger"}</button>
            {/if}
        </div>
        {#if localStoreFailed}
            <p class="mt-5 border-t border-[var(--stor-border)] pt-4 text-xs leading-5 text-[var(--stor-muted-text)]">
                {recoverySummary.pending ?? "Unknown"} pending events · {recoverySummary.blocked ?? "Unknown"} blocked operations. Reset removes them from this device; remote events return through normal sync after reload.
            </p>
            {#if recoveryMessage}<p class="mt-3 text-xs font-medium text-[var(--stor-ink)]">{recoveryMessage}</p>{/if}
        {/if}
    </section>
</main>
