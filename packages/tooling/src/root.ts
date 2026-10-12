import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The repository a command works on: the nearest directory, from the working directory upward, that
 * holds `tenants.json`. Commands act on the host they are run in, not on where this package is installed.
 */
export function hostRoot(start: string = process.cwd()): string {
    let directory = resolve(start);
    for (;;) {
        if (existsSync(join(directory, "tenants.json")) || existsSync(join(directory, "tenants"))) return directory;
        const parent = dirname(directory);
        if (parent === directory) return resolve(start);
        directory = parent;
    }
}
