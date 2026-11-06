const { test, expect } = require('@playwright/test');
const { openSettingsTabs, tabRowState } = require('../fixtures/settings-tabs-harness');

// Moves keyboard focus with Tab until the named settings tab is focused.
async function tabTo(page, name) {
    for (let step = 0; step < 15; step += 1) {
        await page.keyboard.press('Tab');
        if (await page.evaluate(target => document.activeElement?.dataset?.tab === target, name)) return;
    }
    throw new Error(`The ${name} tab could not be reached with the keyboard.`);
}

test('every administrator tab fits on one row on desktop without a scrollbar', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSettingsTabs(page);
    const state = await tabRowState(page, 'about');
    expect(state.rows).toBe(1);
    expect(state.rowScrollWidth).toBeLessThanOrEqual(state.rowClientWidth);
    expect(state.scrollbarHeight).toBe(0);
    expect(state.tabVisible).toBe(true);
    expect(state.pageOverflow).toBeLessThanOrEqual(0);
});

test('settings tabs are reachable and selectable with the keyboard', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSettingsTabs(page);
    await tabTo(page, 'logs');
    const focus = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(focus.style).not.toBe('none');
    expect(focus.width).toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    expect((await tabRowState(page, 'logs')).tabActive).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Space');
    expect((await tabRowState(page, 'users')).tabActive).toBe(true);
});

test('a keyboard-focused tab beyond a narrow row is scrolled into view', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 800 });
    await openSettingsTabs(page);
    expect((await tabRowState(page, 'about')).tabVisible).toBe(false);
    await tabTo(page, 'about');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await tabRowState(page, 'about')).tabVisible).toBe(true);
    const state = await tabRowState(page, 'about');
    expect(state.tabActive).toBe(true);
    expect(state.rows).toBe(1);
    expect(state.scrollbarHeight).toBe(0);
    expect(state.pageOverflow).toBeLessThanOrEqual(0);
});
