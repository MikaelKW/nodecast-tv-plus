const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createHarness(type = 'm3u') {
    const notices = [];
    const calls = [];
    let revision = 1;
    const source = { id: 1, type, name: 'Controlled source', enabled: true };
    const context = vm.createContext({
        window: {},
        console: { log() {}, warn() {}, error() {} },
        setTimeout: callback => { callback(); },
        document: {
            addEventListener() {},
            removeEventListener() {},
            querySelector: () => null,
            createElement: () => ({ appendChild() {} })
        },
        alert: message => notices.push(message),
        API: {
            sources: {
                getAll: async () => { calls.push('sources'); return [source]; },
                isVisibleIn: () => true,
                estimate: async () => ({ needsWarning: false }),
                sync: async () => { calls.push('sync'); revision += 1; },
                getStatus: async () => [{ source_id: 1, type: 'all', status: 'success' }]
            },
            favorites: { getChannels: async () => [] },
            proxy: {
                cache: { clear: async () => calls.push('cache-clear') },
                catalogue: {
                    liveSummary: async () => {
                        calls.push('summary');
                        return { revision, groups: [{ id: 'one', name: `Group ${revision}`, count: 1 }] };
                    }
                }
            }
        }
    });
    for (const file of ['components/ChannelList.js', 'components/SourceManager.js', 'pages/LivePage.js', 'pages/HomePage.js']) {
        const filename = path.join(__dirname, '../public/js', file);
        vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    }
    const list = Object.create(context.window.ChannelList.prototype);
    Object.assign(list, {
        sources: [], channels: [], groups: [], boundedMode: true,
        sourceSelect: { value: '', innerHTML: '', appendChild() {} },
        searchInput: { value: '' }, liveTvSettings: { layout: 'grouped' },
        isLoading: false, isCatalogueReady: false, _boundedRequestId: 0,
        boundedSummaryCache: new Map(), boundedGroupPages: new Map(),
        boundedSearchPages: new Map(), boundedSearchGroupPages: new Map(),
        collapsedGroups: new Set(), _userExpandedGroups: new Set(),
        renderBounded() {}
    });
    const manager = Object.create(context.window.SourceManager.prototype);
    manager.sourceRefreshesInProgress = new Set();
    const app = {
        channelList: list,
        rememberLastLiveChannel() {},
        player: { play: async () => { throw new Error('Controlled unavailable favourite'); } }
    };
    const live = new context.window.LivePage(app);
    app.navigateTo = () => { app.navigation = live.show(); };
    context.window.app = app;
    return { list, manager, live, app, context, notices, calls };
}

async function run() {
    // The targeted Home record must not make catalogue readiness depend on
    // playback success, even when Live TV has never been visited.
    const home = createHarness();
    const dashboard = new home.context.window.HomePage(home.app);
    dashboard.playChannel({ id: 'm3u_1_one', sourceId: 1, sourceType: 'm3u', url: '/controlled-unavailable' });
    await home.app.navigation;
    assert.equal(home.list.boundedGroups.length, 1);
    assert.equal(home.list.isCatalogueReady, true);
    assert.equal(home.list.isLoading, false);
    console.log('Failed Home favourite independently loads the Live TV catalogue.');

    for (const type of ['m3u', 'xtream']) {
        const harness = createHarness(type);
        // Actual source-refresh and Live-page methods, before any Live visit.
        await harness.manager.refreshSource(1, type);
        assert.equal(harness.notices.some(message => message.startsWith('Refresh failed:')), false);
        await harness.live.show();
        assert.equal(harness.list.sources.length, 1, `${type}: refresh must initialize the source list`);
        assert.equal(harness.list.boundedGroups.length, 1, `${type}: Live TV must load without a page refresh`);
        assert.equal(harness.list.boundedGroups[0].name, 'Group 2');
        assert.ok(harness.calls.indexOf('sources') < harness.calls.indexOf('summary'));

        // A subsequent refresh must also replace the already loaded summary.
        harness.list.sourceSelect.value = `${type}:1`;
        await harness.manager.refreshSource(1, type);
        await harness.live.show();
        assert.equal(harness.list.sourceSelect.value, `${type}:1`, 'Refresh must retain an available source filter');
        assert.equal(harness.list.boundedGroups[0].name, 'Group 3');
        assert.equal(harness.list.isLoading, false);
        assert.equal(harness.manager.sourceRefreshesInProgress.size, 0);
    }
    console.log('Source refresh before and after the first Live visit passed for M3U and Xtream.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
