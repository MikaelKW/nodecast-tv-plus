const path = require('node:path');
const { test, expect } = require('@playwright/test');

const harness = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<div id="page-live" class="page active"><div class="home-layout sidebar-collapsed">
  <aside id="channel-sidebar" class="channel-sidebar collapsed">
    <div class="sidebar-header">Channels</div>
    <div class="channel-list"><button class="channel-item">Synthetic channel</button></div>
  </aside>
  <div id="channel-sidebar-overlay" class="channel-sidebar-overlay"></div>
  <main class="player-section">Synthetic player</main>
</div></div></body></html>`;

async function openHarness(page) {
    await page.route('**/channel-drawer-harness', route => route.fulfill({
        contentType: 'text/html', body: harness
    }));
    await page.goto('/channel-drawer-harness');
    await page.addStyleTag({ path: path.resolve(__dirname, '../../public/css/main.css') });
    await page.evaluate(() => localStorage.setItem('sidebarCollapsed', 'true'));
}

async function setDrawer(page, open) {
    await page.evaluate(open => {
        document.getElementById('channel-sidebar').classList.toggle('active', open);
        document.getElementById('channel-sidebar-overlay').classList.toggle('active', open);
    }, open);
}

test('desktop collapse does not hide the mobile drawer or its clickable contents', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHarness(page);
    const sidebar = page.locator('#channel-sidebar');
    const channel = sidebar.locator('.channel-item');
    await page.evaluate(() => {
        window.channelSelections = 0;
        document.querySelector('.channel-item').addEventListener('click', () => window.channelSelections++);
    });
    for (let attempt = 0; attempt < 3; attempt++) {
        await setDrawer(page, true);
        await expect(sidebar).toBeVisible();
        await expect(sidebar.locator('.sidebar-header')).toBeVisible();
        await expect(channel).toBeVisible();
        await channel.click();
        expect(await page.evaluate(() => window.channelSelections)).toBe(attempt + 1);
        await setDrawer(page, false);
        await expect(sidebar).toBeHidden();
        await expect(page.locator('#channel-sidebar-overlay')).toBeHidden();
    }
    // A refresh restores the same desktop preference without breaking mobile.
    await page.reload();
    await page.addStyleTag({ path: path.resolve(__dirname, '../../public/css/main.css') });
    await setDrawer(page, true);
    await expect(channel).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sidebarCollapsed'))).toBe('true');
});

test('rotating into the drawer layout preserves desktop collapse for the return trip', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openHarness(page);
    const sidebar = page.locator('#channel-sidebar');
    const width = () => sidebar.evaluate(element => Math.round(element.getBoundingClientRect().width));
    await expect.poll(width).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await setDrawer(page, true);
    await expect(sidebar.locator('.sidebar-header')).toBeVisible();
    await expect(sidebar.locator('.channel-item')).toBeVisible();
    expect(await width()).toBeGreaterThan(200);
    await setDrawer(page, false);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(width).toBe(0);
    await expect(sidebar.locator('.channel-list')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('sidebarCollapsed'))).toBe('true');
});
