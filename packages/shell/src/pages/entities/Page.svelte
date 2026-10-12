<script lang="ts">
    import { providePageResource } from "@hearthlog/runtime/runtime/page-data.svelte.js";
    import PageDataStatus from "@hearthlog/shell/components/layout/PageDataStatus.svelte";
    import DataPlaceholder from "@hearthlog/ui/components/data/DataPlaceholder.svelte";
    import DataValue from "@hearthlog/ui/components/data/DataValue.svelte";
    import {
        executeLocalCommand,
        type LocalCommandResult,
    } from "@hearthlog/runtime/commands/index.js";

    import { refreshPageData as invalidate } from "@hearthlog/runtime/runtime/refresh.js";
    import type { EntityTypeRecord } from "@hearthlog/runtime/db/dynamic-ddl.js";


    interface EntityTypeWithStatic extends EntityTypeRecord {
        is_static?: boolean;
    }
    import { generateExportSnippet } from "@hearthlog/runtime/event/code-export.js";
    import type { DynamicFieldDefinition } from "@hearthlog/runtime/event/meta-entity-types.js";
    import { fade, fly } from "svelte/transition";
    import { onMount } from "svelte";
    import CommandConfirmDialog from "@hearthlog/ui/components/commands/CommandConfirmDialog.svelte";
    import CommandDrawer from "@hearthlog/ui/components/commands/CommandDrawer.svelte";
    import CalendarSourceFields from "@hearthlog/shell/components/entities/CalendarSourceFields.svelte";
    import { parseCalendarConfig } from "@hearthlog/contracts/calendar/config";
    import {
        calendarDraftError,
        calendarFromDraft,
        draftFromCalendar,
        emptyCalendarDraft,
        type CalendarSourceDraft,
    } from "@hearthlog/runtime/calendar/draft.js";
    import CommandOnly from "@hearthlog/ui/components/commands/CommandOnly.svelte";
    import Modal from "@hearthlog/ui/components/Modal.svelte";
    import EmptyState from "@hearthlog/ui/components/EmptyState.svelte";
    import PageHeader from "@hearthlog/ui/components/PageHeader.svelte";
    import Button from "@hearthlog/ui/components/ui/Button.svelte";
    import Input from "@hearthlog/ui/components/ui/Input.svelte";
    import Checkbox from "@hearthlog/ui/components/ui/Checkbox.svelte";
    import { notify } from "@hearthlog/ui/state/notifications.svelte.js";
    import { contextualHref } from "@hearthlog/runtime/runtime/view.js";
