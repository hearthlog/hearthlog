import { ENGINE_PATH } from "@hearthlog/runtime/native/bridge.js";

/** Whether a page is the native engine route, which the root layout gives `EngineLayout` instead of the shell. */
export function isEnginePath(pathname: string): boolean {
    return pathname === ENGINE_PATH || pathname === `${ENGINE_PATH}/`;
}
