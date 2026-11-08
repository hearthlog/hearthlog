// @ts-nocheck
import { test, expect } from './fixtures';

// The estimate equals every block's real height, so the virtualizer never caches a size.
// The list must still settle on a row deep inside a block instead of waiting out its tries.
test('an endless list with an exact estimate settles on its opening row', async ({ page }) => {
    await page.goto('/endless-exact');
    const row = page.locator('[data-endless-key="block-2"] [data-row="20"]');
    await expect(row).toBeVisible({ timeout: 3_000 });
    const offset = await row.evaluate((element) =>
        element.getBoundingClientRect().top - document.querySelector('[data-test-scroll]').getBoundingClientRect().top);
    expect(offset).toBeLessThan(80);
});
