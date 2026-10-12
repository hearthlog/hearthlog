import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [
        cloudflareTest({
            main: "./packages/ledger/test/rpc-worker.ts",
            wrangler: {
                configPath: "./packages/ledger/test/wrangler.jsonc",
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
        include: ["packages/ledger/test/**/*.test.ts"],
    },
});
