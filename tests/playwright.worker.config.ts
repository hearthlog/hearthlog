import { defineConfig, devices } from '@playwright/test';

const workerPort = Number(process.env.LEDGER_WORKER_TEST_PORT ?? 8787);
if (!Number.isInteger(workerPort) || workerPort < 1 || workerPort > 65_535) {
    throw new Error('LEDGER_WORKER_TEST_PORT must be a valid TCP port');
}
const workerOrigin = `http://127.0.0.1:${workerPort}`;

export default defineConfig({
    testDir: './worker',
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: 'line',
    timeout: 60_000,
    use: {
        baseURL: workerOrigin,
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        // Wrangler reads local secrets from a `.dev.vars` beside the config, which is generated: lay the example there.
        command:
            'cp ledger/.dev.vars.example .generated/shared/ledger/.dev.vars && ' +
            'pnpm exec wrangler dev --config .generated/shared/ledger/wrangler.jsonc --env="" ' +
            `--var ALLOWED_ORIGINS:http://127.0.0.1:5173 --port ${workerPort}`,
        // The development site holds the generated Ledger config and the example secrets.
        cwd: '../dev',
        url: `${workerOrigin}/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
