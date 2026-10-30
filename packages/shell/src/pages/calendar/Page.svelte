<script lang="ts">
    const drawerId = $props.id();
    const drawerFormId0 = drawerId + "-0";

    import { providePageResource } from "@hearthlog/runtime/runtime/page-data.svelte.js";
    import PageDataStatus from "@hearthlog/shell/components/layout/PageDataStatus.svelte";
    import DataPlaceholder from "@hearthlog/ui/components/data/DataPlaceholder.svelte";
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import { refreshPageData as invalidate } from "@hearthlog/runtime/runtime/refresh.js";
    import { onMount, tick, untrack } from "svelte";
    import { Popover } from "bits-ui";
    import { format as formatDay } from "date-fns";
    import {
        calendarMonthBounds,
        describeEventCountdown,
        daysUntilCalendarEvent,
        parseCalendarMonth,
        toLocalDateString,
        validateCalendarEventDraft,
        type CalendarEventDraft,
    } from "@hearthlog/runtime/calendar/logic.js";
    import { countWorkingDays, getWorkingDays, type DateInfo } from "@hearthlog/czech";
    import {
        calendarSourcePresentation,
        calendarItemHref,
        type CalendarTone,
    } from "@hearthlog/contracts/calendar/sources";
    import {
        calendarMenuEntries,
        effectiveCalendarSourcePreference,
        isCalendarMenuEntryVisible,
        toggleCalendarMenuEntry,
        type CalendarSourcePreference,
    } from "@hearthlog/runtime/calendar/groups.js";
    import { setCalendarSourcePreference } from "@hearthlog/runtime/calendar/preferences.js";
    import { eventLogFilename } from "@hearthlog/runtime/store/event-log.svelte.js";
    import { serializeIcs, type IcsEventInput } from "@hearthlog/contracts/calendar/ics";
    import type {
        CalendarPointItem,
        CalendarRangeItem,
        CalendarRangeResult,
        CalendarSourceCounts,
        CalendarSourceInfo,
        CalendarWeek,
    } from "@hearthlog/contracts/calendar/types";
    import { dayColumn, monthInView, WEEK_SPAN } from "@hearthlog/runtime/calendar/weeks.js";
    import { monthKeyOf, shiftDay, shiftMonthKey, shiftWeek, weekAxis, weekStartOf } from "@hearthlog/ui/utils/endless-axis.js";
    import EndlessList, { type EndlessBlock, type EndlessPosition, type EndlessTarget, type EndlessView } from "@hearthlog/ui/components/endless/EndlessList.svelte";
    import { CalendarWeeks } from "@hearthlog/shell/components/calendar/calendar-weeks.svelte.js";
    import { calendarSourceIcon } from "@hearthlog/shell/components/calendar/source-icons.js";
    import CalendarFeedsDrawer from "@hearthlog/shell/components/calendar/CalendarFeedsDrawer.svelte";
    import CalendarMonthSummary from "@hearthlog/shell/components/calendar/CalendarMonthSummary.svelte";
    import type { CalendarEvent } from "@hearthlog/runtime/db/calendar.js";
    import {
        type AddCalendarEventEvent,
        type RemoveCalendarEventEvent,
        type UpdateCalendarEventEvent,
    } from "@hearthlog/runtime/event/index.js";
    import { executeLocalCommand } from "@hearthlog/runtime/commands/index.js";
    import { queryDatabase } from "@hearthlog/runtime/db/read-repositories.js";
    import { notify } from "@hearthlog/ui/state/notifications.svelte.js";
    import { contextualHref } from "@hearthlog/runtime/runtime/view.js";
    import { tenant } from "@hearthlog/contracts/tenant/config";
    import { runCommandAction as runWorkspaceCommandAction } from "@hearthlog/ui/state/commands.js";
    import CommandOnly from "@hearthlog/ui/components/commands/CommandOnly.svelte";
    import CommandDrawer from "@hearthlog/ui/components/commands/CommandDrawer.svelte";
    import CommandConfirmDialog from "@hearthlog/ui/components/commands/CommandConfirmDialog.svelte";
    import Button from "@hearthlog/ui/components/ui/Button.svelte";
    import MonthNavigator from "@hearthlog/ui/components/ui/MonthNavigator.svelte";
    import MobilePageAction from "@hearthlog/shell/components/layout/MobilePageAction.svelte";
    import Checkbox from "@hearthlog/ui/components/ui/Checkbox.svelte";
    import DatePicker from "@hearthlog/ui/components/ui/DatePicker.svelte";
    import Field from "@hearthlog/ui/components/ui/Field.svelte";
    import Input from "@hearthlog/ui/components/ui/Input.svelte";
    import Textarea from "@hearthlog/ui/components/ui/Textarea.svelte";
    import PageHeader from "@hearthlog/ui/components/PageHeader.svelte";
    import IconDelete from "~icons/mdi/trash-can-outline";
    import IconPin from "~icons/mdi/pin";
    import IconPlus from "~icons/mdi/plus";
    import IconExport from "~icons/mdi/download-outline";
    import IconRss from "~icons/mdi/rss";
    import IconChevronDown from "~icons/mdi/chevron-down";
    import IconFilter from "~icons/mdi/filter-variant";
    import IconClose from "~icons/mdi/close";
    import { MediaQuery } from "svelte/reactivity";
    import PhoneGlance from "@hearthlog/shell/components/layout/PhoneGlance.svelte";
    import Switch from "@hearthlog/ui/components/ui/Switch.svelte";

    let { data: routeData } = $props();
    const resource = $derived(routeData.pageResource);
    const liveData = $derived(resource.data);
    // Keep the loaded data on screen while a refresh loads, so saves and
    // filter changes swap atomically instead of flashing skeletons.
    // PageDataStatus keeps the real resource for perf recording.
    let displayedData = $state<typeof liveData | null>(null);
    // Show skeletons only for the first paint of this instance.
    let hasPaintedMonth = $state(false);
    /** Counts applied loads; the weeks on screen read again when it changes. */
    let revision = $state(0);
    $effect(() => {
        if (resource.loading) return;
        const next = liveData;
        untrack(() => applyData(next));
    });
    const data = $derived(displayedData ?? liveData);
    const displayResource = $derived({
        loading: hasPaintedMonth ? false : resource.loading,
        error: resource.error,
        measurement: resource.measurement,
    });
    providePageResource(() => displayResource);
    function runCommandAction(action: () => void): boolean {
        return !displayResource.loading && runWorkspaceCommandAction(action);
    }
    const boundaryNow = $derived(new Date(data.effectiveNow));

    const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ];

    let calendarControl: HTMLElement | null = $state(null);
    let drawerOpen = $state(false);
    let editingId = $state<string | null>(null);
    let editingEvent = $state<CalendarEvent | null>(null);
    let saving = $state(false);
    let pinningId = $state<string | null>(null);
    let deleteId = $state<string | null>(null);
    let feedsOpen = $state(false);
    let errors = $state<Record<string, string>>({});
    let draft = $state<CalendarEventDraft>({
        title: "",
        eventDate: "",
        startTime: "",
        notes: "",
        pinned: false,
    });

    const todayMonth = $derived(monthKeyOf(data.today));
    /** The month in view; the header, the summary and the address follow it. */
    let visibleMonth = $state("");
    const shownMonth = $derived(visibleMonth || data.month.key);
    const currentYear = $derived(Number(shownMonth.slice(0, 4)));
    const currentMonth = $derived(Number(shownMonth.slice(5, 7)) - 1);
    const sources = $derived(data.sources as CalendarSourceInfo[]);
    const sourceByKey = $derived(new Map(sources.map((source) => [source.key, source])));
    let pendingPreference = $state<CalendarSourcePreference | null>(null);
    let preferenceSaving = $state(false);
    const storedPreference = $derived(
        data.sourcePreference as CalendarSourcePreference | null,
    );
    const activePreference = $derived(pendingPreference ?? storedPreference);
    const sourceMenuEntries = $derived(calendarMenuEntries(sources));
    const effectivePreference = $derived(
        effectiveCalendarSourcePreference(sources, activePreference),
    );
    const hiddenSourceCount = $derived(
        sourceMenuEntries.filter(
            (entry) => !isCalendarMenuEntryVisible(entry, effectivePreference),
        ).length,
    );
    const showSourceMenu = $derived(sourceMenuEntries.length > 1);
    const pinnedEvents = $derived(data.pinnedEvents as CalendarEvent[]);
    const workingDayCount = $derived(countWorkingDays(currentYear, currentMonth));
    const monthLabel = $derived(`${monthNames[currentMonth]} ${currentYear}`);

    // ---------------------------------------------------------------- endless weeks

    // Weeks are counted from the week the page opened in. Their keys are
    // Mondays, so a week keeps its place however long the page stays open.
    const axis = weekAxis(weekStartOf(untrack(() => data.today) || toLocalDateString()), WEEK_SPAN);
    /** A week before it is measured; days list their items on desktop. */
    const weekEstimate = typeof window === "undefined" ? 62
        : window.matchMedia("(min-width: 1024px)").matches ? 132
        : window.matchMedia("(max-width: 767px)").matches ? 106 : 62;
    // Phones: the month grid is the page; a tapped day opens a card above the dock.
    const phone = new MediaQuery("max-width: 767px");
    // Below 1024 px the header has no Feeds and Export buttons; the Sources menu carries them.
    const compactHeader = new MediaQuery("max-width: 1023px");
    let peekOpen = $state(false);
    let eventNotesOpen = $state(false);
    $effect(() => { if (!drawerOpen) eventNotesOpen = false; });
    const weeks = new CalendarWeeks(() => storedPreference);
    let list = $state<ReturnType<typeof EndlessList>>();

    /** A month opens with its first week at the top. */
    function monthTarget(month: string): EndlessTarget {
        return { key: weekStartOf(`${month}-01`), at: month };
    }

    /** Today settles a week below the top, so the days before it stay in sight. */
    const todayTarget = $derived<EndlessTarget & { label: string }>({
        key: shiftWeek(weekStartOf(data.today), -1),
        at: todayMonth,
        find: (block) => block.parentElement?.querySelector<HTMLElement>(`[data-calendar-day="${data.today}"]`) ?? null,
        ratio: 0.5,
        label: "Today",
    });

    /**
     * Weeks whose middle is on screen count, and the month holding most of
     * their days is the one in view, as it would be on a month page.
     */
    function pick(blocks: EndlessBlock[], { edge, bottom }: EndlessView): EndlessPosition {
        const counted = blocks.filter(({ element }) => {
            if (!element) return true;
            const rect = element.getBoundingClientRect();
            const middle = (rect.top + rect.bottom) / 2;
            return middle >= edge && middle <= bottom;
        });
        const shown = (counted.length > 0 ? counted : blocks).map(({ key }) => key);
        return { key: shown[0], at: monthInView(shown) };
    }

    function weekDays(week: string): string[] {
        return Array.from({ length: 7 }, (_, offset) => shiftDay(week, offset));
    }

    /** Working days and holidays, worked out once per month. */
    const monthDays = new Map<string, DateInfo[]>();
    function dayInfo(day: string): DateInfo {
        const month = monthKeyOf(day);
        let days = monthDays.get(month);
        if (!days) {
            days = getWorkingDays(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1);
            monthDays.set(month, days);
        }
        return days[Number(day.slice(8, 10)) - 1];
    }

    function applyData(next: typeof liveData): void {
        const previous = displayedData;
        displayedData = next;
        hasPaintedMonth = true;
        revision += 1;
        counts = { month: next.month.key, revision, value: next.monthCounts as CalendarSourceCounts };
        if (!previous) {
            // A month chosen while the page was loading wins over the address.
            if (!visibleMonth) visibleMonth = next.month.key;
            if (!selectedDate) selectedDate = visibleMonth === monthKeyOf(next.today) ? next.today : `${visibleMonth}-01`;
        } else if (previous.month.key !== next.month.key && next.month.key !== visibleMonth) {
            // A real navigation to another month while the grid is open.
            void tick().then(() => goToMonth(next.month.key));
        }
    }

    // The summary counts the month in view in SQL; a load brings the month it opened at.
    let counts = $state.raw<{ month: string; revision: number; value: CalendarSourceCounts } | null>(null);
    $effect(() => {
        const month = shownMonth;
        const current = revision;
        const preference = storedPreference;
        if (current === 0 || counts && counts.month === month && counts.revision === current) return;
        let active = true;
        const timer = setTimeout(() => {
            const bounds = calendarMonthBounds(parseCalendarMonth(month));
            void queryDatabase((repositories) =>
                repositories.calendar.getCalendarSourceCounts(bounds.startDate, bounds.endDateExclusive, preference),
            ).then((value) => {
                if (active) counts = { month, revision: current, value };
            }).catch((error) => console.warn("[Calendar] Could not count the month", error));
        }, 150);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    });
    const monthCounts = $derived(counts?.value ?? { total: 0, sources: [] });
    const countsLoading = $derived(displayResource.loading || counts?.month !== shownMonth);

    const TONE_CLASSES: Record<CalendarTone, string> = {
        accent: "bg-[var(--stor-accent-soft)] text-[var(--stor-ink)]",
        warning: "bg-[var(--stor-warning-soft)] text-[var(--stor-ink)]",
        negative: "bg-[var(--stor-negative-soft)] text-[var(--stor-ink)]",
        positive: "bg-[var(--stor-positive-soft)] text-[var(--stor-ink)]",
        info: "bg-[var(--stor-info-soft)] text-[var(--stor-ink)]",
        // Untoned events take a light ink tint: the muted fill sits too close to the card to read as a chip.
        muted: "bg-[color-mix(in_srgb,var(--stor-ink)_8%,var(--stor-surface))] text-[var(--stor-ink)]",
    };

    const TONE_DOTS: Record<CalendarTone, string> = {
        accent: "bg-[var(--stor-accent)]",
        warning: "bg-[var(--stor-warning)]",
        negative: "bg-[var(--stor-negative)]",
        positive: "bg-[var(--stor-positive)]",
        info: "bg-[var(--stor-info)]",
        muted: "bg-[var(--stor-muted-text)]",
    };

    function emptyDraft(eventDate: string): CalendarEventDraft {
        return { title: "", eventDate, startTime: "", notes: "", pinned: false };
    }

    async function focusCalendar(): Promise<void> {
        await tick();
        calendarControl?.focus({ preventScroll: true });
    }

    // The address follows the month in view quietly, so a reload opens there.
    let addressTimer: ReturnType<typeof setTimeout> | undefined;
    function followVisible(month: string): void {
        if (!month) return;
        visibleMonth = month;
        clearTimeout(addressTimer);
        addressTimer = setTimeout(() => {
                const url = new URL(window.location.href);
                if ((url.searchParams.get("month") ?? todayMonth) === month) return;
                url.searchParams.set("month", month);
                goto(`${url.pathname}${url.search}${url.hash}`, { shallow: true, replace: true });
            },
            250
        );
    }

    $effect(() => () => clearTimeout(addressTimer));

    /** Scrolls to a month and selects today there, or its first day. */
    function goToMonth(month: string): void {
        followVisible(month);
        selectedDate = month === todayMonth ? data.today : `${month}-01`;
        list?.scrollTo(monthTarget(month));
        void focusCalendar();
    }

    function goToToday(): void {
        followVisible(todayMonth);
        selectedDate = data.today;
        list?.scrollTo(todayTarget);
        void focusCalendar();
    }

    // Spatial spec: explicit selected-day state. Moving to a month selects
    // today there or its first day; scrolling by hand keeps the selection.
    let selectedDate = $state<string>("");
    const selectedWeek = $derived(selectedDate ? weeks.get(weekStartOf(selectedDate)) : undefined);
    const selectedDay = $derived(selectedWeek?.days[dayColumn(selectedDate)]);
    const selectedDayItems = $derived(selectedDay?.items ?? []);
    const selectedDayRanges = $derived(
        selectedWeek && selectedDay ? selectedDay.lanes.map((lane) => selectedWeek.bands[lane].range) : [],
    );

    // The selected day's week stays loaded while it is off screen.
    $effect(() => {
        if (!selectedDate || !hasPaintedMonth) return;
        void weeks.buckets.size;
        weeks.ensure([weekStartOf(selectedDate)]);
    });

    const selectedDayKind = $derived.by(() => {
        if (!selectedDate) return "";
        const info = dayInfo(selectedDate);
        if (info.holidayName) return info.holidayName;
        if (info.isWeekend) return "Weekend";
        return `Working day ${info.workingDayNumber} of ${countWorkingDays(info.date.getFullYear(), info.date.getMonth())}`;
    });
    const selectedDaySummary = $derived.by(() => {
        const count = selectedDayItems.length + selectedDayRanges.length;
        const parts = [count === 0 ? "No events scheduled" : `${count} scheduled`];
        if (selectedDayKind) parts.unshift(selectedDayKind);
        if (selectedDate === data.today) parts.push("Today");
        return parts.join(" · ");
    });
    const selectedDateLabel = $derived.by(() => {
        const parsed = new Date(`${selectedDate}T12:00:00`);
        if (Number.isNaN(parsed.getTime())) return selectedDate;
        return formatDay(parsed, "EEEE, MMMM d, yyyy");
    });

    function selectDay(dayKey: string): void {
        selectedDate = dayKey;
        if (phone.current) {
            peekOpen = true;
            void tick().then(() => revealDay(dayKey));
        }
    }

    /** Scrolls the grid so the chosen day sits clear of the card. */
    function revealDay(dayKey: string): void {
        const cell = document.querySelector<HTMLElement>(`[data-calendar-day="${dayKey}"]`);
        const scroller = document.querySelector<HTMLElement>("[data-calendar-scroll]");
        const card = document.querySelector<HTMLElement>("[data-calendar-peek]");
        if (!cell || !scroller || !card) return;
        const overlap = cell.getBoundingClientRect().bottom - card.getBoundingClientRect().top + 8;
        if (overlap > 0) scroller.scrollBy({ top: overlap, behavior: "smooth" });
    }

    /** The next pinned event, for the phone top bar. */
    const nextPinned = $derived(pinnedEvents.find((event) => event.event_date >= data.today) ?? null);

    function defaultEventDate(): string {
        return selectedDate || data.today;
    }

    function prevMonth(): void {
        goToMonth(shiftMonthKey(shownMonth, -1));
    }

    function nextMonth(): void {
        goToMonth(shiftMonthKey(shownMonth, 1));
    }

    function chooseMonth(year: number, month: number): void {
        goToMonth(`${year}-${String(month).padStart(2, "0")}`);
    }

    function resetToToday(): void {
        goToToday();
    }

    function showAllSources(): void {
        if (hiddenSourceCount === 0) return;
        void saveSourcePreference({ hiddenGroups: [], hiddenSources: [] });
    }

    async function toggleSourceEntry(entryId: string): Promise<void> {
        if (preferenceSaving) return;
        const next = toggleCalendarMenuEntry(sources, activePreference, entryId);
        if (!next) return;
        await saveSourcePreference(next);
    }

    async function saveSourcePreference(
        next: CalendarSourcePreference,
    ): Promise<void> {
        const logId = eventLogFilename.value;
        if (!logId) return;
        preferenceSaving = true;
        pendingPreference = next;
        try {
            await setCalendarSourcePreference(logId, next);
            await invalidate("app:calendar");
            pendingPreference = null;
        } catch (cause) {
            pendingPreference = null;
            notify.error(
                cause instanceof Error
                    ? cause.message
                    : "Could not save the calendar filter",
            );
        } finally {
            preferenceSaving = false;
        }
    }

    function dayLabel(day: DateInfo, items: CalendarPointItem[], dayRanges: CalendarRangeItem[]): string {
        const labels = [formatDay(day.date, "EEEE, MMMM d, yyyy")];
        if (toLocalDateString(day.date) === data.today) labels.push("today");
        if (day.holidayName) labels.push(`public holiday, ${day.holidayName}`);
        else if (day.isWeekend) labels.push("weekend");
        else labels.push("working day");
        const count = items.length + dayRanges.length;
        if (count > 0) {
            labels.push(`${count} ${count === 1 ? "item" : "items"}`);
        }
        return labels.join(", ");
    }

    function rangeAriaLabel(range: CalendarRangeItem): string {
        const label = sourceByKey.get(range.sourceKey)?.label.toLowerCase() ?? range.sourceKey;
        return `${range.title}, ${label}`;
    }

    function itemSourceLabel(item: CalendarPointItem): string {
        return sourceByKey.get(item.sourceKey)?.label.toLowerCase() ?? item.sourceKey;
    }

    function itemAriaLabel(item: CalendarPointItem): string {
        const time = item.startTime || "All day";
        if (item.sourceKey === "event") {
            return `${item.title}, ${time}${item.pinned ? ", pinned" : ""}`;
        }
        const subtitle = item.subtitle ? `, ${item.subtitle}` : "";
        return `${item.title}, ${itemSourceLabel(item)}${subtitle}`;
    }

    function itemHref(item: CalendarPointItem, dayKey: string): string | null {
        const source = sourceByKey.get(item.sourceKey);
        if (!source) return null;
        const href = calendarItemHref({
            sourceKey: item.sourceKey,
            id: item.id,
            date: dayKey,
            entityName: source.entityName,
            params: item.params,
        });
        return href ? contextualHref(href, page.url) : null;
    }

    function rangeHref(range: CalendarRangeItem): string | null {
        const source = sourceByKey.get(range.sourceKey);
        if (!source) return null;
        const href = calendarItemHref({
            sourceKey: range.sourceKey,
            id: range.id,
            date: range.startDate,
            entityName: source.entityName,
            params: range.params,
        });
        return href ? contextualHref(href, page.url) : null;
    }

    async function openItem(item: CalendarPointItem): Promise<void> {
        if (item.sourceKey === "event") {
            const event = await queryDatabase((repositories) =>
                repositories.calendar.getCalendarEvent(item.id),
            );
            if (event) startEdit(event);
            return;
        }
        const href = itemHref(item, selectedDate);
        if (href) await goto(href);
    }

    function absoluteHref(href: string | null): string | undefined {
        if (!href) return undefined;
        const origin = typeof window === "undefined" ? "https://stor" : window.location.origin;
        try {
            return new URL(href, origin).href;
        } catch {
            return undefined;
        }
    }

    /**
     * The month in view, source-filtered, as ICS events. Export is
     * intentionally a download; subscribed feeds are served by the Worker.
     */
    function collectIcsEvents(range: CalendarRangeResult): IcsEventInput[] {
        const events: IcsEventInput[] = [];
        for (const day of range.days) {
            for (const item of day.items) {
                const source = sourceByKey.get(item.sourceKey);
                events.push({
                    uid: `${item.sourceKey}-${item.id}`,
                    title: item.title,
                    description: [item.subtitle, item.startTime].filter(Boolean).join(" · ") || undefined,
                    url: absoluteHref(itemHref(item, day.day)),
                    category: source?.label,
                    startDate: day.day,
                    startTime: item.startTime || undefined,
                    endTime: item.endTime || undefined,
                });
            }
        }
        for (const item of range.ranges) {
            const source = sourceByKey.get(item.sourceKey);
            events.push({
                uid: `${item.sourceKey}-${item.id}`,
                title: item.title,
                description: item.subtitle || undefined,
                url: absoluteHref(rangeHref(item)),
                category: source?.label,
                startDate: item.startDate,
                endDate: item.endDate,
            });
        }
        return events;
    }

    let exporting = $state(false);

    async function exportIcs(): Promise<void> {
        if (exporting) return;
        exporting = true;
        const month = shownMonth;
        try {
            const bounds = calendarMonthBounds(parseCalendarMonth(month));
            const range = await queryDatabase((repositories) =>
                repositories.calendar.getCalendarRange(bounds.startDate, bounds.endDateExclusive, storedPreference),
            );
            const events = collectIcsEvents(range);
            const content = serializeIcs(events, {
                name: tenant.title,
                uidDomain: typeof window === "undefined" ? "stor" : window.location.hostname,
            });
            const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `stor-calendar-${month}.ics`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
            notify.success(
                `Exported ${events.length} ${events.length === 1 ? "item" : "items"}`,
            );
        } catch (error) {
            console.error("Failed to export the calendar:", error);
            notify.error("Could not export the month");
        } finally {
            exporting = false;
        }
    }

    function startCreate(eventDate = defaultEventDate()): void {
        editingId = null;
        editingEvent = null;
        draft = emptyDraft(eventDate);
        errors = {};
        drawerOpen = true;
    }

    function startEdit(event: CalendarEvent): void {
        editingId = event.id;
        editingEvent = event;
        draft = {
            title: event.title,
            eventDate: event.event_date,
            startTime: event.start_time,
            notes: event.notes,
            pinned: Boolean(event.pinned),
        };
        errors = {};
        drawerOpen = true;
    }

    function eventPayload() {
        return {
            title: draft.title.trim(),
            eventDate: draft.eventDate,
            startTime: draft.startTime,
            notes: draft.notes.trim(),
            pinned: draft.pinned,
        };
    }

    async function saveEvent(submitEvent: SubmitEvent): Promise<void> {
        submitEvent.preventDefault();
        if (saving) return;
        errors = validateCalendarEventDraft(draft);
        if (Object.keys(errors).length > 0) return;
        saving = true;
        try {
            if (editingId) {
                const updateEvent: UpdateCalendarEventEvent = {
                    id: crypto.randomUUID(),
                    type: "CALENDAR_EVENT_UPDATED",
                    timestamp: Date.now(),
                    payload: { id: editingId, ...eventPayload() },
                };
                await executeLocalCommand(updateEvent);
                notify.success("Event updated");
            } else {
                const addEvent: AddCalendarEventEvent = {
                    id: crypto.randomUUID(),
                    type: "CALENDAR_EVENT_ADDED",
                    timestamp: Date.now(),
                    payload: { id: crypto.randomUUID(), ...eventPayload() },
                };
                await executeLocalCommand(addEvent);
                notify.success("Event added");
            }
            drawerOpen = false;
            await invalidate("app:calendar");
        } catch (error) {
            console.error("Failed to save calendar event:", error);
            notify.error("Could not save the event");
        } finally {
            saving = false;
        }
    }

    async function togglePin(event: CalendarEvent): Promise<void> {
        if (pinningId) return;
        pinningId = event.id;
        try {
            const updateEvent: UpdateCalendarEventEvent = {
                id: crypto.randomUUID(),
                type: "CALENDAR_EVENT_UPDATED",
                timestamp: Date.now(),
                payload: { id: event.id, pinned: !Boolean(event.pinned) },
            };
            await executeLocalCommand(updateEvent);
            await invalidate("app:calendar");
        } catch (error) {
            console.error("Failed to update calendar pin:", error);
            notify.error("Could not update the pin");
        } finally {
            pinningId = null;
        }
    }

    function requestDelete(id: string): void {
        drawerOpen = false;
        deleteId = id;
    }

    async function removeEvent(): Promise<void> {
        if (!deleteId) return;
        const id = deleteId;
        deleteId = null;
        editingEvent = null;
        try {
            const removeEvent: RemoveCalendarEventEvent = {
                id: crypto.randomUUID(),
                type: "CALENDAR_EVENT_REMOVED",
                timestamp: Date.now(),
                payload: { id },
            };
            await executeLocalCommand(removeEvent);
            notify.success("Event deleted");
            await invalidate("app:calendar");
        } catch (error) {
            console.error("Failed to delete calendar event:", error);
            notify.error("Could not delete the event");
        }
    }

    function handleCalendarKeydown(event: KeyboardEvent): void {
        if (event.target !== calendarControl) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            event.preventDefault();
            prevMonth();
        } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            nextMonth();
        } else if (event.key === "PageUp") {
            event.preventDefault();
            goToMonth(shiftMonthKey(shownMonth, -12));
        } else if (event.key === "PageDown") {
            event.preventDefault();
            goToMonth(shiftMonthKey(shownMonth, 12));
        } else if (event.key === "Home") {
            event.preventDefault();
            resetToToday();
        }
    }

    const MAX_DAY_CHIPS = 2;

    onMount(() => {
        // A keyboard user lands in the grid; on a phone the focus ring would only frame it in red.
        if (window.matchMedia("(pointer: fine)").matches) void focusCalendar();
    });
