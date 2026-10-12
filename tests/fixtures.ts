import { test as base, expect } from '@playwright/test';

/**
 * SQLocal's sessionStorage VFS survives longer than Playwright's logical test
 * pages in Chromium. Give every test a clean database, while preserving it
 * across full-document navigations within that test.
 */
export const test = base.extend({
    page: async ({ page }, use, testInfo) => {
        const marker = `stor-e2e:${testInfo.testId}:${Date.now()}:${Math.random()}`;
        await page.addInitScript((testMarker) => {
            // PDF previews open an iframe. Clearing sessionStorage there also
            // clears SQLocal's top-level KV-VFS database during the test.
            if (window !== window.top) return;
            if (window.name === testMarker) return;
            sessionStorage.clear();
            window.name = testMarker;
        }, marker);
        await page.goto('/');
        await page.waitForFunction(() => Boolean(window.__storE2E));
        await expect(page.getByRole('status').filter({ hasText: 'Page data ready' }))
            .toBeAttached({ timeout: 30_000 });
        await page.evaluate(() => window.__storE2E!.resetDatabase());
        await use(page);
    },
});

export { expect };
