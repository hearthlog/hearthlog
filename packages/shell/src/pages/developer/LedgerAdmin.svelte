<script lang="ts">
    const drawerId = $props.id();
    const drawerFormId0 = drawerId + "-0";

    import { onMount } from "svelte";
    import CommandConfirmDialog from "@hearthlog/ui/components/commands/CommandConfirmDialog.svelte";
    import CommandDrawer from "@hearthlog/ui/components/commands/CommandDrawer.svelte";
    import EmptyState from "@hearthlog/ui/components/EmptyState.svelte";
    import JsonViewer from "@hearthlog/ui/components/JsonViewer.svelte";
    import Button from "@hearthlog/ui/components/ui/Button.svelte";
    import {
        LedgerAdminClient,
        LedgerAdminError,
        LedgerAdminUnauthorizedError,
        type AdminApplicationExport,
        type AdminAppSummary,
        type AdminAppTokenResponse,
        type AdminLogSummary,
        type AdminSession,
    } from "@hearthlog/runtime/ledger/admin-client.js";
    import IconCheck from "~icons/mdi/check";
    import IconCodeJson from "~icons/mdi/code-json";
    import IconContentCopy from "~icons/mdi/content-copy";
    import IconDatabaseEye from "~icons/mdi/database-eye-outline";
    import IconKeyChange from "~icons/mdi/key-change";
    import IconPlus from "~icons/mdi/plus";
    import IconRefresh from "~icons/mdi/refresh";
    import IconServerSecurity from "~icons/mdi/server-security";
    import IconShieldLock from "~icons/mdi/shield-lock-outline";

    type ViewState =
        | "authorized"
        | "error"
        | "loading"
        | "unauthorized"
        | "unavailable";
    type PendingAction = {
        app: AdminAppSummary;
        kind: "revoke" | "rotate";
    };

    const client = new LedgerAdminClient();

    let viewState = $state<ViewState>("loading");
    let session = $state<AdminSession | null>(null);
    let apps = $state<AdminAppSummary[]>([]);
    let pageError = $state("");
    let refreshing = $state(false);
    let operationAppId = $state<string | null>(null);

    let drawerOpen = $state(false);
    let createName = $state("");
    let drawerError = $state("");
    let submitting = $state(false);
    let outcomeUnknown = $state(false);
    let tokenResult = $state<AdminAppTokenResponse | null>(null);
    let copied = $state(false);

    let pendingAction = $state<PendingAction | null>(null);

    let detailsOpen = $state(false);
    let detailsApp = $state<AdminAppSummary | null>(null);
    let detailsLogs = $state<AdminLogSummary[]>([]);
    let detailsLoading = $state(false);
    let detailsError = $state("");

    let exportOpen = $state(false);
    let exportApp = $state<AdminAppSummary | null>(null);
    let exportValue = $state<AdminApplicationExport | null>(null);
    let exportLoading = $state(false);
    let exportError = $state("");

    const activeApps = $derived(apps.filter((app) => app.revokedAt === null).length);
    const revokedApps = $derived(apps.length - activeApps);
    const drawerTitle = $derived(
        tokenResult ? "Save application token" : "Create Ledger application",
    );
    const drawerDescription = $derived(
        tokenResult
            ? "This token is returned once and cannot be recovered later."
            : "Provision an isolated Ledger application and its first credential.",
    );
    const confirmTitle = $derived(
        pendingAction?.kind === "rotate"
            ? "Rotate application token?"
            : "Revoke Ledger application?",
    );
    const confirmMessage = $derived(
        pendingAction?.kind === "rotate"
            ? `Rotate the token for ${pendingAction.app.name}? The current token will stop working immediately.`
            : pendingAction
              ? `Revoke ${pendingAction.app.name}? All of its active credentials and connections will stop working.`
              : "",
    );

    onMount(() => {
        void initialize();
        return () => {
            clearSensitiveState();
            clearExportState();
        };
    });

    async function initialize(): Promise<void> {
        viewState = "loading";
        pageError = "";
        session = null;
        apps = [];
        try {
            session = await client.getSession();
            apps = sortApps(await client.listApps());
            viewState = "authorized";
        } catch (error) {
            setViewError(error);
        }
    }

    async function refreshApps(): Promise<void> {
        if (refreshing) return;
        refreshing = true;
        pageError = "";
        try {
            apps = sortApps(await client.listApps());
        } catch (error) {
            setViewError(error);
        } finally {
            refreshing = false;
        }
    }

    function openCreateDrawer(): void {
        closeDetailsDrawer();
        closeExportViewer();
        clearSensitiveState();
        createName = "";
        drawerOpen = true;
    }

    function closeDrawer(): void {
        if (submitting) return;
        drawerOpen = false;
        clearSensitiveState();
        createName = "";
    }

    async function openDetailsDrawer(app: AdminAppSummary): Promise<void> {
        closeDrawer();
        closeExportViewer();
        detailsApp = app;
        detailsLogs = [];
        detailsError = "";
        detailsLoading = true;
        detailsOpen = true;
        try {
            detailsLogs = await client.listAppLogs(app.id);
        } catch (error) {
            if (error instanceof LedgerAdminUnauthorizedError) {
                closeDetailsDrawer();
                setViewError(error);
                return;
            }
            detailsError = errorMessage(error);
        } finally {
            detailsLoading = false;
        }
    }

    function closeDetailsDrawer(): void {
        detailsOpen = false;
        detailsApp = null;
        detailsLogs = [];
        detailsError = "";
        detailsLoading = false;
    }

    async function openExportViewer(app: AdminAppSummary): Promise<void> {
        closeDetailsDrawer();
        exportApp = app;
        exportOpen = true;
        await loadApplicationExport(app);
    }

    async function loadApplicationExport(app: AdminAppSummary): Promise<void> {
        exportValue = null;
        exportError = "";
        exportLoading = true;
        try {
            exportValue = await client.getAppExport(app.id);
        } catch (error) {
            if (error instanceof LedgerAdminUnauthorizedError) {
                closeExportViewer();
                setViewError(error);
                return;
            }
            exportError = errorMessage(error);
        } finally {
            exportLoading = false;
        }
    }

    function closeExportViewer(): void {
        exportOpen = false;
        clearExportState();
    }

    function clearExportState(): void {
        exportApp = null;
        exportValue = null;
        exportLoading = false;
        exportError = "";
    }

    function rotateFromDetails(app: AdminAppSummary): void {
        if (app.revokedAt !== null) return;
        closeDetailsDrawer();
        requestAction("rotate", app);
    }

    async function createApplication(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        const name = createName.trim();
        if (!name || submitting || outcomeUnknown) return;

        submitting = true;
        drawerError = "";
        try {
            const result = await client.createApp(name);
            upsertApp(result.app);
            showToken(result);
        } catch (error) {
            setDrawerError(error);
            if (error instanceof LedgerAdminError && error.outcomeUnknown) {
                await reconcileUnknownOutcome();
            }
        } finally {
            submitting = false;
        }
    }

    function requestAction(
        kind: PendingAction["kind"],
        app: AdminAppSummary,
    ): void {
        if (app.revokedAt !== null || operationAppId !== null) return;
        pendingAction = { app, kind };
    }

    async function executeAction(): Promise<void> {
        const action = pendingAction;
        pendingAction = null;
        if (!action || operationAppId !== null) return;

        operationAppId = action.app.id;
        pageError = "";
        try {
            if (action.kind === "rotate") {
                const result = await client.rotateAppToken(action.app.id);
                upsertApp(result.app);
                showToken(result);
            } else {
                upsertApp(await client.revokeApp(action.app.id));
            }
        } catch (error) {
            setOperationError(error);
            if (error instanceof LedgerAdminError && error.outcomeUnknown) {
                await reconcileUnknownOutcome();
            }
        } finally {
            operationAppId = null;
        }
    }

    function showToken(result: AdminAppTokenResponse): void {
        closeDetailsDrawer();
        clearSensitiveState();
        tokenResult = result;
        copied = false;
        drawerOpen = true;
    }

    async function copyToken(): Promise<void> {
        if (!tokenResult) return;
        try {
            await navigator.clipboard.writeText(tokenResult.token);
            copied = true;
            drawerError = "";
        } catch {
            drawerError = "Copy failed. Select and copy the token manually.";
        }
    }

    async function recoverUnknownOutcome(): Promise<void> {
        closeDrawer();
        await refreshApps();
    }

    async function reconcileUnknownOutcome(): Promise<void> {
        try {
            apps = sortApps(await client.listApps());
        } catch {
            // Keep the mutation warning visible. Refresh remains available for
            // another read-only reconciliation attempt.
        }
    }

    function upsertApp(app: AdminAppSummary): void {
        const next = apps.filter((current) => current.id !== app.id);
        next.push(app);
        apps = sortApps(next);
        if (detailsApp?.id === app.id) detailsApp = app;
    }

    function setViewError(error: unknown): void {
        drawerOpen = false;
        closeDetailsDrawer();
        closeExportViewer();
        pendingAction = null;
        clearSensitiveState();
        session = null;
        apps = [];
        if (error instanceof LedgerAdminUnauthorizedError) {
            viewState = "unauthorized";
            return;
        }
        if (
            error instanceof LedgerAdminError &&
            error.code === "ledger_admin_gateway_unconfigured"
        ) {
            viewState = "unavailable";
            return;
        }
        viewState = "error";
        pageError = errorMessage(error);
    }

    function setDrawerError(error: unknown): void {
        if (error instanceof LedgerAdminUnauthorizedError) {
            closeDrawer();
            setViewError(error);
            return;
        }
        drawerError = errorMessage(error);
        outcomeUnknown =
            error instanceof LedgerAdminError && error.outcomeUnknown;
    }

    function setOperationError(error: unknown): void {
        if (error instanceof LedgerAdminUnauthorizedError) {
            setViewError(error);
            return;
        }
        pageError = errorMessage(error);
        if (error instanceof LedgerAdminError && error.outcomeUnknown) {
            pageError += " Refresh the list before trying another action.";
        }
    }

    function clearSensitiveState(): void {
        tokenResult = null;
        copied = false;
        drawerError = "";
        outcomeUnknown = false;
    }

    function errorMessage(error: unknown): string {
        return error instanceof Error
            ? error.message
            : "Ledger administrator request failed.";
    }

    function sortApps(values: AdminAppSummary[]): AdminAppSummary[] {
        return [...values].sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt),
        );
    }

    function formatDate(value: string | null): string {
        if (!value) return "Never";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
        }).format(date);
    }

    function formatEventCount(value: number): string {
        return new Intl.NumberFormat().format(value);
    }

