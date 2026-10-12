<script lang="ts">
    import Checkbox from "@hearthlog/ui/components/ui/Checkbox.svelte";
    import Field from "@hearthlog/ui/components/ui/Field.svelte";
    import Input from "@hearthlog/ui/components/ui/Input.svelte";
    import Select from "@hearthlog/ui/components/ui/Select.svelte";
    import type { DynamicFieldDefinition } from "@hearthlog/runtime/event/meta-entity-types.js";
    import {
        calendarDraftError,
        type CalendarSourceDraft,
    } from "@hearthlog/runtime/calendar/draft.js";

    let {
        fields,
        draft = $bindable(),
        defaultLabel = "",
    }: {
        fields: readonly DynamicFieldDefinition[];
        draft: CalendarSourceDraft;
        defaultLabel?: string;
    } = $props();

    const dateOptions = $derived.by(() => {
        const options = fields
            .filter((field) => field.type === "datetime")
            .map((field) => ({ value: field.name, label: field.name }));
        if (
            draft.dateField &&
            !options.some((option) => option.value === draft.dateField)
        ) {
            options.push({ value: draft.dateField, label: draft.dateField });
        }
        return options;
    });

    const optionalDateOptions = $derived([
        { value: "", label: "None" },
        ...dateOptions,
    ]);

    const textOptions = $derived([
        { value: "", label: "None" },
        ...fields
            .filter((field) => field.type === "string")
            .map((field) => ({ value: field.name, label: field.name })),
    ]);

    const error = $derived(draft.enabled ? calendarDraftError(draft, fields) : null);

    function setEnabled(enabled: boolean): void {
        draft.enabled = enabled;
        if (enabled && !draft.label.trim()) {
            draft.label = defaultLabel.trim() || "Event";
        }
    }
</script>

<div class="space-y-4 rounded-xl bg-[var(--stor-surface-muted)] p-4">
    <div class="flex items-start justify-between gap-3">
        <div>
            <h3 class="text-base font-semibold text-[var(--stor-ink)]">Calendar</h3>
            <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
                Show records from this entity on the Calendar page.
            </p>
        </div>
        <label class="flex items-center gap-2 whitespace-nowrap text-sm text-[var(--stor-ink)]">
            <Checkbox
                checked={draft.enabled}
                onCheckedChange={(checked) => setEnabled(Boolean(checked))}
                aria-label="Show on calendar"
            />
            On calendar
        </label>
    </div>

    {#if draft.enabled}
        {#if dateOptions.length === 0}
            <p class="text-xs text-[var(--stor-muted-text)]">
                Add a datetime field first, then choose it as the calendar date.
            </p>
        {:else}
            <div class="grid gap-3 sm:grid-cols-2">
                <Field
                    label="Date field"
                    htmlFor="calendar-draft-date"
                    required
                >
                    <Select
                        id="calendar-draft-date"
                        value={draft.dateField}
                        options={dateOptions}
                        placeholder="Choose a date field"
                        onValueChange={(value) => (draft.dateField = value)}
                    />
                </Field>
                <Field
                    label="Label"
                    htmlFor="calendar-draft-label"
                    hint="Shown in the agenda and calendar feeds"
                    required
                >
                    <Input
                        id="calendar-draft-label"
                        bind:value={draft.label}
                        placeholder="e.g. Task due"
                    />
                </Field>
                <Field
                    label="End date"
                    htmlFor="calendar-draft-end"
                    hint="For multi-day records"
                >
                    <Select
                        id="calendar-draft-end"
                        value={draft.endDateField}
                        options={optionalDateOptions}
                        onValueChange={(value) => (draft.endDateField = value)}
                    />
                </Field>
                <Field
                    label="Time field"
                    htmlFor="calendar-draft-time"
                    hint="Optional HH:mm column"
                >
                    <Select
                        id="calendar-draft-time"
                        value={draft.timeField}
                        options={textOptions}
                        onValueChange={(value) => (draft.timeField = value)}
                    />
                </Field>
                <Field
                    label="Title field"
                    htmlFor="calendar-draft-title"
                    hint="Defaults to the record name"
                >
                    <Select
                        id="calendar-draft-title"
                        value={draft.titleField}
                        options={textOptions}
                        onValueChange={(value) => (draft.titleField = value)}
                    />
                </Field>
            </div>
            {#if error}
                <p class="text-xs text-[var(--stor-negative)]" role="alert">{error}</p>
            {/if}
        {/if}
    {/if}
</div>
