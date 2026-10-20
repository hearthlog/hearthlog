import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { defineNativeContract, implementNativeApi, nativeQuery } from './api.js';
import { createDispatcher } from './bridge.js';
import { nativeRegistry } from './registry.js';

const contract = defineNativeContract({
    namespace: 'notes',
    version: 3,
    queries: {
        'notes.count': nativeQuery({ args: Type.Object({ folder: Type.Optional(Type.String()) }), result: Type.Integer(), depends: ['app:notes'] }),
        'notes.broken': nativeQuery({ args: Type.Object({}), result: Type.Integer(), depends: [] }),
    },
});

const api = implementNativeApi(contract, {
    'notes.count': ({ folder }) => (folder ? 2 : 5),
    // Drifted from its contract: the registry catches it before an app's decoder does.
    'notes.broken': () => 'many' as unknown as number,
});

async function reply(name: string, args?: object) {
    const { handlers } = nativeRegistry([api]);
    return JSON.parse(await createDispatcher(handlers)(name, args ? JSON.stringify(args) : undefined));
}

describe('native registry', () => {
    it('names each function after its namespace and reports versions', () => {
        const registry = nativeRegistry([api]);
        expect(Object.keys(registry.handlers).sort()).toEqual(['notes.notes.broken', 'notes.notes.count']);
        expect(registry.versions).toEqual({ notes: 3 });
    });

    it('checks arguments and results against the contract', async () => {
        expect(await reply('notes.notes.count')).toEqual({ ok: true, value: 5 });
        expect(await reply('notes.notes.count', { folder: 'work' })).toEqual({ ok: true, value: 2 });
        expect(await reply('notes.notes.count', { folder: 7 })).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
        expect(await reply('notes.notes.broken')).toMatchObject({ ok: false, error: { code: 'failed', message: expect.stringContaining('notes.notes.broken result') } });
    });

    it('runs the guard before a function and refuses two modules in one namespace', async () => {
        const { handlers } = nativeRegistry([api], { beforeCall: () => { throw new Error('still opening'); } });
        expect(JSON.parse(await createDispatcher(handlers)('notes.notes.count'))).toMatchObject({ ok: false, error: { message: 'still opening' } });
        expect(() => nativeRegistry([api, api])).toThrow(/native namespace "notes"/);
    });

    it('refuses contracts a native app could not call', () => {
        expect(() => defineNativeContract({ namespace: 'engine', version: 1, queries: {} })).toThrow(/not "engine"/);
        expect(() => defineNativeContract({ namespace: 'notes', version: 0, queries: {} })).toThrow(/positive integer/);
        expect(() => defineNativeContract({ namespace: 'notes', version: 1, queries: { 'Bad name': contract.queries['notes.count'] } })).toThrow(/dotted camelCase/);
        expect(() => implementNativeApi(contract, { 'notes.count': () => 1 } as never)).toThrow(/no implementation for notes.broken/);
    });
});
