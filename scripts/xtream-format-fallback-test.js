const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const calls = [];
const context = {
    AbortController,
    API: {
        proxy: {
            xtream: {
                getStreamUrl: async (...args) => {
                    calls.push(args);
                    return { url: 'https://provider.invalid/live/example/example/39.ts' };
                }
            }
        }
    },
    console,
    document: {},
    fetch,
    Hls: {},
    localStorage: {},
    navigator: { userAgent: '' },
    NodeCastUrl: {},
    PlaybackQuality: {},
    URL,
    URLSearchParams,
    window: {}
};

vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'components', 'VideoPlayer.js'), 'utf8'),
    context,
    { filename: 'VideoPlayer.js' }
);

async function run() {
    const player = Object.create(context.window.VideoPlayer.prototype);
    player._xtreamStreamFormats = new Map();

    const xtreamChannel = {
        sourceType: 'xtream',
        sourceId: 7,
        streamId: 39
    };
    const hlsUrl = 'https://provider.invalid/live/example/example/39.m3u8';

    const fallback = await player.getXtreamTransportFallback(xtreamChannel, hlsUrl);
    assert.equal(fallback, 'https://provider.invalid/live/example/example/39.ts');
    assert.deepEqual(calls, [[7, 39, 'live', 'ts']]);

    assert.equal(
        await player.getXtreamTransportFallback(xtreamChannel, hlsUrl, true),
        null,
        'A fallback must not be attempted more than once.'
    );
    assert.equal(
        await player.getXtreamTransportFallback(
            { ...xtreamChannel, sourceType: 'm3u' },
            hlsUrl
        ),
        null,
        'M3U URLs must not be rewritten as Xtream streams.'
    );
    assert.equal(
        await player.getXtreamTransportFallback(
            xtreamChannel,
            'https://provider.invalid/live/example/example/39.ts'
        ),
        null,
        'An MPEG-TS URL must not trigger another format fallback.'
    );
    assert.equal(calls.length, 1);

    assert.equal(player.getPreferredXtreamStreamFormat(7, 39, 'm3u8'), 'm3u8');
    player.rememberXtreamStreamFormat(7, 39, 'ts');
    assert.equal(player.getPreferredXtreamStreamFormat(7, 39, 'm3u8'), 'ts');
    assert.equal(
        player.getPreferredXtreamStreamFormat(7, 40, 'm3u8'),
        'm3u8',
        'A fallback preference must remain scoped to its channel.'
    );
    assert.equal(
        player.getPreferredXtreamStreamFormat(8, 39, 'm3u8'),
        'm3u8',
        'A fallback preference must not leak to another source.'
    );

    console.log('Xtream transport fallback regression test passed.');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
