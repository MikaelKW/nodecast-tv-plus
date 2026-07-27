const path = require('node:path');
const { test, expect } = require('@playwright/test');

test('scroll-for-details hint follows inline, web fullscreen, and iOS fullscreen state', async ({ page }) => {
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
        let fullscreenElement = null;
        Object.defineProperty(document, 'fullscreenElement', {
            configurable: true,
            get: () => fullscreenElement
        });
        window.setControlledFullscreenElement = value => {
            fullscreenElement = value;
            document.dispatchEvent(new Event('fullscreenchange'));
        };
        window.watchPageUnderTest = new window.WatchPage({});
    });

    const hint = page.locator('#watch-scroll-hint');
    await expect(hint).not.toHaveClass(/hidden/);

    await page.evaluate(() => {
        window.setControlledFullscreenElement(document.querySelector('.watch-video-section'));
    });
    await expect(hint).toHaveClass(/hidden/);

    await page.evaluate(() => window.setControlledFullscreenElement(null));
    await expect(hint).not.toHaveClass(/hidden/);

    await page.locator('#watch-video').dispatchEvent('webkitbeginfullscreen');
    await expect(hint).toHaveClass(/hidden/);

    await page.locator('#watch-video').dispatchEvent('webkitendfullscreen');
    await expect(hint).not.toHaveClass(/hidden/);

    await page.evaluate(() => {
        const watchPage = document.getElementById('page-watch');
        Object.defineProperty(watchPage, 'scrollTop', {
            configurable: true,
            value: 75
        });
        watchPage.dispatchEvent(new Event('scroll'));
    });
    await expect(hint).toHaveClass(/hidden/);

    await page.locator('#watch-video').dispatchEvent('webkitbeginfullscreen');
    await page.locator('#watch-video').dispatchEvent('webkitendfullscreen');
    await expect(hint).toHaveClass(/hidden/);
});
