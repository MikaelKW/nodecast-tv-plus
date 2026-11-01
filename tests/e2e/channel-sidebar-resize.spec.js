const path = require('node:path');
const { test, expect } = require('@playwright/test');

const harness = `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<div id="page-live" class="page active">
  <div class="home-layout">
    <aside class="channel-sidebar" id="channel-sidebar">
      <div class="sidebar-header">A very long pay-per-view channel name that does not fit</div>
      <div class="channel-sidebar-resizer" id="channel-sidebar-resizer" role="separator"
        aria-orientation="vertical" aria-label="Resize channel list" tabindex="0"></div>
      <div id="channel-list" class="channel-list"></div>
    </aside>
    <main class="player-section" style="flex: 1"></main>
  </div>
</div>
</body></html>`;

async function openHarness(page) {
    await page.route('**/channel-sidebar-harness', route => route.fulfill({
        contentType: 'text/html',
        body: harness
    }));
    await page.goto('/channel-sidebar-harness');
    await page.addStyleTag({ path: path.join(__dirname, '../../public/css/main.css') });
    await page.addScriptTag({
        path: path.join(__dirname, '../../public/js/components/ChannelSidebarResizer.js')
    });
    await page.evaluate(() => {
        window.ChannelSidebarResizer.attach({
            sidebar: document.getElementById('channel-sidebar'),
            handle: document.getElementById('channel-sidebar-resizer')
        });
    });
}

const sidebarWidth = page => page.locator('#channel-sidebar')
    .evaluate(element => Math.round(element.getBoundingClientRect().width));

async function dragHandleBy(page, deltaX) {
    const box = await page.locator('#channel-sidebar-resizer').boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + deltaX / 2, y);
    await page.mouse.move(x + deltaX, y);
    await page.mouse.up();
}

test.describe('desktop channel sidebar', () => {
    test.use({ viewport: { width: 1600, height: 900 } });

    test('dragging the edge resizes the sidebar and the width persists', async ({ page }) => {
        await openHarness(page);
        const initial = await sidebarWidth(page);
        expect(initial).toBe(320);

        await dragHandleBy(page, 150);
        await expect.poll(() => sidebarWidth(page)).toBe(470);
        await expect(page.locator('#channel-sidebar-resizer')).toHaveAttribute('aria-valuenow', '470');

        await openHarness(page);
        await expect.poll(() => sidebarWidth(page)).toBe(470);

        await page.locator('#channel-sidebar-resizer').dblclick();
        await expect.poll(() => sidebarWidth(page)).toBe(320);
        await openHarness(page);
        await expect.poll(() => sidebarWidth(page)).toBe(320);
    });

    test('the keyboard resizes the focused handle', async ({ page }) => {
        await openHarness(page);
        // The player listens for arrow keys on the document (volume/channel).
        await page.evaluate(() => {
            window.documentKeys = [];
            document.addEventListener('keydown', event => {
                if (event.key !== 'Shift') window.documentKeys.push(event.key);
            });
        });
        await page.locator('#channel-sidebar-resizer').focus();
        await page.keyboard.press('Shift+ArrowRight');
        await expect.poll(() => sidebarWidth(page)).toBe(384);
        await page.keyboard.press('Home');
        await expect.poll(() => sidebarWidth(page)).toBe(220);
        expect(await page.evaluate(() => window.documentKeys)).toEqual([]);
        await page.keyboard.press('a');
        expect(await page.evaluate(() => window.documentKeys)).toEqual(['a']);
    });

    test('a collapsed sidebar hides the handle and stays collapsed', async ({ page }) => {
        await openHarness(page);
        await dragHandleBy(page, 100);
        await page.locator('#channel-sidebar').evaluate(element => element.classList.add('collapsed'));
        await expect(page.locator('#channel-sidebar-resizer')).toBeHidden();
        await expect.poll(() => sidebarWidth(page)).toBe(0);
    });
});

test.describe('landscape desktop width', () => {
    // The 896px landscape rule fixes the sidebar at 280px; desktop layouts in
    // that range must still follow the resized width.
    test.use({ viewport: { width: 850, height: 600 } });

    test('dragging resizes the sidebar in a narrow landscape window', async ({ page }) => {
        await openHarness(page);
        expect(await sidebarWidth(page)).toBe(280);
        await dragHandleBy(page, 60);
        await expect.poll(() => sidebarWidth(page)).toBe(340);
    });
});

test.describe('mobile channel drawer', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('the drawer keeps its width and has no resize handle', async ({ page }) => {
        await openHarness(page);
        await expect(page.locator('#channel-sidebar-resizer')).toBeHidden();
        const drawerWidth = await sidebarWidth(page);

        // A width stored on a desktop browser must not change the drawer.
        await page.evaluate(() => localStorage.setItem('nodecast_tv_channel_sidebar_width', '600'));
        await openHarness(page);
        await expect.poll(() => page.locator('#channel-sidebar').evaluate(element =>
            element.style.getPropertyValue('--channel-sidebar-width'))).not.toBe('');
        await expect.poll(() => sidebarWidth(page)).toBe(drawerWidth);
    });
});
