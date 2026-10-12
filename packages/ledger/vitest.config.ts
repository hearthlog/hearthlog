import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Paths are this package's own, so the tests run from any host (`pnpm -C dev ledger:test`).
const here = (path: string) => resolve(import.meta.dirname, path);

export default defineConfig({
    plugins: [
        cloudflareTest({
            main: here("test/rpc-worker.ts"),
            wrangler: {
                configPath: here("test/wrangler.jsonc"),
            },
            miniflare: {
                bindings: {
                    ADMIN_TOKEN: "worker-test-admin-token",
                    TOKEN_SIGNING_KEY_CURRENT:
                        "worker-test-signing-key-at-least-32-bytes-long",
                },
            },
        }),
    ],
    test: {
        dir: import.meta.dirname,
        include: ["test/**/*.test.ts"],
    },
});
