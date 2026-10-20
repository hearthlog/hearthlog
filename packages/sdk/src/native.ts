/**
 * Module API v0, native: a module's typed functions for native apps over the engine bridge. The contract file
 * (`native.contract` in the manifest) uses `defineNativeContract`, `nativeQuery` and `Type`, and nothing that needs a
 * browser; the implementation (`native.api`) uses `implementNativeApi`.
 */
export { defineNativeContract, implementNativeApi, nativeQuery } from '@hearthlog/runtime/native/api.js';
export type { NativeApi, NativeContract, NativeImplementation, NativeQuery } from '@hearthlog/runtime/native/api.js';
export { Type } from '@sinclair/typebox';
export type { Static, TSchema } from '@sinclair/typebox';
