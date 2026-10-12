/**
 * Icon assignments for feature navigation, shared by the navigation shell.
 *
 * Kept separate from the feature registry so the registry stays free of
 * browser-only imports (Node build scripts import it directly).
 */

import type { Component } from "svelte";
import IconCalendar from "~icons/mdi/calendar-month-outline";
import IconCode from "~icons/mdi/code-tags";
import IconDatabase from "~icons/mdi/database-cog-outline";
import type { FeatureId } from "@hearthlog/contracts/features/registry";
import { MODULE_ICONS } from "#generated/module-icons";

export const FEATURE_ICONS: Record<FeatureId, Component> = {
    ...MODULE_ICONS,
    calendar: IconCalendar,
};

/** The policy-scoped Entities viewer (not a feature). */
export const ENTITIES_ICON: Component = IconDatabase;

/** The policy-scoped Developer page (not a feature). */
export const DEVELOPER_ICON: Component = IconCode;
