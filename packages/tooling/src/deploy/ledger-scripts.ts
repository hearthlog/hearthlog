import { createRequire } from "node:module";
import { join } from "node:path";

import { REPOSITORY_ROOT } from "../tenants/tenant-config.js";

/**
 * The command that runs one of `@hearthlog/ledger`'s scripts (the logical backup): the script is found from the host's
 * dependencies, so it works in a tenant repository where `packages/ledger/` does not exist, and tsx is this package's own.
 */
export function ledgerScript(name: string, args: readonly string[], root: string = REPOSITORY_ROOT): { command: string; args: string[] } {
    const script = createRequire(join(root, "package.json")).resolve(`@hearthlog/ledger/scripts/${name}.js`);
    return { command: process.execPath, args: [createRequire(import.meta.url).resolve("tsx/cli"), script, ...args] };
}
