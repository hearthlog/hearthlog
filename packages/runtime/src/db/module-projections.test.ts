import { describe, expect, it } from 'vitest';

import { MODULE_ENTITY_DEFINITIONS } from '#generated/modules';
import { allModuleTables, currentProjections, moduleTables, staleModules } from './module-projections.js';

describe('module projection ledger', () => {
    it('treats a module without a row as the baseline version', () => {
        expect(staleModules([], [{ module: 'org.stor.gallery', version: 1 }])).toEqual([]);
        expect(staleModules([], [{ module: 'org.stor.gallery', version: 2 }])).toEqual(['org.stor.gallery']);
    });

    it('flags only the modules whose stored version differs', () => {
        const stored = [
            { module_id: 'org.stor.gallery', projection_version: 1 },
            { module_id: 'org.stor.health', projection_version: 2 },
        ];
        const current = [
            { module: 'org.stor.gallery', version: 2 },
            { module: 'org.stor.health', version: 2 },
        ];
        expect(staleModules(stored, current)).toEqual(['org.stor.gallery']);
    });

    it('follows only the modules a tenant enables', () => {
        const modules = (features: string[]) => currentProjections(new Set(features)).map((entry) => entry.module);
        expect(modules(['calendar', 'calc'])).toEqual([]);
        expect(modules(['finance'])).toEqual(['org.stor.finance']);
        expect(modules(['gallery'])).toEqual(['org.stor.gallery']);
        expect(modules(['calories']).sort()).toEqual(['org.stor.health']);
    });

    it('knows the projection tables of each module and never lists the core\'s own', () => {
        expect(moduleTables([])).toEqual([]);
        expect(moduleTables(['no.such.module'])).toEqual([]);
        expect([...allModuleTables()].sort()).toEqual(MODULE_ENTITY_DEFINITIONS.map((definition) => definition.table).sort());
        expect(allModuleTables()).not.toContain('calendar_events');
    });
});
