/**
 * What a built site ships, reduced to what must not change when the same site is built somewhere else (another
 * checkout, another lockfile): its routes, the names of its chunks without their content hashes, its offline precache
 * list, the gateway table, the Ledger event contracts, and the generated Worker configuration. File hashes are not part
 * of the comparison (a different install changes them); how many files agree byte for byte is reported only.
 *
 * `hearthlog artifact compare --site <id> --against <host root>` builds the comparison of the host in the current
 * directory with another built host (the handover gate of a site that moves into a repository of its own), and
 * `scripts/tarball-equivalence.ts` uses the same functions to compare a workspace build with one made from tarballs.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

import { siteBuildDirectory } from "../tenants/wrangler-config.js";

export interface Fingerprint {
    routes: string[];
    chunks: string[];
    precache: string[];
    contents: string[];
    gateway: string;
    contracts: string;
    wrangler: string;
}

function walk(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
    });
}

/** `name-AbC123xy.js` and `AbC123xy.js` become `name-#.js` and `#.js`: Vite and Kit name chunks by content hash. */
export function unhash(path: string): string {
    return path.replace(/(^|[-./])[A-Za-z0-9_-]{8}(?=\.[a-z0-9]+$)/, "$1#");
}

/** The fingerprint of the site built in `root` (its `build` directory, Kit's output directory, and `.generated`). */
export async function fingerprint(root: string, siteId: string, kitDirectory: string = join(root, ".svelte-kit")): Promise<Fingerprint> {
    const shell = dirname(createRequire(join(root, "package.json")).resolve("@hearthlog/shell/package.json"));
    const offline = await import(join(shell, "src/service-worker/offline-bundle.ts"));
    const buildDirectory = join(root, siteBuildDirectory(siteId));
    const generated = join(root, ".generated");
    if (!existsSync(join(buildDirectory, "service-worker.js"))) throw new Error(`${root} has no build of ${siteId}: run its build first`);
    const precache: string[] = offline
        .precacheEntries([...offline.parseServiceWorkerManifestPaths(readFileSync(join(buildDirectory, "service-worker.js"), "utf8")), ...offline.PRECACHE_EXTRA_PATHS].map((path: string) => ({ path, revision: null })))
        .map((entry: { url: string }) => unhash(entry.url));
    const manifest = readFileSync(join(kitDirectory, "output/server/manifest.js"), "utf8");
    const routes = [...manifest.matchAll(/id:\s*"([^"]*)"/g)].map((match) => match[1]!).sort();
    const paths = walk(join(buildDirectory, "_app"));
    return {
        routes,
        chunks: paths.map((path) => unhash(relative(buildDirectory, path))).sort(),
        precache: precache.sort(),
        contents: paths.map((path) => createHash("sha256").update(readFileSync(path)).digest("hex")),
        gateway: readFileSync(join(generated, "sites", siteId, "server-modules.ts"), "utf8"),
        contracts: readFileSync(join(generated, "src/event-schemas.generated.ts"), "utf8"),
        wrangler: readFileSync(join(generated, "sites", siteId, "wrangler.jsonc"), "utf8"),
    };
}

/** What differs between two fingerprints; empty when the site is the same. `names` says which side each is in the messages. */
export function compareFingerprints(label: string, left: Fingerprint, right: Fingerprint, names: [string, string] = ["left", "right"]): { problems: string[]; identical: number } {
    const problems: string[] = [];
    const list = (name: string, a: string[], b: string[]) => {
        // A multiset difference: after hashes are stripped many chunks share a name, so counts matter.
        const only = (x: string[], y: string[]) => {
            const remaining = [...y];
            return x.filter((item) => {
                const index = remaining.indexOf(item);
                if (index < 0) return true;
                remaining.splice(index, 1);
                return false;
            });
        };
        const missing = only(a, b);
        const extra = only(b, a);
        if (missing.length + extra.length > 0) {
            problems.push(`${label}: ${name} differ (${missing.length} only in the ${names[0]} build, ${extra.length} only in the ${names[1]} build)\n    - ${missing.slice(0, 8).join("\n    - ")}\n    + ${extra.slice(0, 8).join("\n    + ")}`);
        }
    };
    list("routes", left.routes, right.routes);
    list("chunk names", left.chunks, right.chunks);
    list("precache entries", left.precache, right.precache);
    if (left.gateway !== right.gateway) problems.push(`${label}: the gateway table differs`);
    if (left.contracts !== right.contracts) problems.push(`${label}: the Ledger contracts differ`);
    if (left.wrangler !== right.wrangler) problems.push(`${label}: the generated Worker config differs`);
    return { problems, identical: left.contents.filter((hash) => right.contents.includes(hash)).length };
}
