<script lang="ts">
    import {
        DatePicker as BitsDatePicker,
        TimeField as BitsTimeField,
    } from "bits-ui";
    import {
        CalendarDateTime,
        Time,
        parseDate,
        parseDateTime,
        today,
        getLocalTimeZone,
        type DateValue,
    } from "@internationalized/date";
    import { cn } from "../../utils/cn.js";
    import IconCalendar from "~icons/mdi/calendar-month-outline";
    import IconChevronLeft from "~icons/mdi/chevron-left";
    import IconChevronRight from "~icons/mdi/chevron-right";
    import IconClose from "~icons/mdi/close";
    import IconMinus from "~icons/mdi/minus";
    import IconPlus from "~icons/mdi/plus";

    type PickerGranularity = "day" | "minute";

    let {
        value = $bindable(""),
        id = "",
        name = "",
        placeholder = "",
        disabled = false,
        clearable = true,
        granularity = "day",
        locale = "en-GB",
        class: className = "",
        triggerClass = "",
        contentClass = "",
        onValueChange = () => {},
    }: {
        value?: string;
        id?: string;
        name?: string;
        placeholder?: string;
        disabled?: boolean;
        clearable?: boolean;
        granularity?: PickerGranularity;
        locale?: string;
        class?: string;
        triggerClass?: string;
        contentClass?: string;
        onValueChange?: (value: string) => void;
    } = $props();

    let pickerValue = $derived(parsePickerValue(value, granularity));
    let placeholderValue = $derived(
        pickerValue ?? createPlaceholderValue(granularity),
    );
    let timeValue = $derived(getTimeValue(pickerValue));
    let hasValue = $derived(value.trim().length > 0);
    const timePlaceholder = new Time(0, 0, 0);

    function parsePickerValue(
        rawValue: string,
        pickerGranularity: PickerGranularity,
    ): DateValue | undefined {
        const normalized = rawValue.trim();
        if (!normalized) return undefined;

        try {
            if (pickerGranularity === "minute") {
                const dateTime = normalized.includes("T")
                    ? normalized.slice(0, 16)
                    : normalized.replace(" ", "T").slice(0, 16);
                return parseDateTime(dateTime);
            }

            return parseDate(normalized.slice(0, 10));
        } catch {
            return undefined;
        }
    }

    function pad(value: number) {
        return String(value).padStart(2, "0");
    }

    function createPlaceholderValue(pickerGranularity: PickerGranularity) {
        const currentDate = today(getLocalTimeZone());
        if (pickerGranularity === "minute") {
            return new CalendarDateTime(
                currentDate.year,
                currentDate.month,
                currentDate.day,
                0,
                0,
                0,
            );
        }
        return currentDate;
    }

    function toInputValue(nextValue: DateValue | undefined) {
        if (!nextValue) return "";
        if (granularity === "minute" && nextValue instanceof CalendarDateTime) {
            return `${nextValue.year}-${pad(nextValue.month)}-${pad(nextValue.day)}T${pad(nextValue.hour)}:${pad(nextValue.minute)}`;
        }
        return nextValue.toString().slice(0, 10);
    }

    function getTimeValue(nextValue: DateValue | undefined) {
        if (nextValue instanceof CalendarDateTime) {
            return new Time(nextValue.hour, nextValue.minute, nextValue.second);
        }
        return undefined;
    }

    function getDateTimeBase() {
        const parsedValue = parsePickerValue(value, "minute");
        if (parsedValue instanceof CalendarDateTime) return parsedValue;
        return createPlaceholderValue("minute") as CalendarDateTime;
    }

    function setTime(nextTime: Time | undefined) {
        if (!nextTime) return;
        const base = getDateTimeBase();
        handleValueChange(
            new CalendarDateTime(
                base.year,
                base.month,
                base.day,
                nextTime.hour,
                nextTime.minute,
                nextTime.second,
            ),
        );
    }

    function adjustTime(minutes: number) {
        const currentTime = timeValue ?? timePlaceholder;
        const currentMinutes = currentTime.hour * 60 + currentTime.minute;
        const nextMinutes = (currentMinutes + minutes + 1440) % 1440;
        setTime(
            new Time(
                Math.floor(nextMinutes / 60),
                nextMinutes % 60,
                currentTime.second,
            ),
        );
    }

    function handleValueChange(nextValue: DateValue | undefined) {
        const nextInputValue = toInputValue(nextValue);
        value = nextInputValue;
        onValueChange(nextInputValue);
    }

    function clearValue() {
        value = "";
        onValueChange("");
    }

    function segmentClass(part: string) {
        return cn(
            "rounded px-0.5 tabular-nums outline-none",
            part === "literal"
                ? "text-[var(--stor-muted-text)]"
                : "text-stone-950 focus:bg-stone-200",
        );
    }
