const path = require('node:path');
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
    await page.route('**/guide-playback-harness', route => route.fulfill({
        contentType: 'text/html',
        body: `<div id="guide-row" data-channel-id="shared-id" data-source-id="2">
            <div class="epg-channel-info">
                <button class="epg-channel-logo">Logo</button>
                <button class="epg-channel-name">Same name</button>
            </div>
        </div>`
    }));
    await page.goto('/guide-playback-harness');
    await page.addScriptTag({
        path: path.join(__dirname, '../../public/js/components/EpgGuide.js')
    });
    await page.evaluate(() => {
        window.guideTest = { plays: [] };
        window.app = {
            channelList: {
                // Duplicate display names prove that source/channel identity,
                // rather than visible text, selects the intended guide record.
                guideChannels: [
                    { id: 'shared-id', sourceId: 1, name: 'Same name' },
                    { id: 'shared-id', sourceId: 2, name: 'Same name' }
                ],
                playChannelRecord: async channel => {
                    guideTest.plays.push(channel);
                    if (guideTest.rejectPlayback) throw new Error('Controlled playback failure');
                }
            },
            navigateTo: pageName => { guideTest.page = pageName; }
        };
        window.guide = Object.create(window.EpgGuide.prototype);
        window.guide.attachRowListeners(document.getElementById('guide-row'));
    });
});

for (const target of ['.epg-channel-name', '.epg-channel-logo']) {
    test(`TV Guide ${target} starts the exact channel even when it is absent from the sidebar`, async ({ page }) => {
        await page.locator(target).click();
        await expect.poll(() => page.evaluate(() => window.guideTest.plays.length)).toBe(1);
        const result = await page.evaluate(() => ({
            page: window.guideTest.page,
            channel: window.guideTest.plays[0]
        }));
        expect(result.page).toBe('live');
        expect(result.channel.sourceId).toBe(2);
    });
}

test('a playback failure remains handled after TV Guide navigates to Live TV', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.evaluate(() => { window.guideTest.rejectPlayback = true; });
    await page.locator('.epg-channel-name').click();
    await expect.poll(() => page.evaluate(() => window.guideTest.plays.length)).toBe(1);
    expect(await page.evaluate(() => window.guideTest.page)).toBe('live');
    expect(pageErrors).toEqual([]);
});
