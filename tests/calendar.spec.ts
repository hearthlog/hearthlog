// @ts-nocheck
import { test, expect } from './fixtures';

test.setTimeout(60_000);

function localNoon(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
}

function addDays(date, amount) {
    const result = localNoon(date);
    result.setDate(result.getDate() + amount);
    return result;
}

function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function monthKey(date) {
    return dateKey(date).slice(0, 7);
}

function addEventLabel(date) {
    return date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
    });
}

async function openAddForDate(page, date) {
    await page.locator(`[data-calendar-day="${dateKey(date)}"]`)
        .getByRole('button', { name: `Add event on ${addEventLabel(date)}` })
        .click();
}

async function addEvent(page, title, options = {}) {
    const dialog = page.getByRole('dialog', { name: 'Add event' });
    await dialog.getByLabel('Event title').fill(title);
    if (options.time) await dialog.getByLabel('Time').fill(options.time);
    if (options.notes) await dialog.getByLabel('Notes').fill(options.notes);
    if (options.pinned) await dialog.getByRole('checkbox', { name: 'Pin event' }).click();
    await dialog.getByRole('button', { name: 'Add event' }).click();
}

async function addEventOnDate(page, date, title, options = {}) {
    const targetMonth = monthKey(date);
    const currentUrl = new URL(page.url());
    if (currentUrl.pathname !== '/calendar' || currentUrl.searchParams.get('month') !== targetMonth) {
        await page.goto(`/calendar?month=${targetMonth}`);
    }
    await openAddForDate(page, date);
    await addEvent(page, title, options);
    await expect(page.locator(`[data-calendar-day="${dateKey(date)}"]`).getByText(title, { exact: true })).toBeVisible();
}

test('creates, pins, edits, and deletes a calendar event', async ({ page }) => {
    const today = localNoon();
    const primaryDate = addDays(today, 3);
    const suffix = String(Date.now());
    const primaryTitle = `Team offsite ${suffix}`;

    await addEventOnDate(page, primaryDate, primaryTitle, {
        time: '09:30',
        notes: 'Bring the launch notes',
        pinned: true,
    });
    await page.goto(`/calendar?month=${monthKey(primaryDate)}`);
    const day = page.locator(`[data-calendar-day="${dateKey(primaryDate)}"]`);
    await expect(day.getByText(primaryTitle, { exact: true })).toBeVisible();

    await day.getByRole('button', { name: `${primaryTitle}, 09:30, pinned` }).click();
    const editDialog = page.getByRole('dialog', { name: 'Edit event' });
    const editedTitle = `Team planning day ${suffix}`;
    await editDialog.getByLabel('Event title').fill(editedTitle);
    await editDialog.getByLabel('Time').fill('');
    await editDialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(day.getByText(editedTitle, { exact: true })).toBeVisible();

    const pinned = page.getByRole('region', { name: 'Pinned events' });
    await pinned.getByRole('button', { name: `Unpin ${editedTitle}` }).click();
    await expect(pinned.getByText(editedTitle, { exact: true })).toHaveCount(0);

    await day.getByRole('button', { name: `${editedTitle}, All day` }).click();
    await page.getByRole('dialog', { name: 'Edit event' })
        .getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('alertdialog', { name: 'Delete event?' })
        .getByRole('button', { name: 'Confirm' }).click();
    await expect(day.getByText(editedTitle, { exact: true })).toHaveCount(0);

});