import { tenant } from "@hearthlog/contracts/tenant/config";
import IconSearch from "~icons/mdi/magnify";
import IconPlus from "~icons/mdi/plus";
import IconPencil from "~icons/mdi/pencil-outline";
import IconCode from "~icons/mdi/code-tags";
import IconTrash from "~icons/mdi/trash-can-outline";
import IconArrowRight from "~icons/mdi/arrow-right";

    let { data: routeData } = $props();
    const resource = $derived(routeData.pageResource);
    const data = $derived(resource.data);
    providePageResource(() => resource);
    let entityTypes = $derived(data.entityTypes as EntityTypeWithStatic[]);
    const entityHref = (name: string) => contextualHref(`/entities/${name}`);

    function safeParse(json: string, name: string): any[] {
        try {
            return JSON.parse(json);
        } catch (e) {
            console.error(`[Entities] Failed to parse fields for ${name}:`, e);
            return [];
        }
    }

    onMount(() => {
        // console.log("[Entities] onMount");
        // return () => console.log("[Entities] onDestroy");
    });

    // Filter and Search
    let searchQuery = $state("");
    let filteredEntityTypes = $derived(
        entityTypes.filter(
            (et: EntityTypeRecord) =>
                et.display_name
                    .toLowerCase()
                    .includes(searchQuery.toLowerCase()) ||
                et.name.toLowerCase().includes(searchQuery.toLowerCase()),
        ),
    );

    // Form state
    let isCreating = $state(false);
    let newName = $state("");
    let newDisplayName = $state("");
    let newFields = $state<DynamicFieldDefinition[]>([]);
    let calendarDraft = $state<CalendarSourceDraft>(emptyCalendarDraft());
    const calendarDraftInvalid = $derived(
        calendarDraft.enabled &&
            calendarDraftError(calendarDraft, newFields) !== null,
    );

    // Export modal state
    let showExportModal = $state(false);
    let exportCode = $state("");

    // Confirmation dialog states
    let showArchiveConfirm = $state(false);
    let itemToArchive = $state<EntityTypeRecord | null>(null);
    let showRedefineConfirm = $state(false);

    // Field being edited
    let editingFieldIndex = $state<number | null>(null);
    let editingField = $state<DynamicFieldDefinition>({
        name: "",
        type: "string",
        payloadKey: "",
    });

    function resetForm() {
        newName = "";
        newDisplayName = "";
        newFields = [];
        calendarDraft = emptyCalendarDraft();
        isCreating = false;
        editingFieldIndex = null;
    }

    function addField() {
        if (!editingField.name) return;

        const payloadKey =
            editingField.payloadKey || toCamelCase(editingField.name);

        const field: DynamicFieldDefinition = {
            ...editingField,
            name: toSnakeCase(editingField.name),
            payloadKey,
        };

        if (editingFieldIndex !== null) {
            newFields[editingFieldIndex] = field;
        } else {
            newFields = [...newFields, field];
        }

        editingField = { name: "", type: "string", payloadKey: "" };
        editingFieldIndex = null;
    }

    function removeField(index: number) {
        newFields = newFields.filter((_, i) => i !== index);
    }

    function editField(index: number) {
        editingFieldIndex = index;
        editingField = { ...newFields[index] };
    }

    function toSnakeCase(str: string): string {
        return str
            .toLowerCase()
            .replace(/\s+/g, "_")
            .replace(/[^a-z0-9_]/g, "");
    }

    function toCamelCase(str: string): string {
        return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    }

    function reportProjectionState(result: LocalCommandResult): void {
        if (result.projectionPending) {
            notify.info(
                "Definition saved locally. Its database projection will retry on startup.",
            );
        }
    }

    async function handleCreate() {
        if (!newName.trim() || newFields.length === 0) return;
        if (calendarDraftInvalid) return;

        const name = toSnakeCase(newName);
        const tableName = name + "s";
        const calendar = calendarFromDraft(calendarDraft);

        const result = await executeLocalCommand({
            id: crypto.randomUUID(),
            type: "ENTITY_TYPE_DEFINED",
            timestamp: Date.now(),
            payload: {
                id: crypto.randomUUID(),
                name,
                displayName: newDisplayName || newName,
                tableName,
                fields: newFields,
                ...(calendar.length > 0 ? { calendar } : {}),
            },
        } as any);
        reportProjectionState(result);

        await invalidate("app:entity-types");
        resetForm();
    }

    async function handleArchive(entityType: EntityTypeRecord) {
        itemToArchive = entityType;
        showArchiveConfirm = true;
    }

    async function executeArchive() {
        if (!itemToArchive) return;
        const entityType = itemToArchive;
        showArchiveConfirm = false;
        itemToArchive = null;

        const result = await executeLocalCommand({
            id: crypto.randomUUID(),
            type: "ENTITY_TYPE_ARCHIVED",
            timestamp: Date.now(),
            payload: {
                id: entityType.id,
            },
        } as any);
        reportProjectionState(result);

        await invalidate("app:entity-types");
    }

    function handleExport(entityType: EntityTypeRecord) {
        exportCode = generateExportSnippet(entityType);
        showExportModal = true;
    }

    async function copyToClipboard() {
        await navigator.clipboard.writeText(exportCode);
        notify.success("Entity definition copied");
    }

    // ============================================================================
    // Edit Mode - Destructive Redesign
    // ============================================================================

    let isEditing = $state<EntityTypeRecord | null>(null);

    function startEdit(entityType: EntityTypeRecord) {
        isEditing = entityType;
        newName = entityType.name;
        newDisplayName = entityType.display_name;
        newFields = safeParse(entityType.fields_json, entityType.name);
        calendarDraft = draftFromCalendar(
            parseCalendarConfig(entityType.calendar_json),
        );
        editingFieldIndex = null;
        editingField = { name: "", type: "string", payloadKey: "" };
    }

    function cancelEdit() {
        isEditing = null;
        resetForm();
    }

    async function handleRedefinition() {
        if (!isEditing) return;
        showRedefineConfirm = true;
    }

    async function executeRedefinition() {
        if (!isEditing) return;
        showRedefineConfirm = false;
        if (calendarDraftInvalid) return;

        // Archive and replace the definition as one durable local command.
        const name = toSnakeCase(newName);
        const tableName = name + "s";
        const timestamp = Date.now();
        const calendar = calendarFromDraft(calendarDraft);
        const result = await executeLocalCommand([
            {
                id: crypto.randomUUID(),
                type: "ENTITY_TYPE_ARCHIVED",
                timestamp,
                payload: { id: isEditing.id },
            },
            {
                id: crypto.randomUUID(),
                type: "ENTITY_TYPE_DEFINED",
                timestamp: timestamp + 1,
                payload: {
                    id: crypto.randomUUID(),
                    name,
                    displayName: newDisplayName || newName,
                    tableName,
                    fields: newFields,
                    ...(calendar.length > 0 ? { calendar } : {}),
                },
            },
        ] as any);
        reportProjectionState(result);

        await invalidate("app:entity-types");

        isEditing = null;
        resetForm();
    }
