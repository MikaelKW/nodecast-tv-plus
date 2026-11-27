const path = require('node:path');
const { test, expect } = require('@playwright/test');

// History records as returned by GET /api/history. The movie and episode share
// provider ID 77 within one source, and a second source reuses the same ID.
const historyRecords = [
    {
        id: '1:9001:episode:77', item_id: '77', item_type: 'episode', source_id: 9001,
        progress: 600, duration: 2400,
        data: { title: 'Controlled series', subtitle: 'S1 E2', sourceId: 9001, containerExtension: 'mkv' }
    },
    {
        id: '1:9001:movie:77', item_id: '77', item_type: 'movie', source_id: 9001,
        progress: 120, duration: 6000,
        data: { title: 'Controlled movie', sourceId: 9001, containerExtension: 'mp4' }
    },
    {
        id: '1:9002:movie:77', item_id: '77', item_type: 'movie', source_id: 9002,
        progress: 45, duration: 5000,
        data: { title: 'Second source movie', sourceId: 9002, containerExtension: 'mp4' }
    }
];

test.beforeEach(async ({ page }) => {
    await page.route('**/watch-history-harness', route => route.fulfill({
        contentType: 'text/html',
        body: '<main id="page-home"></main>'
    }));
    await page.goto('/watch-history-harness');
    for (const file of ['basePath.js', 'pages/HomePage.js', 'pages/WatchPage.js']) {
        await page.addScriptTag({ path: path.join(__dirname, '../../public/js', file) });
    }
    await page.evaluate(records => {
        window.historyTest = { requests: [], plays: [], saves: [] };
        window.API = {
            favorites: { getChannels: async () => [] },
            request: async (method, url, body) => {
                historyTest.requests.push({ method, url, body });
                if (method === 'GET' && url.startsWith('/history')) return records;
                if (method === 'GET' && url.startsWith('/channels/recent')) return [];
                if (method === 'GET' && url.startsWith('/proxy/xtream/')) {
                    return { url: `https://media.example.invalid${url}` };
                }
                if (method === 'POST' && url === '/history') {
                    historyTest.saves.push(body);
                    return { success: true };
                }
                return null;
            }
        };
        const app = {
            pages: {
                watch: { play: (content, url) => historyTest.plays.push({ content, url }) }
            },
            navigateTo: pageName => { historyTest.page = pageName; }
        };
        window.home = new window.HomePage(app);
    }, historyRecords);
    await page.evaluate(() => window.home.show());
    await expect(page.locator('#continue-watching-list .dashboard-card')).toHaveCount(historyRecords.length);
});

for (const [index, record] of historyRecords.entries()) {
    test(`Continue Watching resumes ${record.item_type} ${record.item_id} from source ${record.source_id}`, async ({ page }) => {
        await page.locator('#continue-watching-list .dashboard-card').nth(index).click();
        await expect.poll(() => page.evaluate(() => window.historyTest.plays.length)).toBe(1);

        const { play, streamRequest } = await page.evaluate(() => ({
            play: window.historyTest.plays[0],
            streamRequest: window.historyTest.requests.find(request => request.url.startsWith('/proxy/xtream/'))
        }));
        const streamType = record.item_type === 'movie' ? 'movie' : 'series';
        expect(streamRequest.url).toBe(
            `/proxy/xtream/${record.source_id}/stream/77/${streamType}?container=${record.data.containerExtension}`
        );
        expect(play.content).toMatchObject({
            id: '77',
            type: record.item_type,
            sourceId: record.source_id,
            title: record.data.title,
            resumeTime: record.progress,
            duration: record.duration
        });

        // The resumed playback saves under the identity it was resumed from,
        // so periodic and final-position saves keep updating the same record.
        const saved = await page.evaluate(async content => {
            const watch = Object.create(window.WatchPage.prototype);
            Object.assign(watch, {
                content,
                video: { paused: false },
                pendingSeekProgress: null,
                containerExtension: content.containerExtension,
                getCurrentPlaybackTime: () => content.resumeTime + 10,
                getPlaybackDuration: () => content.duration
            });
            await watch.saveProgress();
            return window.historyTest.saves.at(-1);
        }, play.content);
        expect(saved).toMatchObject({
            id: '77',
            type: record.item_type,
            sourceId: record.source_id,
            progress: record.progress + 10,
            duration: record.duration
        });
    });
}