</script>

<svelte:head><title>{monthLabel} | Calendar | stor</title></svelte:head>
<PageDataStatus resource={resource} />

{#snippet dayAgenda()}
    {#if !selectedWeek}
                        <DataPlaceholder rows={2} label="Loading agenda" />
                    {:else if selectedDayItems.length === 0 && selectedDayRanges.length === 0}
                <p class="rounded-xl bg-[var(--stor-surface-muted)] px-3 py-4 text-sm text-[var(--stor-muted-text)]">Nothing scheduled for this day. Select another day or add an event.</p>
                    {:else}
                        {#each selectedDayItems as item (item.sourceKey + item.id)}
                            {@const presentation = calendarSourcePresentation(item.sourceKey)}
                            {@const Icon = calendarSourceIcon(presentation.icon)}
                            {@const href = itemHref(item, selectedDate)}
                            {#if item.sourceKey === "event"}
                                <button
                                    type="button"
                                    onclick={() => runCommandAction(() => void openItem(item))}
                                    class="flex w-full items-center gap-3 rounded-xl bg-transparent px-1 py-3 text-left transition hover:border-[var(--stor-field-border)]"
                                    aria-label={itemAriaLabel(item)}
                                >
                            <Icon class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)]" />
                                    <span class="min-w-0 flex-1">
                                <span class="block truncate text-sm font-semibold text-[var(--stor-ink)]">{item.title}</span>
                                <span class="mt-0.5 block text-xs text-[var(--stor-muted-text)]">{item.startTime || "All day"}{item.pinned ? " · Pinned" : ""}</span>
                                    </span>
                            {#if item.pinned}<IconPin class="h-4 w-4 shrink-0 text-[var(--stor-accent-text)]" />{/if}
                                </button>
                            {:else if href}
                                <a
                                    href={href}
                                    class="flex w-full items-center gap-3 rounded-xl border border-[var(--stor-border)] px-3 py-2.5 text-left"
                                    aria-label={itemAriaLabel(item)}
                                >
                            <Icon class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)]" />
                                    <span class="min-w-0 flex-1">
                                <span class="block truncate text-sm font-semibold text-[var(--stor-ink)]">{item.title}</span>
                                <span class="mt-0.5 block text-xs text-[var(--stor-muted-text)]">{itemSourceLabel(item)}{item.subtitle ? ` · ${item.subtitle}` : ""}{item.startTime ? ` · ${item.startTime}` : ""}</span>
                                    </span>
                                </a>
                            {/if}
                        {/each}
                        {#each selectedDayRanges as range (range.sourceKey + range.id)}
                            {@const presentation = calendarSourcePresentation(range.sourceKey)}
                            {@const Icon = calendarSourceIcon(presentation.icon)}
                            {@const href = rangeHref(range)}
                            {@const label = sourceByKey.get(range.sourceKey)?.label.toLowerCase() ?? range.sourceKey}
                            {#if href}
                                <a
                                    href={href}
                                    class="flex w-full items-center gap-3 rounded-xl border border-[var(--stor-border)] px-3 py-2.5 text-left"
                                    aria-label={`${range.title}, ${label}`}
                                >
                            <Icon class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)]" />
                                    <span class="min-w-0 flex-1">
                                <span class="block truncate text-sm font-semibold text-[var(--stor-ink)]">{range.title}</span>
                                <span class="mt-0.5 block text-xs text-[var(--stor-muted-text)]">{label} · {formatDay(new Date(`${range.startDate}T12:00:00`), "MMM d")} – {formatDay(new Date(`${range.endDate}T12:00:00`), "MMM d")}</span>
                                    </span>
                                </a>
                            {/if}
                        {/each}
                    {/if}
{/snippet}

{#snippet pinnedPanel()}
    <section class="stor-panel min-w-0 p-[var(--stor-panel-padding)]" aria-labelledby="pinned-events-heading">
        <div class="flex items-center justify-between gap-3">
            <div>
                <h2 id="pinned-events-heading" class="font-semibold text-[var(--stor-ink)]">Pinned events</h2>
                <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">Important dates coming up</p>
            </div>
            <IconPin class="h-5 w-5 text-[var(--stor-accent-text)]" />
        </div>
        {#if displayResource.loading}<DataPlaceholder rows={2} />{:else if pinnedEvents.length > 0}
            <div class="mt-3 space-y-4">
                {#each pinnedEvents as event (event.id)}
                    <article class="min-w-0 py-2">
                        <div class="flex items-start justify-between gap-2">
                            <button
                                type="button"
                                class="min-w-0 flex-1 text-left"
                                onclick={() => runCommandAction(() => startEdit(event))}
                            >
                                <span class="block truncate text-sm font-semibold text-[var(--stor-ink)]">{event.title}</span>
                                <span class="mt-1 block text-xs text-[var(--stor-muted-text)]">
                                    {formatDay(new Date(`${event.event_date}T12:00:00`), "MMM d, yyyy")} · {event.start_time || "All day"}
                                </span>
                            </button>
                            <CommandOnly>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    class="-mr-1 -mt-1 h-8 w-8"
                                    aria-label={`Unpin ${event.title}`}
                                    disabled={pinningId === event.id}
                                    onclick={() => togglePin(event)}
                                ><IconPin class="h-4 w-4" /></Button>
                            </CommandOnly>
                        </div>
                        <div class="mt-3 text-sm font-semibold text-[var(--stor-accent-strong)]">
                            {describeEventCountdown(daysUntilCalendarEvent(event.event_date, boundaryNow))}
                        </div>
                    </article>
                {/each}
            </div>
        {:else}
            <p class="mt-3 rounded-xl bg-[var(--stor-surface-muted)] px-3 py-4 text-sm text-[var(--stor-muted-text)]">
                Pin an event to keep its countdown here.
            </p>
        {/if}
    </section>
{/snippet}

{#snippet sourcesMenu()}
        {#if showSourceMenu || compactHeader.current}
            <Popover.Root>
                <Popover.Trigger
                    class="inline-flex h-11 items-center gap-1.5 rounded-xl bg-[var(--stor-surface-raised)] px-3 text-sm font-semibold max-sm:w-11 max-sm:justify-center max-sm:px-0 text-[var(--stor-ink)] shadow-[var(--stor-shadow-sm)] transition hover:bg-[var(--stor-surface-muted)] hover:shadow-[var(--stor-shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] sm:h-9"
                    aria-label={`Sources${hiddenSourceCount > 0 ? `, ${hiddenSourceCount} hidden` : ""}`}
                >
                    <IconFilter class="h-5 w-5 shrink-0 sm:hidden" />
                    <span class="max-sm:hidden">Sources</span>
                    {#if hiddenSourceCount > 0}<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--stor-accent)] max-sm:absolute max-sm:ml-6 max-sm:-mt-6" aria-hidden="true"></span>{/if}
                    <IconChevronDown class="h-4 w-4 shrink-0 max-sm:hidden" />
                </Popover.Trigger>
                <Popover.Portal>
                    <Popover.Content
                        side="bottom"
                        align="end"
                        sideOffset={8}
                        class="stor-menu z-[var(--stor-layer-menu)] w-64 p-2 outline-none"
                    >
                        {#if showSourceMenu}
                        <p class="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">Sources</p>
                        <ul>
                            {#each sourceMenuEntries as entry (entry.id)}
                                {@const visible = isCalendarMenuEntryVisible(entry, effectivePreference)}
                                {@const Icon = calendarSourceIcon(entry.icon)}
                                <li>
                                    <label class="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl px-2.5 text-sm text-[var(--stor-ink)] transition-colors hover:bg-[var(--stor-surface-muted)] sm:min-h-9">
                                        <Checkbox
                                            checked={visible}
                                            disabled={preferenceSaving}
                                            onCheckedChange={() => void toggleSourceEntry(entry.id)}
                                            aria-label={entry.label}
                                        />
                                        <Icon class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)]" />
                                        <span class="truncate">{entry.label}</span>
                                    </label>
                                </li>
                            {/each}
                        </ul>
                        {#if hiddenSourceCount > 0}
                            <div class="mt-1 border-t border-[var(--stor-border)] pt-1">
                                <button
                                    type="button"
                                    class="flex min-h-11 w-full items-center rounded-xl px-2.5 text-left text-sm font-semibold text-[var(--stor-accent-text)] transition-colors hover:bg-[var(--stor-surface-muted)] sm:min-h-9"
                                    onclick={showAllSources}
                                >Show all sources</button>
                            </div>
                        {/if}
                        {/if}
                        {#if compactHeader.current}
                            <CommandOnly>
                                <div class="{showSourceMenu ? 'mt-1 border-t border-[var(--stor-border)] pt-1' : ''}">
                                    <Popover.Close
                                        class="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm text-[var(--stor-ink)] transition-colors hover:bg-[var(--stor-surface-muted)]"
                                        onclick={() => feedsOpen = true}
                                    ><IconRss class="h-4 w-4 text-[var(--stor-muted-text)]" />Feeds</Popover.Close>
                                    <Popover.Close
                                        class="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm text-[var(--stor-ink)] transition-colors hover:bg-[var(--stor-surface-muted)] disabled:opacity-50"
                                        onclick={() => void exportIcs()}
                                        disabled={displayResource.loading || exporting}
                                    ><IconExport class="h-4 w-4 text-[var(--stor-muted-text)]" />Export .ics</Popover.Close>
                                </div>
                            </CommandOnly>
                        {/if}
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>
        {/if}
{/snippet}

{#snippet weekRow(week: string, loaded: CalendarWeek | undefined)}
    <div class="stor-calendar-week" role="row" style="--stor-cal-bands: {loaded?.bands.length ?? 0}">
        {#each weekDays(week) as dayKey, col (dayKey)}
            {@const info = dayInfo(dayKey)}
            {@const cell = loaded?.days[col]}
            {@const cellItems = cell?.items ?? []}
            {@const cellRanges = loaded && cell ? cell.lanes.map((lane) => loaded.bands[lane].range) : []}
            {@const hasItems = cellItems.length + cellRanges.length > 0}
            {@const today = dayKey === data.today}
            {@const selected = dayKey === selectedDate}
            <div
                role="gridcell"
                data-calendar-day={dayKey}
                aria-label={dayLabel(info, cellItems, cellRanges)}
                aria-selected={selected}
                style="grid-column: {col + 1}; grid-row: 1"
                class="stor-calendar-day group hover:bg-[var(--stor-surface-hover)]"
                onclick={() => { if (phone.current) selectDay(dayKey); }}
                class:stor-calendar-out={monthKeyOf(dayKey) !== shownMonth}
            >
                <button
                    type="button"
                    onclick={() => selectDay(dayKey)}
                    aria-label={`${formatDay(info.date, "EEEE, MMMM d, yyyy")}${today ? ", today" : ""}${selected ? ", selected" : ""}${hasItems ? `, ${cellItems.length + cellRanges.length} items` : ", no events"}`}
                    aria-pressed={selected}
                    class="stor-calendar-select flex w-full items-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
                >
                    <span aria-current={today ? "date" : undefined} data-today={today ? "" : undefined} class="stor-calendar-date flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium {selected ? 'bg-[var(--stor-action)] text-[var(--stor-action-text)]' : info.isWeekend || info.isHoliday ? 'text-[var(--stor-muted-text)]' : 'text-[var(--stor-ink)]'}">{info.date.getDate()}</span>
                    {#if dayKey.endsWith("-01")}<span class="ml-1 hidden text-[10.5px] font-semibold uppercase tracking-wide text-[var(--stor-muted-text)] sm:inline" aria-hidden="true">{formatDay(info.date, "MMM")}</span>{/if}
                </button>
                <div class="mt-1 hidden items-center justify-center gap-1 md:flex lg:hidden" aria-hidden="true">
                    {#each cellItems.slice(0, 3) as item (item.sourceKey + item.id)}
                        <span class="h-1.5 w-1.5 rounded-full {TONE_DOTS[calendarSourcePresentation(item.sourceKey).tone]}"></span>
                    {/each}
                    {#if cellRanges.length > 0}
                        <span class="h-1.5 w-1.5 rounded-full {TONE_DOTS[calendarSourcePresentation(cellRanges[0].sourceKey).tone]}"></span>
                    {/if}
                    {#if hasItems}
                        <span class="text-[10.5px] font-semibold tabular-nums text-[var(--stor-muted-text)]">{cellItems.length + cellRanges.length}</span>
                    {/if}
                </div>

                <!-- Phones name the day's events like the desktop; a tap anywhere in the day opens it. -->
                <div class="mt-1 hidden space-y-1 max-md:block max-md:pointer-events-none lg:block">
                    {#if info.holidayName}
                        <span class="block truncate rounded-lg bg-[var(--stor-surface-muted)] px-1.5 py-1 text-[10.5px] font-semibold text-[var(--stor-muted-text)]" title={info.holidayName}>{info.holidayName}</span>
                    {/if}
                    {#if !loaded}<div class="mt-2 h-3 rounded bg-[var(--stor-surface-muted)] motion-safe:animate-pulse" aria-label="Loading events"></div>{/if}
                    {#each cellItems.slice(0, MAX_DAY_CHIPS) as item (item.sourceKey + item.id)}
                        {@const presentation = calendarSourcePresentation(item.sourceKey)}
                        {@const href = itemHref(item, dayKey)}
                        {@const chipClass = `flex w-full min-w-0 items-center gap-1 rounded-[6px] px-1.5 py-1 text-left text-[10.5px] max-md:rounded-[5px] max-md:px-1 max-md:py-0.5 max-md:text-[10px] max-md:tracking-[-0.01em] transition hover:bg-[var(--stor-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] bg-[var(--stor-surface-muted)] text-[var(--stor-ink)]`}
                        {#if item.sourceKey === "event"}
                            <button
                                type="button"
                                class={chipClass}
                                onclick={() => runCommandAction(() => void openItem(item))}
                                aria-label={itemAriaLabel(item)}
                            >
                                <span class="h-1.5 w-1.5 shrink-0 rounded-full {TONE_DOTS[presentation.tone]}" aria-hidden="true"></span>
                                {#if item.startTime}<span class="hidden shrink-0 font-mono text-[var(--stor-muted-text)] xl:inline">{item.startTime}</span>{/if}
                                <span class="min-w-0 flex-1 truncate font-semibold">{item.title}</span>
                                {#if item.pinned}<IconPin class="h-3 w-3 shrink-0 text-[var(--stor-accent-text)]" />{/if}
                            </button>
                        {:else if href}
                            <a
                                href={href}
                                class={chipClass}
                                aria-label={itemAriaLabel(item)}
                            ><span class="h-1.5 w-1.5 shrink-0 rounded-full {TONE_DOTS[presentation.tone]}" aria-hidden="true"></span><span class="min-w-0 flex-1 truncate font-semibold">{item.title}</span></a>
                        {:else}
                            <span class={chipClass} aria-label={itemAriaLabel(item)}>
                                <span class="h-1.5 w-1.5 shrink-0 rounded-full {TONE_DOTS[presentation.tone]}" aria-hidden="true"></span>
                                <span class="min-w-0 flex-1 truncate font-semibold">{item.title}</span>
                            </span>
                        {/if}
                    {/each}
                    {#if cellItems.length > MAX_DAY_CHIPS}
                        <button
                            type="button"
                            class="w-full rounded-lg px-1.5 py-0.5 text-left text-[10.5px] font-semibold text-[var(--stor-muted-text)] hover:bg-[var(--stor-surface-hover)]"
                            onclick={() => selectDay(dayKey)}
                        >+{cellItems.length - MAX_DAY_CHIPS} more</button>
                    {/if}
                </div>
                <CommandOnly>
                    <button
                        type="button"
                        aria-label={`Add event on ${formatDay(info.date, "EEEE, MMMM d, yyyy")}`}
                        title="Add event on this day"
                        onclick={() => startCreate(dayKey)}
                        class="absolute bottom-1 right-0 hidden h-8 w-8 items-center justify-center rounded-md text-[var(--stor-muted-text)] hover:bg-[var(--stor-accent-soft)] hover:text-[var(--stor-accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] opacity-0 group-hover:opacity-100 focus:opacity-100 lg:inline-flex"
                    ><IconPlus class="h-3.5 w-3.5" /></button>
                </CommandOnly>
            </div>
        {/each}

        {#each loaded?.bands ?? [] as band (band.range.sourceKey + band.range.id)}
            {@const href = rangeHref(band.range)}
            {@const presentation = calendarSourcePresentation(band.range.sourceKey)}
            <a
                class="stor-calendar-band {TONE_CLASSES[presentation.tone]}"
                style="grid-column: {band.startCol + 1} / {band.endCol + 2}; grid-row: 1; --stor-cal-lane: {band.lane}"
                href={href ?? undefined}
                aria-label={rangeAriaLabel(band.range)}
            >
                <span class="truncate">{band.range.title}</span>
            </a>
        {/each}
    </div>
{/snippet}

<div class="stor-calendar-page stor-page w-full p-2.5 max-md:flex max-md:h-full max-md:flex-col sm:p-3 lg:h-full">
    <PageHeader title="Calendar" class="max-md:sr-only">
        {#snippet tabs()}
            <MonthNavigator year={currentYear} month={currentMonth + 1} currentYear={boundaryNow.getFullYear()} currentMonth={boundaryNow.getMonth() + 1} subtitle={`${workingDayCount} working days`} onNavigate={chooseMonth} compact />
        {/snippet}
        {@render sourcesMenu()}
        <CommandOnly>
            <Button
                size="sm"
                variant="secondary"
                class="hidden lg:inline-flex"
                onclick={() => feedsOpen = true}
            ><IconRss class="h-4 w-4" />Feeds</Button>

            <Button
                size="sm"
                variant="secondary"
                class="hidden lg:inline-flex"
                onclick={() => void exportIcs()}
                disabled={displayResource.loading || exporting}
            ><IconExport class="h-4 w-4" />Export .ics</Button>

            <Button
                size="sm"
                class="hidden lg:inline-flex"
                data-stor-new
                shortcut="N"
                onclick={() => startCreate()}
            ><IconPlus class="h-4 w-4" />Add event</Button>
        </CommandOnly>
    </PageHeader>
    <p id="calendar-keyboard-help" class="sr-only">
        Use arrow keys to move by month, Page Up and Page Down to move by year,
        and Home to return to today.
    </p>

    <div class="stor-calendar-layout">
        <section
            bind:this={calendarControl}
            tabindex="0"
            onkeydown={handleCalendarKeydown}
            aria-label={`${monthLabel} calendar`}
            aria-describedby="calendar-keyboard-help"
            class="stor-panel stor-calendar-panel min-w-0 p-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] lg:p-4"
            data-under-action={phone.current ? "" : undefined}
        >
        <!-- Phones: the month in view and the sources head the grid; the top bar names the page. -->
        <div class="-mx-2 -mt-2 mb-1 flex h-12 shrink-0 items-center gap-1.5 border-b border-[color-mix(in_srgb,var(--stor-border)_62%,transparent)] pl-2 pr-1 md:hidden">
            <MonthNavigator year={currentYear} month={currentMonth + 1} currentYear={boundaryNow.getFullYear()} currentMonth={boundaryNow.getMonth() + 1} onNavigate={chooseMonth} compact phoneArrows={false} class="min-w-0" />
            <div class="ml-auto">{@render sourcesMenu()}</div>
        </div>
        <div class="stor-calendar-grid" role="grid" aria-label={`${monthLabel} days`}>
            <div class="stor-calendar-week stor-calendar-header" role="row">
                    {#each ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as dayName}
                    <div role="columnheader" class="px-0.5 py-2 text-center text-xs font-medium text-[var(--stor-muted-text)] sm:px-2.5 sm:text-xs">{dayName}</div>
                    {/each}
                </div>
                <div class="stor-calendar-weeks">
                    <!-- The weeks open where the applied data says and read with its source filter, so they wait for it. -->
                    {#if hasPaintedMonth}
                        <EndlessList
                            bind:this={list}
                            axis={axis}
                            store={weeks}
                            opening={monthTarget(shownMonth)}
                            estimate={weekEstimate}
                            revision={revision}
                            home={todayTarget}
                            pick={pick}
                            item={weekRow}
                            onVisibleChange={(position) => followVisible(position.at)}
                            class="stor-calendar-scroller"
                            data-calendar-scroll
                        />
                    {:else}
                        <DataPlaceholder rows={6} label="Loading calendar" />
                    {/if}
                </div>
            </div>
        </section>

        <aside class="stor-calendar-agendas max-md:hidden">
    <section class="stor-panel p-[var(--stor-panel-padding)]" aria-labelledby="agenda-heading">
        <div class="flex flex-wrap items-center justify-between gap-2">
                    <div>
                <h2 id="agenda-heading" class="font-semibold text-[var(--stor-ink)]">{selectedDateLabel}</h2>
                <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">{selectedDaySummary}</p>
                    </div>
                </div>
                <div class="mt-3 space-y-2">
                    {@render dayAgenda()}
                </div>
            </section>

    <!-- Phones read the day, then what is pinned; the month's working-day figures come last. -->
    <CalendarMonthSummary
        class="order-last lg:order-first"
        year={currentYear}
        monthIndex={currentMonth}
        today={data.today}
        counts={monthCounts}
        sourceLabel={(sourceKey) => sourceByKey.get(sourceKey)?.label ?? sourceKey}
        loading={countsLoading}
    />

    {@render pinnedPanel()}
    </aside>
    </div>
</div>

<MobilePageAction hideWhenModalOpen isModalOpen={drawerOpen} hidden={peekOpen && phone.current}>
    <Button class="text-[15px]" onclick={() => startCreate(selectedDate)}>
        <IconPlus class="h-5 w-5" /> <span class="stor-action-label">Add event</span>
    </Button>
</MobilePageAction>

{#if peekOpen && phone.current && selectedDate}
    <!-- The day's agenda above the dock; the grid stays live above it, so another day switches it. -->
    <section
        class="stor-sheet fixed inset-x-2.5 bottom-[calc(var(--stor-mobile-bottom-inset)+var(--stor-mobile-nav-height)+8px)] z-40 flex max-h-[42dvh] flex-col overflow-hidden rounded-[22px] md:hidden"
        aria-label={selectedDateLabel}
        aria-live="polite"
        data-calendar-peek
    >
        <header class="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
            <div class="min-w-0 flex-1">
                <h2 class="stor-serif-title truncate text-[19px] text-[var(--stor-ink)]">{formatDay(new Date(`${selectedDate}T12:00:00`), "EEEE d MMMM")}</h2>
                <p class="truncate text-xs text-[var(--stor-muted-text)]">{selectedDaySummary}</p>
            </div>
            <CommandOnly>
                <Button size="sm" class="h-9 rounded-full" onclick={() => startCreate(selectedDate)}><IconPlus class="h-4 w-4" /> Add</Button>
            </CommandOnly>
            <button type="button" class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--stor-surface-muted)] text-[var(--stor-muted-text)]" aria-label="Close the day" onclick={() => (peekOpen = false)}><IconClose class="h-5 w-5" /></button>
        </header>
        <div class="min-h-0 space-y-2 overflow-y-auto px-3 pb-3">{@render dayAgenda()}</div>
    </section>
{/if}

<PhoneGlance
    label={nextPinned ? `Pinned · ${describeEventCountdown(daysUntilCalendarEvent(nextPinned.event_date, boundaryNow)).toLowerCase()}` : monthLabel}
    value={nextPinned ? nextPinned.title : `${workingDayCount} working days`}
    title={monthLabel}
>
    <div class="flex flex-col gap-[var(--stor-section-gap)]">
        <CalendarMonthSummary
            year={currentYear}
            monthIndex={currentMonth}
            today={data.today}
            counts={monthCounts}
            sourceLabel={(sourceKey) => sourceByKey.get(sourceKey)?.label ?? sourceKey}
            loading={countsLoading}
        />
        {@render pinnedPanel()}
    </div>
</PhoneGlance>

<CommandDrawer show={drawerOpen} title={editingId ? "Edit event" : "Add event"} description="Add a date, an optional time, and anything you want to remember." onClose={() => drawerOpen = false}>
    <form id={drawerFormId0} class="space-y-4" onsubmit={saveEvent}>
        <Field label="Event title" htmlFor="calendar-event-title" required error={errors.title}>
            <Input id="calendar-event-title" bind:value={draft.title} placeholder="e.g. Project launch" autofocus />
        </Field>
        <div class="grid gap-3 sm:grid-cols-2">
            <Field label="Date" htmlFor="calendar-event-date" required error={errors.eventDate}>
                <DatePicker id="calendar-event-date" bind:value={draft.eventDate} placeholder="Choose event date" />
            </Field>
            <Field label="Time" htmlFor="calendar-event-time" hint={phone.current ? "Blank is all day" : "Optional · leave blank for all day"} error={errors.startTime}>
                <Input id="calendar-event-time" type="time" bind:value={draft.startTime} />
            </Field>
        </div>
        {#if phone.current}
            <!-- Phones: the pin as a switch; notes fold until asked for (or already written). -->
            <Switch checked={draft.pinned} label="Pin this event" hint="Count down to it on Calendar" onCheckedChange={(checked) => (draft.pinned = checked)} />
            {#if eventNotesOpen || draft.notes}
                <Textarea id="calendar-event-notes" bind:value={draft.notes} placeholder="Notes" />
            {:else}
                <button type="button" class="flex items-center gap-1 text-sm font-semibold text-[var(--stor-accent-text)]" onclick={() => (eventNotesOpen = true)}>Notes<IconChevronDown class="h-4 w-4" /></button>
            {/if}
        {:else}
        <Field label="Notes" htmlFor="calendar-event-notes" hint="Optional">
            <Textarea id="calendar-event-notes" bind:value={draft.notes} placeholder="Add details or context" />
        </Field>
        <label class="flex items-start gap-3 rounded-xl bg-[var(--stor-surface-muted)] p-3">
            <Checkbox checked={draft.pinned} onCheckedChange={(checked) => draft.pinned = Boolean(checked)} aria-label="Pin event" />
            <span>
                <span class="block text-sm font-semibold text-[var(--stor-ink)]">Pin this event</span>
                <span class="mt-0.5 block text-xs text-[var(--stor-muted-text)]">Show its countdown on Calendar and Today.</span>
            </span>
        </label>
        {/if}
        </form>
    {#snippet footer()}
        <div class="mr-auto">
            {#if editingId}
                <Button
                    variant="ghost"
                    class="text-[var(--stor-negative)] hover:bg-[var(--stor-negative-soft)] hover:text-[var(--stor-negative)]"
                    onclick={() => requestDelete(editingId!)}
                ><IconDelete class="h-4 w-4" />Delete</Button>
            {/if}
        </div>

        <Button
            variant="secondary"
            onclick={() => drawerOpen = false}
        >Cancel</Button>

        <Button
            type="submit"
            form={drawerFormId0}
            disabled={saving}
        >{saving ? "Saving…" : editingId ? "Save changes" : "Add event"}</Button>
    {/snippet}
</CommandDrawer>

<CommandConfirmDialog
    show={deleteId !== null}
    title="Delete event?"
    message={editingEvent ? `“${editingEvent.title}” will be removed from the calendar.` : "This event will be removed from the calendar."}
    onConfirm={removeEvent}
    onCancel={() => deleteId = null}
/>

<CalendarFeedsDrawer bind:show={feedsOpen} sources={sources} />

<style>
    .stor-calendar-header {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        gap: 2px;
    }
    .stor-calendar-week {
        position: relative;
        display: grid;
        grid-column: 1 / -1;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        gap: var(--stor-cal-gap);
        padding-bottom: var(--stor-cal-gap);
        --stor-cal-gap: 2px;
        --stor-cal-head: 0px;
        --stor-cal-band-h: 0px;
    }
    .stor-calendar-band {
        display: none;
    }
    @media (min-width: 1024px) {
        .stor-calendar-header {
            gap: 8px;
        }
        .stor-calendar-week {
            --stor-cal-gap: 8px;
            --stor-cal-head: 40px;
            --stor-cal-band-h: 20px;
        }
        .stor-calendar-week .stor-calendar-day {
            padding-top: calc(
                var(--stor-cal-head, 0px) +
                    var(--stor-cal-bands, 0) * var(--stor-cal-band-h, 0px)
            );
        }
        .stor-calendar-band {
            display: flex;
            align-items: center;
            align-self: start;
            z-index: 2;
            height: calc(var(--stor-cal-band-h) - 2px);
            margin-top: calc(
                var(--stor-cal-head) + var(--stor-cal-lane, 0) * var(--stor-cal-band-h)
            );
            padding: 0 6px;
            border-radius: 6px;
            font-size: 0.65rem;
            font-weight: 600;
            overflow: hidden;
            transition: filter 160ms ease;
        }
        .stor-calendar-band:hover {
            filter: brightness(0.97);
        }
        .stor-calendar-header {
            padding-top: 0;
        }
    }
</style>