</script>

<svelte:head>
    <title>Entity Types | stor</title>
</svelte:head>

<PageDataStatus {resource} />


<div class="flex h-full flex-col overflow-hidden bg-[var(--stor-bg)]">
    <!-- Header Area -->
    {#snippet entityDescription()}
        <DataValue>{filteredEntityTypes.length}</DataValue>
        <DataValue>{filteredEntityTypes.length === 1 ? ' collection' : ' collections'}</DataValue>
        {#if searchQuery.trim()}<span aria-hidden="true"> · </span>matching “{searchQuery.trim()}”{/if}
    {/snippet}
    <PageHeader title="Entities" class="shrink-0 px-3 pt-4 pb-2" context={entityDescription}>
        <label class="relative min-w-0">
            <span class="sr-only">Search types</span>
            <IconSearch class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--stor-muted-text)]" />
            <Input placeholder="Search types…" bind:value={searchQuery} class="pl-9 md:w-64" />
        </label>
        <CommandOnly>
            {#if tenant.dynamicEntities}
                <Button onclick={() => (isCreating = true)}><IconPlus class="h-4 w-4" /> New type</Button>
            {/if}
        </CommandOnly>
    </PageHeader>

    <!-- Main Content Grid -->
    <div class="flex-1 overflow-y-auto p-3">
        <div class="w-full">
            {#if resource.loading}
                <DataPlaceholder rows={5} />
            {:else if filteredEntityTypes.length === 0}
                <div in:fade>
                    <EmptyState
                        title="No entity types found"
                        description="Create a custom data structure to start storing specialized records."
                    >
                        <CommandOnly>
                            {#if tenant.dynamicEntities}<Button onclick={() => (isCreating = true)}>Create entity type</Button>{/if}
                        </CommandOnly>
                    </EmptyState>
                </div>
            {:else}
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {#each filteredEntityTypes as entityType (entityType.id)}
                        {@const fields = safeParse(
                            entityType.fields_json,
                            entityType.name,
                        )}
                        <article class="stor-panel group flex flex-col p-[var(--stor-panel-padding)] transition-shadow hover:shadow-[var(--stor-shadow-md)]">
                            <div class="flex items-start justify-between gap-3">
                                <div class="min-w-0">
                                    <a
                                        href={entityHref(entityType.name)}
                                        class="block truncate text-base font-semibold text-[var(--stor-ink)] transition-colors hover:text-[var(--stor-accent-strong)]"
                                    >
                                        {entityType.display_name}
                                    </a>
                                    <p class="mt-0.5 truncate font-mono text-[11px] uppercase tracking-wider text-[var(--stor-muted-text)]">
                                        {entityType.name}
                                    </p>
                                </div>
                                <span class="shrink-0 rounded-full bg-[var(--stor-surface-muted)] px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--stor-muted-text)]">
                                    {fields.length} {fields.length === 1 ? "field" : "fields"}
                                </span>
                            </div>

                            <ul class="mt-3 flex flex-wrap gap-1.5">
                                {#each fields.slice(0, 3) as field}
                                    <li class="inline-flex items-center gap-1.5 rounded-lg py-1 pr-2 text-xs">
                                        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--stor-accent)]"></span>
                                        <span class="font-medium text-[var(--stor-ink)]">{field.name}</span>
                                        <span class="font-mono text-[10.5px] text-[var(--stor-muted-text)]">{field.type}</span>
                                    </li>
                                {/each}
                                {#if fields.length > 3}
                                    <li class="inline-flex items-center rounded-lg px-2 py-1 text-xs font-medium text-[var(--stor-muted-text)]">
                                        +{fields.length - 3} more
                                    </li>
                                {/if}
                            </ul>

                            <div class="mt-4 flex items-center justify-between gap-2 border-t border-[var(--stor-border)] pt-3">
                                <a
                                    href={entityHref(entityType.name)}
                                    class="group/link inline-flex items-center gap-1 text-sm font-semibold text-[var(--stor-accent-strong)] transition hover:text-[var(--stor-accent)]"
                                >
                                    Open records
                                    <IconArrowRight class="h-4 w-4 transition-transform group-hover/link:translate-x-0.5" />
                                </a>
                                {#if !entityType.is_static}
                                    <div class="flex items-center gap-0.5">
                                        <CommandOnly>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onclick={() => startEdit(entityType)}
                                                title="Edit schema"
                                                aria-label={`Edit ${entityType.display_name} schema`}
                                            >
                                                <IconPencil class="h-4 w-4" />
                                            </Button>
                                        </CommandOnly>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onclick={() => handleExport(entityType)}
                                            title="Export code"
                                            aria-label={`Export ${entityType.display_name} code`}
                                        >
                                            <IconCode class="h-4 w-4" />
                                        </Button>
                                        <CommandOnly>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onclick={() => handleArchive(entityType)}
                                                class="hover:bg-[var(--stor-negative-soft)] hover:text-[var(--stor-negative)]"
                                                title="Archive"
                                                aria-label={`Archive ${entityType.display_name}`}
                                            >
                                                <IconTrash class="h-4 w-4" />
                                            </Button>
                                        </CommandOnly>
                                    </div>
                                {:else}
                                    <span class="select-none rounded-full bg-[var(--stor-surface-muted)] px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--stor-muted-text)]">
                                        Built-in
                                    </span>
                                {/if}
                            </div>
                        </article>
                    {/each}
                </div>
            {/if}
        </div>
    </div>
</div>

<CommandDrawer
    show={isCreating}
    size="lg"
    title="Define new entity"
    description="Create a reusable schema for a new kind of record."
    onClose={resetForm}
>
    <div class="space-y-8">
        <!-- Basic Info -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="space-y-1.5">
                <label class="text-sm font-semibold text-[var(--stor-ink)] ml-1"
                    >Entity ID (e.g. task)</label
                >
                <input
                    type="text"
                    placeholder="snake_case_name"
                    bind:value={newName}
                    class="stor-native-field"
                />
            </div>
            <div class="space-y-1.5">
                <label class="text-sm font-semibold text-[var(--stor-ink)] ml-1"
                    >Display Name (e.g. Task)</label
                >
                <input
                    type="text"
                    placeholder="Pretty Name"
                    bind:value={newDisplayName}
                    class="stor-native-field"
                />
            </div>
        </div>

        <!-- Fields Management -->
        <div class="space-y-4">
            <div class="flex items-center justify-between">
                <h3 class="text-base font-semibold text-[var(--stor-ink)]">
                    Fields Configuration
                </h3>
                <span
                    class="text-xs bg-[var(--stor-surface-muted)] text-[var(--stor-muted-text)] px-3 py-1 rounded-full font-semibold uppercase tracking-wide"
                >
                    {newFields.length} total fields
                </span>
            </div>

            <div
                class="space-y-3 rounded-xl bg-[var(--stor-surface-muted)] p-4"
            >
                <!-- Field Form -->
                <div class="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                    <div class="md:col-span-3 space-y-1">
                        <label
                            class="text-[10.5px] font-bold text-[var(--stor-muted-text)] uppercase ml-1"
                            >Field Name</label
                        >
                        <input
                            type="text"
                            placeholder="title"
                            bind:value={editingField.name}
                            class="stor-native-field"
                        />
                    </div>
                    <div class="md:col-span-2 space-y-1">
                        <label
                            class="text-[10.5px] font-bold text-[var(--stor-muted-text)] uppercase ml-1"
                            >Type</label
                        >
                        <select
                            bind:value={editingField.type}
                            class="stor-native-field"
                        >
                            <option value="string">String</option>
                            <option value="number">Number</option>
                            <option value="boolean">Boolean</option>
                            <option value="datetime">Datetime</option>
                            <option value="reference">Reference</option>
                        </select>
                    </div>
                    {#if editingField.type === "reference"}
                        <div class="md:col-span-3 space-y-1">
                            <label
                                class="text-[10.5px] font-bold text-[var(--stor-muted-text)] uppercase ml-1"
                                >References</label
                            >
                            <select
                                bind:value={editingField.referenceTo}
                                class="stor-native-field"
                            >
                                <option value="">Select entity...</option>
                                {#each entityTypes as et}
                                    <option value={et.name}
                                        >{et.display_name}</option
                                    >
                                {/each}
                            </select>
                        </div>
                        <div class="md:col-span-2 space-y-1">
                            <label
                                class="text-[10.5px] font-bold text-[var(--stor-muted-text)] uppercase ml-1"
                                >Default</label
                            >
                            <input
                                type="text"
                                placeholder="optional"
                                bind:value={editingField.default}
                                class="stor-native-field"
                            />
                        </div>
                    {:else if editingField.type === "datetime"}
                        <div class="md:col-span-3 space-y-1">
                            <label
                                class="text-[10.5px] font-bold text-[var(--stor-muted-text)] uppercase ml-1"
                                >Default</label
                            >
                            <div
                                class="flex items-center gap-2 px-3 py-2 bg-[var(--stor-surface)] border border-[var(--stor-border)] rounded-lg cursor-pointer hover:bg-[var(--stor-surface-muted)] transition-colors whitespace-nowrap"
                            >
                                <Checkbox
                                    checked={editingField.default ===
                                        "datetime('now')"}
                                    onCheckedChange={(checked) =>
                                        (editingField.default = checked
                                            ? "datetime('now')"
                                            : undefined)}
                                    class="h-4 w-4 rounded"
                                />
                                <span class="text-sm text-[var(--stor-muted-text)]">now()</span
                                >
                            </div>
                        </div>
                    {:else}
                        <div class="md:col-span-3 space-y-1">
                            <label
                                class="text-[10.5px] font-bold text-[var(--stor-muted-text)] uppercase ml-1"
                                >Default</label
                            >
                            <input
                                type="text"
                                placeholder="optional"
                                bind:value={editingField.default}
                                class="stor-native-field"
                            />
                        </div>
                    {/if}
                    <div class="md:col-span-2">
                        <Button onclick={addField} class="w-full">
                            {editingFieldIndex !== null ? "Update" : "Add"}
                        </Button>
                    </div>
                </div>

                <!-- Fields List -->
                {#if newFields.length > 0}
                    <div class="mt-6 space-y-2">
                        {#each newFields as field, index}
                            <div
                                class="flex items-center gap-3 p-3 bg-[var(--stor-surface)] border border-[var(--stor-border)] rounded-lg group/item"
                                in:fly={{ x: -10, duration: 200 }}
                            >
                                <div
                                    class="w-8 h-8 bg-[var(--stor-surface-muted)] rounded-lg flex items-center justify-center text-xs font-bold text-[var(--stor-muted-text)]"
                                >
                                    {index + 1}
                                </div>
                                <div class="flex-1">
                                    <div class="flex items-center gap-2">
                                        <span
                                            class="font-semibold text-sm text-[var(--stor-ink)]"
                                            >{field.name}</span
                                        >
                                        <span
                                            class="text-[10.5px] bg-[var(--stor-surface-muted)] text-[var(--stor-muted-text)] px-1.5 py-0.5 rounded font-mono uppercase"
                                            >{field.type}</span
                                        >
                                    </div>
                                </div>
                                <div
                                    class="flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/item:opacity-100 sm:group-focus-within/item:opacity-100"
                                >
                                    <button
                                        onclick={() => editField(index)}
                                        class="p-1.5 text-[var(--stor-muted-text)] hover:text-[var(--stor-ink)] hover:bg-[var(--stor-surface-muted)] rounded-lg transition-all"
                                    >
                                        <svg
                                            class="w-4 h-4"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24"
                                        >
                                            <path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                stroke-width="2"
                                                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                            />
                                        </svg>
                                    </button>
                                    <button
                                        onclick={() => removeField(index)}
                                        class="p-1.5 text-[var(--stor-muted-text)] hover:text-[var(--stor-negative)] hover:bg-[var(--stor-negative-soft)] rounded-lg transition-all"
                                    >
                                        <svg
                                            class="w-4 h-4"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24"
                                        >
                                            <path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                stroke-width="2"
                                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                            />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                        {/each}
                    </div>
                {/if}
            </div>
        </div>

        <CalendarSourceFields
            fields={newFields}
            bind:draft={calendarDraft}
            defaultLabel={newDisplayName}
        />

    </div>
{#snippet footer()}
            <Button variant="secondary" onclick={resetForm}>Discard</Button>
            <Button
                onclick={handleCreate}
                disabled={!newName.trim() || newFields.length === 0 || calendarDraftInvalid}
            >
                Define Type
            </Button>

{/snippet}
</CommandDrawer>

<CommandDrawer
    show={!!isEditing}
    size="lg"
    title="Edit entity schema"
    description="Review the schema carefully before redefining this entity type."
    onClose={cancelEdit}
>
    {#if isEditing}
        <div class="space-y-8">
            <!-- Warning Banner -->
            <div
                class="px-8 py-4 bg-[var(--stor-warning-soft)] border-b border-[var(--stor-border)] -mx-6 -mt-6 mb-6"
            >
                <div class="flex gap-3 items-start">
                    <svg
                        class="w-5 h-5 text-[var(--stor-warning)] flex-shrink-0 mt-0.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                        />
                    </svg>
                    <div>
                        <h3 class="font-bold text-[var(--stor-warning)] text-sm">
                            Destructive Operation
                        </h3>
                        <p class="text-[var(--stor-warning)] text-xs mt-0.5">
                            Saving changes will <strong
                                >delete all existing {isEditing.display_name} data</strong
                            >. This is intended for the design phase only.
                        </p>
                    </div>
                </div>
            </div>

            <!-- Basic Info -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div class="space-y-1.5">
                    <label class="text-sm font-semibold text-[var(--stor-ink)] ml-1"
                        >Entity ID</label
                    >
                    <input
                        type="text"
                        placeholder="snake_case_name"
                        bind:value={newName}
                        disabled
                        class="stor-native-field"
                    />
                    <p class="text-[10.5px] text-[var(--stor-muted-text)] ml-1">
                        Cannot be changed
                    </p>
                </div>
                <div class="space-y-1.5">
                    <label class="text-sm font-semibold text-[var(--stor-ink)] ml-1"
                        >Display Name</label
                    >
                    <input
                        type="text"
                        placeholder="Pretty Name"
                        bind:value={newDisplayName}
                        class="stor-native-field"
                    />
                </div>
            </div>

            <!-- Fields Management -->
            <div class="space-y-4">
                <div class="flex items-center justify-between">
                    <h3 class="text-base font-semibold text-[var(--stor-ink)]">
                        Fields Configuration
                    </h3>
                    <span
                        class="text-xs bg-[var(--stor-surface-muted)] text-[var(--stor-muted-text)] px-3 py-1 rounded-full font-semibold uppercase tracking-wide"
                    >
                        {newFields.length} total fields
                    </span>
                </div>

                <div
                    class="space-y-3 rounded-xl bg-[var(--stor-surface-muted)] p-4"
                >
                    <!-- Field Form -->
                    <div
                        class="grid grid-cols-1 md:grid-cols-12 gap-3 items-end"
                    >
                        <div class="md:col-span-3 space-y-1">
                            <label
                                class="text-[10.5px] font-bold text-[var(--stor-muted-text)] uppercase ml-1"
                                >Field Name</label
                            >
                            <input
                                type="text"
                                placeholder="title"
                                bind:value={editingField.name}
                                class="stor-native-field"
                            />
                        </div>
                        <div class="md:col-span-2 space-y-1">
                            <label
                                class="text-[10.5px] font-bold text-[var(--stor-muted-text)] uppercase ml-1"
                                >Type</label
                            >
                            <select
                                bind:value={editingField.type}
                                class="stor-native-field"
                            >
                                <option value="string">String</option>
                                <option value="number">Number</option>
                                <option value="boolean">Boolean</option>
                                <option value="datetime">Datetime</option>
                                <option value="reference">Reference</option>
                            </select>
                        </div>
                        {#if editingField.type === "reference"}
                            <div class="md:col-span-3 space-y-1">
                                <label
                                    class="text-[10.5px] font-bold text-[var(--stor-muted-text)] uppercase ml-1"
                                    >References</label
                                >
                                <select
                                    bind:value={editingField.referenceTo}
                                    class="stor-native-field"
                                >
                                    <option value="">Select entity...</option>
                                    {#each entityTypes as et}
                                        <option value={et.name}
                                            >{et.display_name}</option
                                        >
                                    {/each}
                                </select>
                            </div>
                            <div class="md:col-span-2 space-y-1">
                                <label
                                    class="text-[10.5px] font-bold text-[var(--stor-muted-text)] uppercase ml-1"
                                    >Default</label
                                >
                                <input
                                    type="text"
                                    placeholder="optional"
                                    bind:value={editingField.default}
                                    class="stor-native-field"
                                />
                            </div>
                        {:else if editingField.type === "datetime"}
                            <div class="md:col-span-3 space-y-1">
                                <label
                                    class="text-[10.5px] font-bold text-[var(--stor-muted-text)] uppercase ml-1"
                                    >Default</label
                                >
                                <div
                                    class="flex items-center gap-2 px-3 py-2 bg-[var(--stor-surface)] border border-[var(--stor-border)] rounded-lg cursor-pointer hover:bg-[var(--stor-surface-muted)] transition-colors whitespace-nowrap"
                                >
                                    <Checkbox
                                        checked={editingField.default ===
                                            "datetime('now')"}
                                        onCheckedChange={(checked) =>
                                            (editingField.default = checked
                                                ? "datetime('now')"
                                                : undefined)}
                                        class="h-4 w-4 rounded"
                                    />
                                    <span class="text-sm text-[var(--stor-muted-text)]"
                                        >now()</span
                                    >
                                </div>
                            </div>
                        {:else}
                            <div class="md:col-span-3 space-y-1">
                                <label
                                    class="text-[10.5px] font-bold text-[var(--stor-muted-text)] uppercase ml-1"
                                    >Default</label
                                >
                                <input
                                    type="text"
                                    placeholder="optional"
                                    bind:value={editingField.default}
                                    class="stor-native-field"
                                />
                            </div>
                        {/if}
                        <div class="md:col-span-2">
                            <Button onclick={addField} class="w-full">
                                {editingFieldIndex !== null ? "Update" : "Add"}
                            </Button>
                        </div>
                    </div>

                    <!-- Fields List -->
                    {#if newFields.length > 0}
                        <div class="mt-6 space-y-2">
                            {#each newFields as field, index}
                                <div
                                    class="flex items-center gap-3 p-3 bg-[var(--stor-surface)] border border-[var(--stor-border)] rounded-lg group/item"
                                    in:fly={{ x: -10, duration: 200 }}
                                >
                                    <div
                                        class="w-8 h-8 bg-[var(--stor-surface-muted)] rounded-lg flex items-center justify-center text-xs font-bold text-[var(--stor-muted-text)]"
                                    >
                                        {index + 1}
                                    </div>
                                    <div class="flex-1">
                                        <div class="flex items-center gap-2">
                                            <span
                                                class="font-semibold text-sm text-[var(--stor-ink)]"
                                                >{field.name}</span
                                            >
                                            <span
                                                class="text-[10.5px] bg-[var(--stor-surface-muted)] text-[var(--stor-muted-text)] px-1.5 py-0.5 rounded font-mono uppercase"
                                                >{field.type}</span
                                            >
                                            {#if field.referenceTo}
                                                <span
                                                    class="text-[10.5px] text-[var(--stor-accent-strong)]"
                                                    >→ {field.referenceTo}</span
                                                >
                                            {/if}
                                        </div>
                                    </div>
                                    <div
                                    class="flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/item:opacity-100 sm:group-focus-within/item:opacity-100"
                                    >
                                        <button
                                            onclick={() => editField(index)}
                                            class="p-1.5 text-[var(--stor-muted-text)] hover:text-[var(--stor-ink)] hover:bg-[var(--stor-surface-muted)] rounded-lg transition-all"
                                        >
                                            <svg
                                                class="w-4 h-4"
                                                fill="none"
                                                stroke="currentColor"
                                                viewBox="0 0 24 24"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    stroke-width="2"
                                                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                                />
                                            </svg>
                                        </button>
                                        <button
                                            onclick={() => removeField(index)}
                                            class="p-1.5 text-[var(--stor-muted-text)] hover:text-[var(--stor-negative)] hover:bg-[var(--stor-negative-soft)] rounded-lg transition-all"
                                        >
                                            <svg
                                                class="w-4 h-4"
                                                fill="none"
                                                stroke="currentColor"
                                                viewBox="0 0 24 24"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    stroke-width="2"
                                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                                />
                                            </svg>
                                        </button>
                                    </div>
                                </div>
                            {/each}
                        </div>
                    {/if}
                </div>
            </div>

            <CalendarSourceFields
                fields={newFields}
                bind:draft={calendarDraft}
                defaultLabel={newDisplayName}
            />

        </div>
    {/if}
{#snippet footer()}
                <Button variant="secondary" onclick={cancelEdit}>Cancel</Button>
                <Button
                    onclick={handleRedefinition}
                    disabled={newFields.length === 0 || calendarDraftInvalid}
                >
                    <svg
                        class="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                        />
                    </svg>
                    Save & Reset Data
                </Button>

{/snippet}
</CommandDrawer>

<!-- Export Modal -->
<Modal
    show={showExportModal}
    title="Code Export"
    onClose={() => (showExportModal = false)}
>
    <div class="space-y-6">
        <div class="bg-stone-900 rounded-xl p-6 relative group">
            <pre
                class="text-stone-300 text-sm overflow-x-auto font-mono leading-relaxed"><code
                    >{exportCode}</code
                ></pre>
            <button
                onclick={copyToClipboard}
                class="absolute top-4 right-4 px-4 py-2 bg-white/10 hover:bg-white/20 text-white text-xs font-bold rounded-xl backdrop-blur-md transition-all opacity-0 group-hover:opacity-100"
            >
                Copy Snippet
            </button>
        </div>

        <div class="rounded-lg bg-[var(--stor-surface-muted)] p-4 flex gap-3 text-[var(--stor-info)]">
            <svg
                class="w-5 h-5 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
            >
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
            </svg>
            <p class="text-xs font-medium leading-relaxed">
                Copy this snippet into your <code>entity-definitions.ts</code> file
                to convert this dynamic type into a fully-typed static entity with
                auto-generated code.
            </p>
        </div>

        <div class="flex justify-end pt-4">
            <button
                onclick={() => (showExportModal = false)}
                class="rounded-xl bg-[var(--stor-action)] px-8 py-3 font-semibold text-[var(--stor-action-text)] transition-all hover:bg-[var(--stor-action-hover)]"
            >
                Done
            </button>
        </div>
    </div>
</Modal>

<CommandConfirmDialog
    show={showArchiveConfirm}
    title="Archive Entity Type"
    message={`Archive "${itemToArchive?.display_name}"? The data will be preserved but the entity type will be hidden.`}
    onConfirm={executeArchive}
    onCancel={() => (showArchiveConfirm = false)}
/>

<CommandConfirmDialog
    show={showRedefineConfirm}
    title="Confirm Redefinition"
    message={`⚠️ WARNING: This will DELETE ALL existing ${isEditing?.display_name} data!\n\nThe entity type will be redefined with the new schema, and all existing records will be permanently removed.\n\nAre you sure you want to continue?`}
    onConfirm={executeRedefinition}
    onCancel={() => (showRedefineConfirm = false)}
/>

<style>
    /* Simple custom scrollbar for better look */
    ::-webkit-scrollbar {
        width: 8px;
    }
    ::-webkit-scrollbar-track {
        background: transparent;
    }
    ::-webkit-scrollbar-thumb {
        background: #e7e5e4;
        border-radius: 10px;
    }
    ::-webkit-scrollbar-thumb:hover {
        background: #d6d3d1;
    }
</style>
