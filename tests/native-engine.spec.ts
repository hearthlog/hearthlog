import { expect, test } from '@playwright/test';

/**
 * The page a native app's hidden engine web view loads. The app's side is stood in for: the
 * `storShell` it defines before any script and the `stor` handler it listens on.
 */
interface EngineWindow {
    __engineMessages: { type: string; body: Record<string, unknown> }[];
    hearthlogNative?: { version: number; call(name: string, argsJson?: string): Promise<string> };
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        sessionStorage.clear();
        const target = window as unknown as EngineWindow;
        target.__engineMessages = [];
        Object.defineProperty(window, 'storShell', {
            value: Object.freeze({ kind: 'mac', site: 'st', version: 2, role: 'engine' }),
        });
        Object.defineProperty(window, 'webkit', {
            value: { messageHandlers: { stor: { postMessage: (message: EngineWindow['__engineMessages'][number]) => target.__engineMessages.push(message) } } },
        });
    });
});

async function call(page: import('@playwright/test').Page, name: string, args?: object): Promise<{ ok: boolean; value?: any; error?: { code: string } }> {
    const reply = await page.evaluate(
        ([name, args]) => (window as unknown as EngineWindow).hearthlogNative!.call(name as string, args as string | undefined),
        [name, args ? JSON.stringify(args) : undefined] as const,
    );
    return JSON.parse(reply);
}

test('the engine route opens the workspace without the shell and reports to the app', async ({ page }) => {
    await page.goto('/native-engine');

    // A cold dev server may reload the page once while it optimizes dependencies.
    await expect.poll(() => page.evaluate(() => (window as unknown as EngineWindow).__engineMessages.map((message) => message.type)).catch(() => []), { timeout: 30_000 })
        .toContain('native:ready');
    const ready = await page.evaluate(() => (window as unknown as EngineWindow).__engineMessages.find((message) => message.type === 'native:ready')!.body);
    expect(ready).toMatchObject({ bridgeVersion: 2, apis: {}, context: { tenantId: 'st' } });

    // Nothing of the shell renders: no navigation, no main area.
    await expect(page.locator('[data-stor-root]')).toHaveCount(0);
    await expect(page.locator('nav')).toHaveCount(0);

    const status = await call(page, 'engine.status');
    expect(status).toMatchObject({ ok: true, value: { ready: true, active: true, signedIn: true, pendingUploads: 0 } });
    const posted = await page.evaluate(() => (window as unknown as EngineWindow).__engineMessages.filter((message) => message.type === 'native:status').at(-1)!.body);
    expect(posted).toEqual(status.value);

    expect(await call(page, 'engine.context')).toMatchObject({ ok: true, value: { tenantId: 'st', origin: new URL(page.url()).origin } });
    expect(await call(page, 'engine.logs')).toMatchObject({ ok: true, value: { currentLogId: ready.context.logId, logs: [{ id: ready.context.logId }] } });
    expect(await call(page, 'engine.nope')).toMatchObject({ ok: false, error: { code: 'unknown_function' } });
    expect(await call(page, 'engine.setActive', { active: 'no' })).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });

    expect(await call(page, 'engine.setActive', { active: false })).toMatchObject({ ok: true, value: { active: false } });
    await expect.poll(() => page.evaluate(() => (window as unknown as EngineWindow).__engineMessages.filter((message) => message.type === 'native:status').at(-1)!.body.active))
        .toBe(false);
});

test('ordinary pages keep the shell and expose no engine', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page.locator('[data-stor-root]')).toHaveCount(1);
    expect(await page.evaluate(() => 'hearthlogNative' in window)).toBe(false);
});
