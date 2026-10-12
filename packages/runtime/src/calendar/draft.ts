/**
 * Draft helpers for the dynamic entity editor's calendar section.
 *
 * The editor edits one calendar date per dynamic entity (the stored config is
 * still an array, so hand-written events may declare several). These helpers
 * convert between the stored sources and the flat form state, and validate
 * against the entity's field list.
 */

import {
    validateCalendarConfig,
    type CalendarFieldLike,
    type EntityCalendarSource,
} from '@hearthlog/contracts/calendar/config';

export interface CalendarSourceDraft {
    enabled: boolean;
    dateField: string;
    endDateField: string;
    timeField: string;
    titleField: string;
    label: string;
}

export function emptyCalendarDraft(): CalendarSourceDraft {
    return {
        enabled: false,
        dateField: '',
        endDateField: '',
        timeField: '',
        titleField: '',
        label: '',
    };
}

export function draftFromCalendar(
    calendar: readonly EntityCalendarSource[] | null | undefined,
): CalendarSourceDraft {
    const source = calendar?.[0];
    if (!source) return emptyCalendarDraft();
    return {
        enabled: true,
        dateField: source.dateField,
        endDateField: source.endDateField ?? '',
        timeField: source.timeField ?? '',
        titleField: source.titleField ?? '',
        label: source.label,
    };
}

export function calendarFromDraft(
    draft: CalendarSourceDraft,
): EntityCalendarSource[] {
    if (!draft.enabled || !draft.dateField) return [];
    return [
        {
            dateField: draft.dateField,
            label: draft.label.trim() || 'Event',
            ...(draft.endDateField ? { endDateField: draft.endDateField } : {}),
            ...(draft.timeField ? { timeField: draft.timeField } : {}),
            ...(draft.titleField ? { titleField: draft.titleField } : {}),
        },
    ];
}

/**
 * First validation error for the draft, or null when it is valid. Disabled or
 * empty drafts are always valid (the entity simply has no calendar date).
 */
export function calendarDraftError(
    draft: CalendarSourceDraft,
    fields: readonly CalendarFieldLike[],
): string | null {
    if (!draft.enabled) return null;
    if (!draft.dateField) return 'Choose a date field';
    if (!draft.label.trim()) return 'Add a calendar label';
    const errors = validateCalendarConfig(
        'draft',
        calendarFromDraft(draft),
        fields,
        { parentTables: new Set<string>() },
    );
    return errors[0] ?? null;
}