</script>

<section class="mt-4 lg:mt-6" data-testid="ledger-admin">
    {#if viewState === "loading"}
        <div class="stor-panel px-5 py-14 text-center">
            <div class="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[var(--stor-border)] border-t-[var(--stor-accent)]"></div>
            <p class="mt-4 text-sm font-medium text-stone-600">
                Checking Ledger administrator access…
            </p>
        </div>
    {:else if viewState === "unauthorized"}
        <EmptyState
            icon={IconShieldLock}
            title="You don’t have Ledger administrator access"
            description="Ledger application data and administrator actions are limited to the configured administrator."
        />
    {:else if viewState === "unavailable"}
        <EmptyState
            icon={IconServerSecurity}
            title="Ledger admin is not configured"
            description="The Access verifier or server-side Ledger administrator credential is missing."
        />
    {:else if viewState === "error"}
        <EmptyState
            icon={IconServerSecurity}
            title="Ledger admin could not be loaded"
            description={pageError}
        >
            <Button variant="secondary" onclick={initialize}>
                <IconRefresh class="h-4 w-4" />
                Try again
            </Button>
        </EmptyState>
    {:else}
        <div class="space-y-4">
            <div class="stor-panel p-[var(--stor-panel-padding)]">
                <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <div class="flex items-center gap-2">
                            <IconServerSecurity class="h-5 w-5 text-[var(--stor-accent-strong)]" />
                            <h2 class="text-lg font-semibold text-stone-950">
                                Ledger applications
                            </h2>
                        </div>
                        <p class="mt-1 text-sm text-[var(--stor-muted-text)]">
                            Signed in as <span class="font-medium text-stone-700">{session?.email}</span>
                        </p>
                    </div>
                    <div class="flex gap-2">
                        <Button
                            variant="secondary"
                            size="sm"
                            onclick={refreshApps}
                            disabled={refreshing || operationAppId !== null}
                        >
                            <IconRefresh class="h-4 w-4 {refreshing ? 'animate-spin' : ''}" />
                            Refresh
                        </Button>
                        <Button
                            size="sm"
                            onclick={openCreateDrawer}
                            disabled={operationAppId !== null}
                        >
                            <IconPlus class="h-4 w-4" />
                            Create Ledger app
                        </Button>
                    </div>
                </div>

                <div class="mt-4 grid grid-cols-3 gap-2">
                    <div class="rounded-xl bg-[var(--stor-surface-muted)] px-3 py-2.5">
                        <p class="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">Total</p>
                        <p class="mt-1 text-lg font-semibold text-stone-900">{apps.length}</p>
                    </div>
                    <div class="rounded-xl bg-emerald-50 px-3 py-2.5">
                        <p class="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-emerald-600">Active</p>
                        <p class="mt-1 text-lg font-semibold text-emerald-900">{activeApps}</p>
                    </div>
                    <div class="rounded-xl bg-[var(--stor-surface-muted)] px-3 py-2.5">
                        <p class="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">Revoked</p>
                        <p class="mt-1 text-lg font-semibold text-stone-800">{revokedApps}</p>
                    </div>
                </div>
            </div>

            {#if pageError}
                <div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
                    {pageError}
                </div>
            {/if}

            {#if apps.length === 0}
                <EmptyState
                    icon={IconServerSecurity}
                    title="No Ledger applications"
                    description="Create the first application to receive its initial token."
                >
                    <Button onclick={openCreateDrawer}>
                        <IconPlus class="h-4 w-4" />
                        Create Ledger app
                    </Button>
                </EmptyState>
            {:else}
                <div class="stor-panel hidden overflow-hidden md:block" data-testid="ledger-admin-table">
                    <div class="overflow-x-auto">
                        <table class="w-full min-w-[58rem] text-left text-sm">
                            <thead class="border-b border-[var(--stor-border)] bg-[var(--stor-surface-muted)] text-xs uppercase tracking-[0.08em] text-[var(--stor-muted-text)]">
                                <tr>
                                    <th class="px-4 py-3 font-semibold">Application</th>
                                    <th class="px-4 py-3 font-semibold">Status</th>
                                    <th class="px-4 py-3 font-semibold">Created</th>
                                    <th class="px-4 py-3 font-semibold">Token issued</th>
                                    <th class="px-4 py-3 text-right font-semibold">Actions</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-stone-100">
                                {#each apps as app (app.id)}
                                    <tr>
                                        <td class="px-4 py-3">
                                            <p class="font-semibold text-stone-900">{app.name}</p>
                                            <code class="mt-0.5 block max-w-64 truncate text-xs text-[var(--stor-muted-text)]" title={app.id}>{app.id}</code>
                                        </td>
                                        <td class="px-4 py-3">
                                            <span class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold {app.revokedAt ? 'bg-[var(--stor-surface-muted)] text-stone-600' : 'bg-emerald-50 text-emerald-700'}">
                                                {app.revokedAt ? "Revoked" : "Active"}
                                            </span>
                                        </td>
                                        <td class="whitespace-nowrap px-4 py-3 text-stone-600">{formatDate(app.createdAt)}</td>
                                        <td class="whitespace-nowrap px-4 py-3 text-stone-600">{formatDate(app.activeTokenCreatedAt)}</td>
                                        <td class="px-4 py-3">
                                            <div class="flex justify-end gap-2">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    aria-label={`View logs and data for ${app.name}`}
                                                    onclick={() => void openDetailsDrawer(app)}
                                                    disabled={operationAppId !== null}
                                                >
                                                    <IconDatabaseEye class="h-4 w-4" />
                                                    View
                                                </Button>
                                                <Button
                                                    variant="secondary"
                                                    size="sm"
                                                    aria-label={`Rotate token for ${app.name}`}
                                                    onclick={() => requestAction("rotate", app)}
                                                    disabled={app.revokedAt !== null || operationAppId !== null}
                                                >
                                                    <IconKeyChange class="h-4 w-4" />
                                                    Rotate
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    class="text-red-700 hover:bg-red-50 hover:text-red-800"
                                                    aria-label={`Revoke ${app.name}`}
                                                    onclick={() => requestAction("revoke", app)}
                                                    disabled={app.revokedAt !== null || operationAppId !== null}
                                                >
                                                    Revoke
                                                </Button>
                                            </div>
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div class="space-y-3 md:hidden" data-testid="ledger-admin-cards">
                    {#each apps as app (app.id)}
                        <article class="stor-panel p-4">
                            <div class="flex items-start justify-between gap-3">
                                <div class="min-w-0">
                                    <h3 class="truncate font-semibold text-stone-900">{app.name}</h3>
                                    <code class="mt-1 block truncate text-xs text-[var(--stor-muted-text)]">{app.id}</code>
                                </div>
                                <span class="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold {app.revokedAt ? 'bg-[var(--stor-surface-muted)] text-stone-600' : 'bg-emerald-50 text-emerald-700'}">
                                    {app.revokedAt ? "Revoked" : "Active"}
                                </span>
                            </div>
                            <dl class="mt-4 grid grid-cols-2 gap-3 text-xs">
                                <div>
                                    <dt class="text-[var(--stor-muted-text)]">Created</dt>
                                    <dd class="mt-1 font-medium text-stone-700">{formatDate(app.createdAt)}</dd>
                                </div>
                                <div>
                                    <dt class="text-[var(--stor-muted-text)]">Token issued</dt>
                                    <dd class="mt-1 font-medium text-stone-700">{formatDate(app.activeTokenCreatedAt)}</dd>
                                </div>
                            </dl>
                            <div class="mt-4 grid grid-cols-2 gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    class="col-span-2"
                                    aria-label={`View logs and data for ${app.name}`}
                                    onclick={() => void openDetailsDrawer(app)}
                                    disabled={operationAppId !== null}
                                >
                                    <IconDatabaseEye class="h-4 w-4" />
                                    View logs and data
                                </Button>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    aria-label={`Rotate token for ${app.name}`}
                                    onclick={() => requestAction("rotate", app)}
                                    disabled={app.revokedAt !== null || operationAppId !== null}
                                >
                                    <IconKeyChange class="h-4 w-4" />
                                    Rotate
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    class="text-red-700 hover:bg-red-50 hover:text-red-800"
                                    aria-label={`Revoke ${app.name}`}
                                    onclick={() => requestAction("revoke", app)}
                                    disabled={app.revokedAt !== null || operationAppId !== null}
                                >
                                    Revoke
                                </Button>
                            </div>
                        </article>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}
</section>

<CommandDrawer
    show={drawerOpen}
    title={drawerTitle}
    description={drawerDescription}
    onClose={closeDrawer}
>
    {#if tokenResult}
        <div class="space-y-5">
            <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                Save the token for <strong>{tokenResult.app.name}</strong> now. Closing this drawer permanently removes it from the UI.
            </div>
            <div>
                <label for="ledger-one-time-token" class="text-sm font-semibold text-stone-700">
                    One-time application token
                </label>
                <textarea
                    id="ledger-one-time-token"
                    data-testid="ledger-one-time-token"
                    readonly
                    rows="7"
                    value={tokenResult.token}
                    class="mt-2 w-full resize-none rounded-xl border border-[var(--stor-field-border)] bg-white p-3 font-mono text-xs leading-5 text-stone-800 outline-none"
                ></textarea>
            </div>
            {#if drawerError}
                <p class="text-sm text-red-700" role="alert">{drawerError}</p>
            {/if}
            <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="secondary" onclick={closeDrawer}>Done</Button>
                <Button onclick={copyToken}>
                    {#if copied}
                        <IconCheck class="h-4 w-4" />
                        Copied
                    {:else}
                        <IconContentCopy class="h-4 w-4" />
                        Copy token
                    {/if}
                </Button>
            </div>
        </div>
    {:else}
        <form id={drawerFormId0} class="space-y-5" onsubmit={createApplication}>
            <div>
                <label for="ledger-app-name" class="text-sm font-semibold text-stone-700">
                    Application name
                </label>
                <input
                    id="ledger-app-name"
                    name="name"
                    type="text"
                    autocomplete="off"
                    bind:value={createName}
                    disabled={submitting || outcomeUnknown}
                    placeholder="e.g. reporting"
                    class="mt-2 h-11 w-full rounded-xl border border-[var(--stor-field-border)] bg-white px-3 text-sm outline-none focus:border-[var(--stor-accent)] focus:ring-2 focus:ring-[var(--stor-accent-soft)] disabled:bg-[var(--stor-surface-muted)]"
                />
            </div>
            {#if drawerError}
                <div class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
                    {drawerError}
                </div>
            {/if}
            </form>

    {/if}
{#snippet footer()}
        {#if !tokenResult}
                <Button
                    variant="secondary"
                    type="button"
                    onclick={outcomeUnknown ? recoverUnknownOutcome : closeDrawer}
                    disabled={submitting}
                >
                    {outcomeUnknown ? "Close and refresh" : "Cancel"}
                </Button>
                {#if !outcomeUnknown}
                    <Button type="submit" form={drawerFormId0} disabled={!createName.trim() || submitting}>
                        <IconPlus class="h-4 w-4" />
                        {submitting ? "Creating…" : "Create app"}
                    </Button>
                {/if}

            {/if}
    {/snippet}
</CommandDrawer>

<CommandDrawer
    show={detailsOpen}
    title={detailsApp ? `${detailsApp.name} data` : "Application data"}
    description="Inspect Ledger logs, credential status, and the complete logical dataset."
    size="lg"
    onClose={closeDetailsDrawer}
>
    {#if detailsApp}
        <div class="space-y-5" data-testid="ledger-app-details">
            <div class="rounded-xl bg-[var(--stor-surface-muted)] p-4">
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                        <p class="font-semibold text-stone-900">{detailsApp.name}</p>
                        <code class="mt-1 block break-all text-xs text-[var(--stor-muted-text)]">{detailsApp.id}</code>
                    </div>
                    <span class="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold {detailsApp.revokedAt ? 'bg-stone-200 text-stone-600' : 'bg-emerald-100 text-emerald-700'}">
                        {detailsApp.revokedAt ? "Revoked" : "Active"}
                    </span>
                </div>
                <dl class="mt-4 grid grid-cols-2 gap-3 text-xs">
                    <div>
                        <dt class="text-[var(--stor-muted-text)]">Created</dt>
                        <dd class="mt-1 font-medium text-stone-700">{formatDate(detailsApp.createdAt)}</dd>
                    </div>
                    <div>
                        <dt class="text-[var(--stor-muted-text)]">Key issued</dt>
                        <dd class="mt-1 font-medium text-stone-700">{formatDate(detailsApp.activeTokenCreatedAt)}</dd>
                    </div>
                </dl>
            </div>

            <div class="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p class="text-sm font-semibold text-amber-950">Application key</p>
                <div class="mt-2 rounded-lg border border-amber-200 bg-white px-3 py-2 font-mono text-sm tracking-[0.1em] text-[var(--stor-muted-text)]">
                    ••••••••••••••••
                </div>
                <p class="mt-2 text-xs leading-5 text-amber-900">
                    Ledger shows a key only once when it is created or rotated. The current key cannot be recovered from this workspace.
                </p>
                {#if detailsApp.revokedAt === null}
                    <Button
                        variant="secondary"
                        size="sm"
                        class="mt-3"
                        onclick={() => rotateFromDetails(detailsApp!)}
                    >
                        <IconKeyChange class="h-4 w-4" />
                        Rotate and reveal new key
                    </Button>
                {/if}
            </div>

            <div>
                <div class="flex items-center justify-between gap-3">
                    <div>
                        <h3 class="font-semibold text-stone-900">Logs</h3>
                        <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
                            {detailsLoading ? "Loading…" : `${detailsLogs.length} ${detailsLogs.length === 1 ? "log" : "logs"}`}
                        </p>
                    </div>
                    <Button
                        size="sm"
                        onclick={() => void openExportViewer(detailsApp!)}
                        aria-label={`View JSON export for ${detailsApp.name}`}
                    >
                        <IconCodeJson class="h-4 w-4" />
                        View JSON export
                    </Button>
                </div>

                {#if detailsLoading}
                    <div class="mt-3 rounded-xl bg-[var(--stor-surface-muted)] px-4 py-8 text-center text-sm text-[var(--stor-muted-text)]">
                        Loading application logs…
                    </div>
                {:else if detailsError}
                    <div class="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
                        {detailsError}
                    </div>
                {:else if detailsLogs.length === 0}
                    <div class="mt-3 rounded-xl border border-dashed border-[var(--stor-field-border)] px-4 py-8 text-center text-sm text-[var(--stor-muted-text)]">
                        This application has no logs.
                    </div>
                {:else}
                    <div class="mt-3 space-y-2" data-testid="ledger-app-logs">
                        {#each detailsLogs as log (log.id)}
                            <article class="stor-panel p-3">
                                <div class="flex items-start justify-between gap-3">
                                    <div class="min-w-0">
                                        <p class="truncate text-sm font-semibold text-stone-900">{log.name}</p>
                                        <code class="mt-1 block break-all text-[11px] text-[var(--stor-muted-text)]">{log.id}</code>
                                    </div>
                                    <span class="shrink-0 rounded-lg bg-[var(--stor-surface-muted)] px-2 py-1 text-xs font-semibold text-stone-700">
                                        {formatEventCount(log.headVersion)} {log.headVersion === 1 ? "event" : "events"}
                                    </span>
                                </div>
                                <dl class="mt-3 grid grid-cols-2 gap-3 text-xs">
                                    <div>
                                        <dt class="text-[var(--stor-muted-text)]">Created</dt>
                                        <dd class="mt-1 text-stone-700">{formatDate(log.createdAt)}</dd>
                                    </div>
                                    <div>
                                        <dt class="text-[var(--stor-muted-text)]">Last updated</dt>
                                        <dd class="mt-1 text-stone-700">{formatDate(log.lastUpdatedAt)}</dd>
                                    </div>
                                </dl>
                            </article>
                        {/each}
                    </div>
                {/if}
            </div>
        </div>
    {/if}
</CommandDrawer>

<CommandDrawer
    show={exportOpen}
    title={exportApp ? `${exportApp.name} export` : "Ledger export"}
    description="Read-only logical snapshot of the application, its logs, and every exported event."
    size="lg"
    onClose={closeExportViewer}
>
    <div data-testid="ledger-export-viewer">
        {#if exportLoading}
            <div class="rounded-xl bg-[var(--stor-surface-muted)] px-4 py-12 text-center">
                <div class="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-[var(--stor-border)] border-t-[var(--stor-accent)]"></div>
                <p class="mt-3 text-sm font-medium text-stone-600">
                    Preparing JSON export…
                </p>
            </div>
        {:else if exportError}
            <div class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
                <p>{exportError}</p>
                {#if exportApp}
                    <Button
                        variant="secondary"
                        size="sm"
                        class="mt-3"
                        onclick={() => void loadApplicationExport(exportApp!)}
                    >
                        <IconRefresh class="h-4 w-4" />
                        Try again
                    </Button>
                {/if}
            </div>
        {:else if exportValue}
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--stor-muted-text)]">
                <span>
                    {exportValue.logs.length}
                    {exportValue.logs.length === 1 ? "log" : "logs"}
                </span>
                <span>Exported {formatDate(exportValue.exportedAt)}</span>
            </div>
            <JsonViewer
                value={exportValue}
                label={`${exportValue.application.name} Ledger export JSON`}
                maxHeight="calc(100dvh - 15rem)"
            />
        {/if}
    </div>
</CommandDrawer>

<CommandConfirmDialog
    show={pendingAction !== null}
    title={confirmTitle}
    message={confirmMessage}
    onConfirm={executeAction}
    onCancel={() => (pendingAction = null)}
/>
