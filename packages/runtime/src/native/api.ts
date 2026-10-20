/**
 * A module's native API: the functions a native app may call over the engine bridge (`./bridge.ts`).
 *
 * It has two halves. The contract (`defineNativeContract`) names each function with TypeBox schemas for its
 * arguments and result and the refresh keys it reads; it imports nothing else, so `hearthlog apple:types` can load
 * it in Node and write the Swift types from it. The implementation (`implementNativeApi`) runs in the engine page
 * and calls the module's existing repositories and loads, so no query logic is written twice.
 *
 * This file stays free of browser and Svelte code for the same reason.
 */

import type { Static, TSchema } from '@sinclair/typebox';

export interface NativeQuery<Args extends TSchema = TSchema, Result extends TSchema = TSchema> {
    readonly kind: 'query';
    readonly args: Args;
    readonly result: Result;
    /** Refresh keys (`app:stash`) whose change makes a native app read this again. */
    readonly depends: readonly string[];
}

export interface NativeContract {
    /** The first part of every function name (`stash` in `stash.scenes.list`); `engine` is the platform's. */
    readonly namespace: string;
    /** Raised when a change would break an app built against the previous contract. */
    readonly version: number;
    readonly queries: Readonly<Record<string, NativeQuery>>;
}

export type NativeImplementation<Contract extends NativeContract> = {
    readonly [Name in keyof Contract['queries']]: (
        args: Static<Contract['queries'][Name]['args']>,
    ) => Static<Contract['queries'][Name]['result']> | Promise<Static<Contract['queries'][Name]['result']>>;
};

/** What a module's `native.api` file exports by default. */
export interface NativeApi<Contract extends NativeContract = NativeContract> {
    readonly contract: Contract;
    readonly implementation: Readonly<Record<string, (args: never) => unknown>>;
}

const NAMESPACE = /^[a-z][a-z0-9]*$/;
const FUNCTION = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/;

export function nativeQuery<Args extends TSchema, Result extends TSchema>(spec: {
    args: Args;
    result: Result;
    depends: readonly string[];
}): NativeQuery<Args, Result> {
    return { kind: 'query', ...spec };
}

export function defineNativeContract<const Contract extends NativeContract>(contract: Contract): Contract {
    if (!NAMESPACE.test(contract.namespace) || contract.namespace === 'engine') {
        throw new Error(`Native namespace "${contract.namespace}" must be lowercase letters and digits, and not "engine".`);
    }
    if (!Number.isInteger(contract.version) || contract.version < 1) throw new Error(`${contract.namespace}: version must be a positive integer.`);
    for (const name of Object.keys(contract.queries)) {
        if (!FUNCTION.test(name)) throw new Error(`${contract.namespace}: "${name}" must be dotted camelCase words, like scenes.list.`);
    }
    return contract;
}

export function implementNativeApi<Contract extends NativeContract>(
    contract: Contract,
    implementation: NativeImplementation<Contract>,
): NativeApi<Contract> {
    const missing = Object.keys(contract.queries).filter((name) => typeof (implementation as Record<string, unknown>)[name] !== 'function');
    if (missing.length > 0) throw new Error(`${contract.namespace}: no implementation for ${missing.join(', ')}.`);
    return { contract, implementation: implementation as unknown as NativeApi<Contract>['implementation'] };
}