</script>

<BitsDatePicker.Root
    value={pickerValue}
    placeholder={placeholderValue}
    onValueChange={handleValueChange}
    {disabled}
    {granularity}
    hourCycle={24}
    hideTimeZone
    closeOnDateSelect={granularity !== "minute"}
    {locale}
    weekStartsOn={1}
    fixedWeeks
    calendarLabel={placeholder || "Choose date"}
>
    <div
        class={cn(
            "flex min-w-0 w-full items-center rounded-xl border border-[var(--stor-field-border)] stor-well focus-within:bg-[var(--stor-surface)] text-base sm:text-sm text-stone-950 transition focus-within:border-[var(--stor-focus)] focus-within:ring-2 focus-within:ring-[var(--stor-selected)]",
            disabled && "cursor-not-allowed bg-[var(--stor-surface-muted)] text-[var(--stor-muted-text)]",
            className,
        )}
    >
        <BitsDatePicker.Input
            id={id || undefined}
            {name}
            data-date-value={value}
            class={cn(
                "flex h-11 sm:h-9 min-w-0 flex-1 items-center gap-0.5 px-3 py-2.5 sm:py-1.5 outline-none",
                granularity === "minute"
                    ? "flex-wrap gap-y-0.5"
                    : "overflow-hidden whitespace-nowrap",
            )}
        >
            {#snippet children({ segments })}
                {#each segments as segment}
                    <BitsDatePicker.Segment
                        part={segment.part}
                        class={segmentClass(segment.part)}
                    >
                        {segment.value}
                    </BitsDatePicker.Segment>
                {/each}
            {/snippet}
        </BitsDatePicker.Input>

        {#if hasValue && !disabled && clearable}
            <button
                type="button"
                class="mr-1 flex h-10 w-10 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-lg text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-surface-muted)] hover:text-stone-700"
                aria-label={granularity === "minute"
                    ? "Clear date and time"
                    : "Clear date"}
                onclick={clearValue}
            >
                <IconClose class="h-4 w-4" />
            </button>
        {/if}

        <BitsDatePicker.Trigger
            class={cn(
                "mr-1 flex h-10 w-10 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-lg text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-surface-muted)] hover:text-stone-950 disabled:cursor-not-allowed disabled:opacity-50",
                triggerClass,
            )}
            aria-label={granularity === "minute"
                ? "Open date and time picker"
                : "Open date picker"}
        >
            <IconCalendar class="h-4 w-4" />
        </BitsDatePicker.Trigger>
    </div>

    <BitsDatePicker.Portal>
        <BitsDatePicker.Content
            sideOffset={6}
            collisionPadding={8}
            class={cn(
                "stor-menu z-[var(--stor-layer-dialog)] p-3 outline-none",
                contentClass,
            )}
        >
            <BitsDatePicker.Calendar>
                {#snippet children({ months, weekdays })}
                    <BitsDatePicker.Header class="mb-2 flex items-center justify-between gap-2">
                        <BitsDatePicker.PrevButton class="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-surface-muted)] hover:text-stone-950 disabled:opacity-40">
                            <IconChevronLeft class="h-4 w-4" />
                        </BitsDatePicker.PrevButton>
                        <BitsDatePicker.Heading class="text-sm font-semibold text-stone-900" />
                        <BitsDatePicker.NextButton class="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-surface-muted)] hover:text-stone-950 disabled:opacity-40">
                            <IconChevronRight class="h-4 w-4" />
                        </BitsDatePicker.NextButton>
                    </BitsDatePicker.Header>

                    {#each months as month (month.value.toString())}
                        <BitsDatePicker.Grid class="w-full border-separate border-spacing-1">
                            <BitsDatePicker.GridHead>
                                <BitsDatePicker.GridRow>
                                    {#each weekdays as day}
                                        <BitsDatePicker.HeadCell class="h-7 w-8 text-center text-[10.5px] font-semibold uppercase text-[var(--stor-muted-text)]">
                                            {day}
                                        </BitsDatePicker.HeadCell>
                                    {/each}
                                </BitsDatePicker.GridRow>
                            </BitsDatePicker.GridHead>
                            <BitsDatePicker.GridBody>
                                {#each month.weeks as week}
                                    <BitsDatePicker.GridRow>
                                        {#each week as date}
                                            <BitsDatePicker.Cell
                                                {date}
                                                month={month.value}
                                                class="p-0 text-center"
                                            >
                                                <BitsDatePicker.Day
                                                    class="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-medium text-[var(--stor-muted-text)] outline-none transition hover:bg-[var(--stor-accent-soft)] focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] data-[disabled]:pointer-events-none data-[disabled]:opacity-30 data-[outside-month]:text-[var(--stor-muted-text)] data-[selected]:bg-[var(--stor-action)] data-[selected]:text-[var(--stor-action-text)] data-[today]:ring-1 data-[today]:ring-[var(--stor-focus)] data-[unavailable]:text-[var(--stor-negative)]"
                                                />
                                            </BitsDatePicker.Cell>
                                        {/each}
                                    </BitsDatePicker.GridRow>
                                {/each}
                            </BitsDatePicker.GridBody>
                        </BitsDatePicker.Grid>
                    {/each}
                {/snippet}
            </BitsDatePicker.Calendar>

            {#if granularity === "minute"}
                <div class="mt-3 border-t border-[var(--stor-border)] pt-3">
                    <div class="mb-2 flex items-center justify-between gap-3">
                        <span class="text-xs font-semibold uppercase text-[var(--stor-muted-text)]">Time</span>
                        <BitsDatePicker.Close class="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-stone-600 transition hover:bg-[var(--stor-surface-muted)] hover:text-stone-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400">
                            Done
                        </BitsDatePicker.Close>
                    </div>

                    <div class="mb-2">
                        <BitsTimeField.Root
                            value={timeValue}
                            placeholder={timePlaceholder}
                            onValueChange={setTime}
                            granularity="minute"
                            hourCycle={24}
                            hideTimeZone
                            {locale}
                            {disabled}
                        >
                            <BitsTimeField.Input
                                aria-label="Selected time"
                                class="flex min-h-9 items-center gap-0.5 rounded-lg border border-[var(--stor-border)] bg-[var(--stor-surface-muted)] px-3 py-2 text-sm text-stone-950 outline-none transition focus-within:border-stone-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-stone-200"
                            >
                                {#snippet children({ segments })}
                                    {#each segments as segment}
                                        <BitsTimeField.Segment
                                            part={segment.part}
                                            class={segmentClass(segment.part)}
                                        >
                                            {segment.value}
                                        </BitsTimeField.Segment>
                                    {/each}
                                {/snippet}
                            </BitsTimeField.Input>
                        </BitsTimeField.Root>
                    </div>

                    <div class="grid grid-cols-4 gap-1.5">
                        <button
                            type="button"
                            class="flex h-8 items-center justify-center gap-1 rounded-2xl bg-[var(--stor-surface-raised)] px-2 text-xs font-medium text-stone-600 transition hover:bg-[var(--stor-surface-muted)] hover:text-stone-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400"
                            aria-label="Decrease time by one hour"
                            onclick={() => adjustTime(-60)}
                        >
                            <IconMinus class="h-3.5 w-3.5" />
                            1h
                        </button>
                        <button
                            type="button"
                            class="flex h-8 items-center justify-center gap-1 rounded-2xl bg-[var(--stor-surface-raised)] px-2 text-xs font-medium text-stone-600 transition hover:bg-[var(--stor-surface-muted)] hover:text-stone-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400"
                            aria-label="Increase time by one hour"
                            onclick={() => adjustTime(60)}
                        >
                            <IconPlus class="h-3.5 w-3.5" />
                            1h
                        </button>
                        <button
                            type="button"
                            class="flex h-8 items-center justify-center gap-1 rounded-2xl bg-[var(--stor-surface-raised)] px-2 text-xs font-medium text-stone-600 transition hover:bg-[var(--stor-surface-muted)] hover:text-stone-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400"
                            aria-label="Decrease time by five minutes"
                            onclick={() => adjustTime(-5)}
                        >
                            <IconMinus class="h-3.5 w-3.5" />
                            5m
                        </button>
                        <button
                            type="button"
                            class="flex h-8 items-center justify-center gap-1 rounded-2xl bg-[var(--stor-surface-raised)] px-2 text-xs font-medium text-stone-600 transition hover:bg-[var(--stor-surface-muted)] hover:text-stone-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400"
                            aria-label="Increase time by five minutes"
                            onclick={() => adjustTime(5)}
                        >
                            <IconPlus class="h-3.5 w-3.5" />
                            5m
                        </button>
                    </div>
                </div>
            {/if}
        </BitsDatePicker.Content>
    </BitsDatePicker.Portal>
</BitsDatePicker.Root>
