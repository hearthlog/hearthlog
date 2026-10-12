import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests/production',
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: 'list',
    outputDir: 'test-results/production-preview',
    use: {
        baseURL: 'http://127.0.0.1:4173',
        trace: 'on-first-retry',
        serviceWorkers: 'allow',
    },
    projects: [
        {
            name: 'chromium-production',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        command: 'pnpm preview:test',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: !process.env.CI,
    },
});
