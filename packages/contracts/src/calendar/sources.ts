/**
 * Presentation registry for calendar sources.
 *
 * Icons, tones, ordering, and deep links are declared on each static entity's
 * calendar source (`presentation`), so a module brings its own. This module
 * only indexes them by source key. Unknown keys — dynamic entities — fall back
 * to neutral presentation and the entity list page.
 *
 * Icon values are mdi icon names resolved by the calendar UI (see
 * `packages/shell/src/components/calendar/source-icons.ts`), so this module stays free of
 * Svelte and `~icons/*` imports.
 */

import { ENTITY_DEFINITIONS } from '../event/entity-definitions.js';
import { calendarSourceKey, normalizeCalendarSources, type CalendarSourcePresentation } from './config';
import type { CalendarItemParams } from './types';

export type { CalendarSourcePresentation, CalendarTone } from './config';

/** Presentation each static definition declares on its calendar sources, by source key. */
const PRESENTATION = new Map<string, CalendarSourcePresentation>(
    ENTITY_DEFINITIONS.flatMap((definition) => normalizeCalendarSources(definition.calendar).flatMap((source) =>
        source.presentation ? [[calendarSourceKey(definition.name, source), source.presentation] as const] : [])),
);

const FALLBACK: CalendarSourcePresentation = {
    icon: 'calendar-blank-outline',
    tone: 'accent',
    href: '/entities/{entity}',
    rank: 100,
};

export function calendarSourcePresentation(
    sourceKey: string,
): CalendarSourcePresentation {
    return PRESENTATION.get(sourceKey) ?? FALLBACK;
}

export interface CalendarLinkInput {
    sourceKey: string;
    id: string;
    /** Item start day (`YYYY-MM-DD`). */
    date: string;
    entityName: string;
    params?: CalendarItemParams;
}

/**
 * Resolve the registry href template for one item. Returns null when the
 * registry has no link (calendar events open in the edit drawer instead).
 */
export function calendarItemHref(input: CalendarLinkInput): string | null {
    const template = calendarSourcePresentation(input.sourceKey).href;
    if (!template) return null;
    return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
        switch (name) {
            case 'id':
                return encodeURIComponent(input.id);
            case 'date':
                return input.date;
            case 'year':
                return input.date.slice(0, 4);
            case 'month':
                return input.date.slice(5, 7);
            case 'entity':
                return encodeURIComponent(input.entityName);
            default:
                return encodeURIComponent(input.params?.[name] ?? '');
        }
    });
}
