const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, globals) {
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        document: { addEventListener() {} },
        ...globals
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), context);
    return context;
}

async function testStartup(authenticated, failNetwork = false, ok = true) {
    let completeAuth;
    const calls = [];
    const context = load('app.js', {
        ...Object.fromEntries([
            'VideoPlayer', 'ChannelList', 'SourceManager', 'EpgGuide', 'HomePage',
            'LivePage', 'GuidePage', 'MoviesPage', 'SeriesPage', 'SettingsPage',
            'AccountPage', 'MfaOnboardingPage', 'WatchPage'
        ].map(name => [name, class { constructor() { calls.push(`constructed:${name}`); } }])),
        window: { location: { replace: url => calls.push(`redirect:${url}`) } },
        localStorage: { getItem: () => 'legacy-test-value', removeItem: () => calls.push('token-removed') },
        NodeCastUrl: { resolve: url => `/nodecast${url}` },
        NodeCastStartup: { wait: async () => true },
        fetch: (url, options) => {
            calls.push(url);
            assert.equal(options.headers.Authorization, 'Bearer legacy-test-value');
            assert.equal(options.cache, 'no-store');
            return new Promise((resolve, reject) => {
                completeAuth = () => failNetwork ? reject(new Error('Controlled network failure')) : resolve({
                    ok, json: async () => authenticated
                        ? { authenticated: true, user: { username: 'test-account', role: 'admin' } }
                        : { authenticated: false }
                });
            });
        }
    });
    vm.runInContext(`
        App.prototype.setupAccountMenu = function () { record('account-menu'); };
        App.prototype.initializeComponents = function () { record('components'); };
        App.prototype.loadNavigationSettings = async function () { record('settings'); throw stop; };
        globalThis.app = new App();
    `, Object.assign(context, { record: value => calls.push(value), stop: new Error('Stop after protected startup') }));
    // Constructor side effects must not run while the real auth method awaits
    // its response, even when the browser still has a legacy bearer value.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['/nodecast/api/auth/session']);
    completeAuth();
    if (authenticated && ok && !failNetwork) {
        await assert.rejects(context.app.ready, /Stop after protected startup/);
        assert.deepEqual(calls, ['/nodecast/api/auth/session', 'token-removed', 'account-menu', 'components', 'settings']);
        assert.equal(context.app.currentUser.username, 'test-account');
    } else {
        await context.app.ready;
        assert.deepEqual(calls, ['/nodecast/api/auth/session', 'token-removed', 'redirect:/nodecast/login.html']);
        assert.equal(context.app.currentUser, null);
    }
}

async function testLeaseCleanup() {
    const sent = [];
    const context = load('components/VideoPlayer.js', {
        window: {}, Blob, DOMException,
        navigator: { sendBeacon: (url, body) => { sent.push({ url, body }); return true; } },
        NodeCastUrl: { resolve: url => `/nodecast${url}` },
        fetch: async (url, options) => { sent.push({ url, options }); }
    });
    const player = vm.runInContext('Object.create(VideoPlayer.prototype)', context);
    Object.assign(player, {
        playbackLeaseId: 'synthetic-lease', currentSessionId: null, _pendingLeaseRequests: 0,
        stopPlaybackLeaseHeartbeat() {}, _playId: 1,
        linkManagedPlaybackTrace() {}, startPlaybackLeaseHeartbeat() {}
    });
    player.releasePlaybackLease();
    assert.equal(sent.length, 0, 'An idle/direct player owns no managed lease');

    player.currentSessionId = 'synthetic-session';
    player.releasePlaybackLease();
    assert.equal(sent.length, 1);
    assert.equal(player.currentSessionId, null);
    assert.equal(sent[0].url, '/nodecast/api/transcode/lease/release');
    assert.equal(JSON.parse(await sent[0].body.text()).playbackLeaseId, 'synthetic-lease');
    player.releasePlaybackLease();
    assert.equal(sent.length, 1, 'An already released idle lease is not sent again');

    let finish;
    player.requestPlaybackResource = () => new Promise(resolve => { finish = resolve; });
    const pending = player.startTranscodeSession('https://media.example.test/channel');
    assert.equal(player._pendingLeaseRequests, 1);
    player.releasePlaybackLease();
    assert.equal(sent.length, 2, 'Page exit still releases an in-flight managed session');
    finish({ ok: true, json: async () => ({ sessionId: 'new-session', playlistUrl: '/playlist.m3u8' }) });
    await pending;
    assert.equal(player._pendingLeaseRequests, 0);
    assert.equal(player.currentSessionId, 'new-session');
    player.releasePlaybackLease();
    assert.equal(sent.length, 3);

    // Beacon refusal uses the existing keepalive fallback, still only for
    // playback that can own a lease.
    context.navigator.sendBeacon = () => false;
    player.currentSessionId = 'fallback-session';
    player.releasePlaybackLease();
    assert.equal(sent.length, 4);
    assert.equal(sent[3].options.keepalive, true);
    player.requestPlaybackResource = async () => { throw new Error('Controlled session failure'); };
    await assert.rejects(player.startTranscodeSession('https://media.example.test/channel'), /Controlled session failure/);
    assert.equal(player._pendingLeaseRequests, 0);
    player.releasePlaybackLease();
    assert.equal(sent.length, 4);
}

function testPageHide() {
    const sent = [];
    let pagehide;
    const context = load('components/VideoPlayer.js', {
        window: { addEventListener: (event, handler) => { if (event === 'pagehide') pagehide = handler; } },
        document: { getElementById: () => ({ setAttribute() {} }), querySelector: () => ({}) },
        navigator: { sendBeacon: (...args) => { sent.push(args); return true; } },
        NodeCastUrl: { resolve: value => value }, Blob
    });
    vm.runInContext(`
        VideoPlayer.prototype.getPlaybackLeaseId = () => 'synthetic-pagehide-lease';
        VideoPlayer.prototype.loadSettingsFromServer = async () => {};
        VideoPlayer.prototype.init = () => {};
        globalThis.player = new VideoPlayer();
    `, context);
    const player = context.player;
    let finished = 0;
    player.finishBrowserPlayback = () => finished++;
    pagehide();
    assert.equal(sent.length, 0, 'The actual pagehide listener skips idle players');
    player.currentSessionId = 'active-session';
    pagehide();
    assert.equal(sent.length, 1, 'The actual pagehide listener releases active sessions');
    player._pendingLeaseRequests = 1;
    pagehide();
    assert.equal(sent.length, 2, 'The actual pagehide listener releases pending sessions');
    assert.equal(finished, 3);
}

(async () => {
    await testStartup(false);
    await testStartup(false, true);
    await testStartup(false, false, false);
    await testStartup(true);
    await testLeaseCleanup();
    testPageHide();
    console.log('Authentication gates component startup; idle lease cleanup is suppressed and active/pending cleanup is preserved.');
})().catch(error => { console.error(error); process.exitCode = 1; });
