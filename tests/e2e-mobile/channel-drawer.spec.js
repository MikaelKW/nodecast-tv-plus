const path = require('node:path');
const { test, expect } = require('@playwright/test');

const harness = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<div id="page-live" class="page active"><div class="home-layout sidebar-collapsed">
  <button id="channel-toggle-btn" class="channel-toggle-btn">Channels</button>
  <button id="sidebar-expand-btn" class="sidebar-expand-btn visible">Expand</button>
  <aside id="channel-sidebar" class="channel-sidebar collapsed">
    <div class="sidebar-header"><div class="sidebar-header-row">Channels
      <button id="sidebar-collapse-btn" class="btn btn-sm btn-ghost sidebar-collapse-btn">&lt;</button>
    </div></div>
    <div class="channel-list"><button class="channel-item">Synthetic channel</button></div>
  </aside>
  <div id="channel-sidebar-overlay" class="channel-sidebar-overlay"></div>
  <main class="player-section">Synthetic player</main>
</div></div><button id="toggle-groups">Groups</button></body></html>`;

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

async function wireActualSidebarControls(page) {
    // Load the real App.init bindings, without constructing unrelated players
    // or making authentication/catalogue requests in this focused harness.
    await page.addScriptTag({ path: path.resolve(__dirname, '../../public/js/app.js') });
    await page.evaluate(async () => {
        window.NodeCastOnboarding = { isMfaPending: () => false };
        const app = Object.assign(Object.create(App.prototype), {
            checkAuth: async () => true, loadNavigationSettings: async () => {},
            applyNavigationVisibility() {}, navigateTo() {},
            navigationSettings: { landingPage: 'live' }, liveTvSettings: {},
            pages: { home: { init: async () => {} } },
            channelList: { toggleAllGroups() {}, clearProgramInfoCache() {} },
            epgGuide: { fetchNowPlaying: async () => {}, startBackgroundRefresh() {} }
        });
        window.channelSelections = 0;
        document.querySelector('.channel-item').addEventListener('click', () => window.channelSelections++);
        await app.init();
    });
}

test('select, reopen, and left-chevron close use the real mobile drawer controls', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHarness(page);
    await wireActualSidebarControls(page);
    const sidebar = page.locator('#channel-sidebar');
    const overlay = page.locator('#channel-sidebar-overlay');
    const toggle = page.locator('#channel-toggle-btn');
    const collapse = page.locator('#sidebar-collapse-btn');
    await toggle.click();
    await sidebar.locator('.channel-item').click();
    await expect(sidebar).toBeHidden();
    await expect(overlay).toBeHidden();
    for (let attempt = 0; attempt < 3; attempt++) {
        await toggle.click();
        await expect(sidebar.locator('.channel-item')).toBeVisible();
        await collapse.click();
        await expect(sidebar).toBeHidden();
        await expect(overlay).toBeHidden();
    }
    expect(await page.evaluate(() => window.channelSelections)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('sidebarCollapsed'))).toBe('true');
    await toggle.click();
    await sidebar.locator('.channel-item').click();
    await expect(sidebar).toBeHidden();
    expect(await page.evaluate(() => window.channelSelections)).toBe(2);
    await toggle.click();
    await overlay.click({ position: { x: 350, y: 300 } });
    await expect(sidebar).toBeHidden();

    await page.setViewportSize({ width: 844, height: 390 });
    await page.locator('#sidebar-expand-btn').click();
    await expect(sidebar.locator('.channel-item')).toBeVisible();
    await collapse.click();
    await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('sidebarCollapsed'))).toBe('true');
});

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
