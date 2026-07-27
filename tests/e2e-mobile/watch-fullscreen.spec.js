const path = require('node:path');
const { test, expect } = require('@playwright/test');

test('iOS native fullscreen hides and then restores the scroll-for-details hint', async ({ page }) => {
    await page.setContent(`
        <main id="page-watch">
            <section class="watch-video-section">
                <video id="watch-video"></video>
                <div id="watch-scroll-hint">Scroll for details</div>
                <button id="watch-fullscreen"></button>
            </section>
        </main>
    `);
    await page.addScriptTag({
        path: path.resolve(__dirname, '../../public/js/pages/WatchPage.js')
    });
    await page.evaluate(() => {
        window.watchPageUnderTest = new window.WatchPage({});
    });

    const hint = page.locator('#watch-scroll-hint');
    await expect(hint).not.toHaveClass(/hidden/);

    await page.locator('#watch-video').dispatchEvent('webkitbeginfullscreen');
    await expect(hint).toHaveClass(/hidden/);

    await page.locator('#watch-video').dispatchEvent('webkitendfullscreen');
    await expect(hint).not.toHaveClass(/hidden/);
});
