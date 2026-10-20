import { describe, expect, it } from 'vitest';

import { booleanArgument, createDispatcher, NativeCallError } from './bridge.js';

const call = createDispatcher({
    'engine.echo': (args) => args,
    'engine.nothing': () => undefined,
    'engine.flag': (args) => booleanArgument(args, 'on'),
    'engine.notReady': () => { throw new NativeCallError('not_ready', 'Still opening.'); },
    'engine.broken': async () => { throw new Error('Disk full'); },
});

async function reply(name: string, argsJson?: string): Promise<unknown> {
    return JSON.parse(await call(name, argsJson));
}

describe('native bridge dispatcher', () => {
    it('answers with the handler value as JSON text', async () => {
        expect(await reply('engine.echo', '{"page":2}')).toEqual({ ok: true, value: { page: 2 } });
        expect(await reply('engine.echo')).toEqual({ ok: true, value: {} });
        expect(await reply('engine.nothing')).toEqual({ ok: true, value: null });
    });

    it('dispatches only names it was given', async () => {
        expect(await reply('engine.missing')).toMatchObject({ ok: false, error: { code: 'unknown_function' } });
        expect(await reply('toString')).toMatchObject({ ok: false, error: { code: 'unknown_function' } });
        expect(await reply('__proto__')).toMatchObject({ ok: false, error: { code: 'unknown_function' } });
    });

    it('accepts only a JSON object as arguments', async () => {
        for (const args of ['[1]', '"text"', '42', 'null', '{broken']) {
            expect(await reply('engine.echo', args)).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
        }
        expect(await reply('engine.flag', '{"on":"yes"}')).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
        expect(await reply('engine.flag', '{"on":true}')).toEqual({ ok: true, value: true });
    });

    it('turns thrown errors into coded failures', async () => {
        expect(await reply('engine.notReady')).toEqual({ ok: false, error: { code: 'not_ready', message: 'Still opening.' } });
        expect(await reply('engine.broken')).toEqual({ ok: false, error: { code: 'failed', message: 'Disk full' } });
    });
});
