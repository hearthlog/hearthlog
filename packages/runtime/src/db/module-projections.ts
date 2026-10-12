/**
 * The projection ledger: which version of each module's read model the local
 * database holds. A module raises `projectionVersion` in its manifest when its
 * tables or their meaning change; the next load rebuilds from raw events.
 *
 * A database that predates the ledger (schema 41) holds every module's tables
 * at the baseline, version 1.
 */

import { MODULE_ENTITY_DEFINITIONS, MODULE_PROJECTIONS } from '#generated/modules';

export const BASELINE_PROJECTION_VERSION = 1;

export interface ProjectionRow {
    module_id: string;
    projection_version: number;
}

/** The modules a tenant runs (at least one enabled feature) and the version each should have. */
export function currentProjections(features: ReadonlySet<string>): Array<{ module: string; version: number }> {
    return MODULE_PROJECTIONS
        .filter((projection) => projection.features.some((feature) => features.has(feature)))
        .map(({ module, version }) => ({ module, version }));
}

/** Modules whose stored projection differs from the running code; a missing row counts as the baseline. */
export function staleModules(
    stored: readonly ProjectionRow[],
    current: ReadonlyArray<{ module: string; version: number }>,
): string[] {
    const versions = new Map(stored.map((row) => [row.module_id, row.projection_version]));
    return current
        .filter(({ module, version }) => (versions.get(module) ?? BASELINE_PROJECTION_VERSION) !== version)
        .map(({ module }) => module);
}

/** The projection tables of the named modules: those of the entities of the features each module owns. */
export function moduleTables(modules: readonly string[]): string[] {
    const features = new Set(MODULE_PROJECTIONS.filter(({ module }) => modules.includes(module)).flatMap((projection) => projection.features));
    return MODULE_ENTITY_DEFINITIONS.filter((definition) => features.has(definition.feature)).map((definition) => definition.table);
}

/** Every module's projection tables (the core's own tables are not among them). */
export function allModuleTables(): string[] {
    return moduleTables(MODULE_PROJECTIONS.map(({ module }) => module));
}
