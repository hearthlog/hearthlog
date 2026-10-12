/**
 * Maps the string icon names from the calendar presentation registry to
 * `~icons` components. Keeping this mapping here lets `sources.ts` stay free
 * of Svelte imports (the frontend Worker imports it for ICS links).
 */

import type { Component } from 'svelte';
import IconCalendarBlank from '~icons/mdi/calendar-blank-outline';
import { MODULE_CALENDAR_ICONS } from '#generated/module-icons';

const ICONS: Record<string, Component> = {
    'calendar-blank-outline': IconCalendarBlank,
    // Icons modules use on their calendar sources (their manifests list them).
    ...MODULE_CALENDAR_ICONS,
};

export function calendarSourceIcon(name: string): Component {
    return ICONS[name] ?? IconCalendarBlank;
}
