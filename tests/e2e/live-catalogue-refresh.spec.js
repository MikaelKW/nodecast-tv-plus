const path = require('node:path');
const { test, expect } = require('@playwright/test');

async function prepare(page, type = 'm3u', layout = 'grouped') {
    await page.route('**/catalogue-lifecycle-harness', route => route.fulfill({
        contentType: 'text/html',
        body: `<button id="refresh">Refresh source</button><button id="live">Live TV</button>
            <button id="favourite">Unavailable favourite</button><input id="channel-search">
            <select id="source-select"><option value="">All Sources</option></select>
            <div id="channel-list"></div><div id="context-menu"></div>`
    }));
    await page.goto('/catalogue-lifecycle-harness');
    for (const file of ['components/ChannelList.js', 'components/SourceManager.js', 'pages/LivePage.js', 'pages/HomePage.js']) {
        await page.addScriptTag({ path: path.join(__dirname, '../../public/js', file) });
    }
    await page.evaluate(({ type, layout }) => {
        window.catalogueTest = { notices: [], revision: 1, plays: 0 };
        window.alert = text => catalogueTest.notices.push(text);
        window.Icons = new Proxy({}, { get: () => '' });
        const source = { id: 1, type, name: 'Controlled source', enabled: true };
        window.API = {
            sources: {
                getAll: async () => catalogueTest.empty ? [] : [source],
                isVisibleIn: () => true,
                estimate: async () => ({ needsWarning: false }),
                sync: async () => { catalogueTest.revision += 1; },
                getStatus: async () => [{ source_id: 1, type: 'all', status: 'success' }]
            },
            favorites: { getChannels: async () => [] },
            proxy: {
                cache: { clear: async () => {} },
                catalogue: {
                    liveSummary: async () => ({ revision: catalogueTest.revision,
                        groups: [{ id: 'one', name: `Group ${catalogueTest.revision}`, count: 1 }] }),
                    liveChannels: async () => ({ items: [{ stream_id: 'one', name: 'Controlled channel',
                        category_id: 'one', category_name: `Group ${catalogueTest.revision}` }], hasMore: false })
                }
            }
        };
        const list = new window.ChannelList();
        list.liveTvSettings.layout = layout;
        const app = { channelList: list, rememberLastLiveChannel() {}, player: {
            play: async () => { catalogueTest.plays += 1; throw new Error('Controlled playback failure'); }
        } };
        const live = new window.LivePage(app);
        app.navigateTo = () => { catalogueTest.navigation = live.show(); };
        const home = new window.HomePage(app);
        const manager = Object.create(window.SourceManager.prototype);
        manager.sourceRefreshesInProgress = new Set();
        window.app = app;
        document.getElementById('refresh').onclick = () => {
            catalogueTest.refresh = manager.refreshSource(1, type);
        };
        document.getElementById('live').onclick = () => app.navigateTo('live');
        document.getElementById('favourite').onclick = () => home.playChannel({
            id: 'm3u_1_missing', sourceId: 1, sourceType: 'm3u', url: '/controlled-unavailable'
        });
    }, { type, layout });
}

for (const type of ['m3u', 'xtream']) {
    for (const layout of ['grouped', 'flat']) {
        test(`${type} refresh before the first Live TV visit loads the ${layout} catalogue`, async ({ page }) => {
            await prepare(page, type, layout);
            await page.locator('#refresh').click();
            await page.evaluate(() => catalogueTest.refresh);
            expect(await page.evaluate(() => catalogueTest.notices)).toEqual([
                type === 'm3u' ? 'M3U playlist synced & refreshed!' : 'Xtream data synced & refreshed!'
            ]);
            await page.locator('#live').click();
            await page.evaluate(() => catalogueTest.navigation);
            await expect(page.locator('#source-select option')).toHaveCount(2);
            if (layout === 'grouped') {
                await expect(page.locator('.group-name')).toHaveText('Group 2');
                await page.locator('.group-header').click();
            }
            await expect(page.locator('.channel-name')).toHaveText('Controlled channel');
            await page.locator('#source-select').selectOption(`${type}:1`);
            await expect.poll(() => page.evaluate(() => app.channelList.isLoading)).toBe(false);
            await page.locator('#refresh').click();
            await page.evaluate(() => catalogueTest.refresh);
            await expect(page.locator('#source-select')).toHaveValue(`${type}:1`);
            if (layout === 'grouped') await expect(page.locator('.group-name')).toHaveText('Group 3');
            else await expect(page.locator('.channel-name')).toHaveText('Controlled channel');
            expect(await page.evaluate(() => app.channelList.isLoading)).toBe(false);
        });
    }
}

test('failed Home favourite leaves an independently loaded, usable catalogue', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await prepare(page);
    await page.locator('#favourite').click();
    await page.evaluate(() => catalogueTest.navigation);
    await expect.poll(() => page.evaluate(() => catalogueTest.plays)).toBe(1);
    await expect(page.locator('.group-name')).toHaveText('Group 1');
    await page.locator('.group-header').click();
    await expect(page.locator('.channel-name')).toHaveText('Controlled channel');
    expect(errors).toEqual([]);
});

test('an installation with no sources still shows the genuine empty state', async ({ page }) => {
    await prepare(page);
    await page.evaluate(() => { catalogueTest.empty = true; });
    await page.locator('#live').click();
    await page.evaluate(() => catalogueTest.navigation);
    await expect(page.locator('#channel-list')).toContainText('No channels loaded');
    expect(await page.evaluate(() => app.channelList.isLoading)).toBe(false);
});

test('refresh drops a source filter that is no longer available', async ({ page }) => {
    await prepare(page);
    await page.locator('#live').click();
    await page.evaluate(() => catalogueTest.navigation);
    await page.locator('#source-select').selectOption('m3u:1');
    await expect.poll(() => page.evaluate(() => app.channelList.isLoading)).toBe(false);
    await page.evaluate(() => { catalogueTest.empty = true; });
    await page.locator('#refresh').click();
    await page.evaluate(() => catalogueTest.refresh);
    await expect(page.locator('#source-select')).toHaveValue('');
    await expect(page.locator('#source-select option')).toHaveCount(1);
    await expect(page.locator('#channel-list')).toContainText('No channels loaded');
});
