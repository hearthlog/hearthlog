import { defineConfig, devices } from '@playwright/test';

const frontendPort = Number(process.env.FRONTEND_TEST_PORT ?? 5173);
if (
  !Number.isInteger(frontendPort) ||
  frontendPort < 1 ||
  frontendPort > 65_535
) {
  throw new Error('FRONTEND_TEST_PORT must be a valid TCP port');
}
const frontendOrigin = `http://127.0.0.1:${frontendPort}`;

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import dotenv from 'dotenv';
// import path from 'path';
// dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  testIgnore: ['production/**', 'worker/**'],
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* One retry on CI absorbs a cold dev server; a test that needs more is flaky. */
  retries: process.env.CI ? 1 : 0,
  expect: { timeout: 10_000 },
  /* SQLocal owns one browser-side SQLite writer per test tab, so a single
     worker runs one test at a time. The suite is a handful of journeys. */
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: process.env.CI ? [['github'], ['list']] : 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: frontendOrigin,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },

    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    // E2E disables network sync entirely (see VITE_E2E in src/lib/store), so
    // the dev server must not require a running local Ledger to boot.
    command:
      `VITE_E2E=1 VITE_LEDGER_ENABLE_REALTIME=false pnpm run dev:e2e --host 127.0.0.1 ` +
      `--port ${frontendPort} --strictPort`,
    url: frontendOrigin,
    reuseExistingServer: !process.env.CI,
  },
});
