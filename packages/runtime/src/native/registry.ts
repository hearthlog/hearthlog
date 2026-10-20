import { Value } from '@sinclair/typebox/value';
import type { NativeApi } from './api.js';
import { NativeCallError, type NativeArguments, type NativeHandler } from './bridge.js';

export interface NativeRegistry {
    readonly handlers: Readonly<Record<string, NativeHandler>>;
    /** Each module API's version, by namespace, for `native:ready`. */
    readonly versions: Readonly<Record<string, number>>;
}

/**
 * The bridge handlers for the enabled modules' native APIs: `<namespace>.<function>`. Arguments are checked against
 * the contract before a function runs; results are checked too, so a drift between a module's code and the types an
 * app was generated from fails here, with a message, instead of in the app's decoder.
 */
export function nativeRegistry(apis: readonly NativeApi[], options: { beforeCall?: () => void } = {}): NativeRegistry {
    const handlers: Record<string, NativeHandler> = {};
    const versions: Record<string, number> = {};
    for (const { contract, implementation } of apis) {
        if (contract.namespace in versions) throw new Error(`Two modules use the native namespace "${contract.namespace}".`);
        versions[contract.namespace] = contract.version;
        for (const [name, query] of Object.entries(contract.queries)) {
            const run = implementation[name] as (args: NativeArguments) => unknown;
            handlers[`${contract.namespace}.${name}`] = async (args) => {
                if (!Value.Check(query.args, args)) {
                    throw new NativeCallError('invalid_arguments', describe(`${contract.namespace}.${name} arguments`, query.args, args));
                }
                options.beforeCall?.();
                const result = await run(args);
                if (!Value.Check(query.result, result)) {
                    throw new NativeCallError('failed', describe(`${contract.namespace}.${name} result`, query.result, result));
                }
                return result;
            };
        }
    }
    return { handlers, versions };
}

function describe(label: string, schema: Parameters<typeof Value.Errors>[0], value: unknown): string {
    const first = Value.Errors(schema, value).First();
    return first ? `${label}: ${first.path || '/'} ${first.message}` : `${label} do not match the contract.`;
}
