const { test, expect } = require('@playwright/test');
const { openSettingsTabs, tabRowState } = require('../fixtures/settings-tabs-harness');

test('the settings tab row scrolls on iPhone and keeps the selected tab in view', async ({ page }) => {
    await openSettingsTabs(page);
    const initial = await tabRowState(page, 'about');
    expect(initial.rows).toBe(1);
    expect(initial.rowScrollWidth).toBeGreaterThan(initial.rowClientWidth);
    expect(initial.scrollbarHeight).toBe(0);
    expect(initial.minTabHeight).toBeGreaterThanOrEqual(44);
    expect(initial.pageOverflow).toBeLessThanOrEqual(0);
    expect(initial.tabVisible).toBe(false);

    // The row scrolls horizontally, as a swipe would.
    await page.locator('.tabs').evaluate(row => { row.scrollLeft = row.scrollWidth; });
    expect(await page.locator('.tabs').evaluate(row => row.scrollLeft)).toBeGreaterThan(0);

    await page.locator('.tab[data-tab="about"]').tap();
    await expect.poll(async () => (await tabRowState(page, 'about')).tabVisible).toBe(true);
    expect((await tabRowState(page, 'about')).tabActive).toBe(true);

    // Selecting the first tab again brings it back into view.
    await page.locator('.tabs').evaluate(row => { row.scrollLeft = row.scrollWidth; });
    await page.evaluate(() => document.querySelector('.tab[data-tab="sources"]').click());
    await expect.poll(async () => (await tabRowState(page, 'sources')).tabVisible).toBe(true);
    expect((await tabRowState(page, 'sources')).pageOverflow).toBeLessThanOrEqual(0);
});
