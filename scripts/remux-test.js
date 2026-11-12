'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const bundledFfprobePath = require('@ffprobe-installer/ffprobe').path;
const { buildRemuxArgs, parseAudioCodecs } = require('../server/services/remux');
const { resolveFFmpegPath } = require('../server/services/ffmpegBinary');

function availableCommand(command, fallback) {
    const result = spawnSync(command, ['-version'], {
        stdio: 'ignore',
        windowsHide: true
    });
    return result.status === 0 ? command : fallback;
}

function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('Remux test process timed out.'));
        }, 60000);
        child.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

function createMediaServer(ffmpegPath, matroskaPath) {
    const generators = new Set();
    const server = http.createServer((request, response) => {
        if (request.url === '/avcc.mkv') {
            response.writeHead(200, {
                'Content-Type': 'video/x-matroska',
                'Content-Length': fs.statSync(matroskaPath).size
            });
            if (request.method === 'HEAD') return response.end();
            const input = fs.createReadStream(matroskaPath);
            input.on('error', error => response.destroy(error));
            response.on('close', () => input.destroy());
            input.pipe(response);
            return;
        }
        if (request.method === 'HEAD') {
            response.writeHead(200, { 'Content-Type': 'video/mp2t' });
            return response.end();
        }

        response.writeHead(200, {
            'Content-Type': 'video/mp2t',
            Connection: 'close'
        });

        const generator = spawn(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error',
            '-re',
            '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
            '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-g', '50',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '96k',
            '-f', 'mpegts',
            '-'
        ], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        generators.add(generator);
        generator.stdout.pipe(response);
        generator.on('close', () => {
            generators.delete(generator);
            if (!response.writableEnded) response.end();
        });
        response.on('close', () => {
            if (!generator.killed) generator.kill('SIGKILL');
        });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}/aac-adts.ts`,
                matroskaUrl: `http://127.0.0.1:${port}/avcc.mkv`,
                close: () => new Promise(done => {
                    for (const generator of generators) {
                        if (!generator.killed) generator.kill('SIGKILL');
                    }
                    server.close(done);
                    server.closeAllConnections();
                })
            });
        });
    });
}

async function testAvccRemux(ffmpegPath, ffprobePath, mediaServer, testDirectory) {
    const outputPath = path.join(testDirectory, 'avcc-remuxed.mp4');
    // Keep the production arguments intact, including nobuffer: a successful
    // mux alone does not prove that the copied AVC packets remain decodable.
    const result = await run(ffmpegPath, buildRemuxArgs({
        url: mediaServer.matroskaUrl,
        userAgent: 'NodeCast remux test',
        audioCodecs: ['aac'],
        output: outputPath
    }));
    assert.equal(result.code, 0, result.stderr || 'AVCC Matroska remux failed.');

    const probe = await run(ffprobePath, [
        '-v', 'error', '-count_packets',
        '-show_entries', 'stream=codec_name,codec_type,nb_read_packets',
        '-of', 'json', outputPath
    ]);
    assert.equal(probe.code, 0, probe.stderr || 'Failed to inspect AVCC remux.');
    const streams = JSON.parse(probe.stdout).streams;
    for (const [type, codec] of [['video', 'h264'], ['audio', 'aac']]) {
        assert.ok(streams.some(stream => stream.codec_type === type &&
            stream.codec_name === codec && Number(stream.nb_read_packets) > 0),
        `The remux must preserve nonempty ${type} packets.`);
    }
    const decoded = await run(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode',
        '-i', outputPath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'
    ]);
    assert.equal(decoded.code, 0, decoded.stderr || 'AVCC remux could not be strictly decoded.');
    assert.equal(decoded.stderr.trim(), '', 'AVCC remux must decode without errors.');
}

function testClientRemuxUrl() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'basePath.js'), 'utf8');
    const sandbox = {
        document: {
            currentScript: {
                src: 'https://nodecast.example/nodecast/js/basePath.js'
            }
        },
        window: {
            location: {
                href: 'https://nodecast.example/nodecast/',
                origin: 'https://nodecast.example'
            },
            navigator: { userAgent: '' }
        },
        URL,
        URLSearchParams
    };
    vm.runInNewContext(source, sandbox);

    const remuxUrl = sandbox.window.NodeCastUrl.remux(
        'https://media.example/live.ts?token=example',
        {
            audio: 'aac',
            audioTracks: [
                { codec: 'aac' },
                { codec: 'mp3' }
            ]
        }
    );
    const parsed = new URL(remuxUrl, sandbox.window.location.origin);
    assert.equal(parsed.pathname, '/nodecast/api/remux');
    assert.equal(parsed.searchParams.get('url'), 'https://media.example/live.ts?token=example');
    assert.equal(parsed.searchParams.get('audioCodecs'), 'aac,mp3');
    assert.equal(
        sandbox.window.NodeCastUrl.prefersHlsRemuxFallback(
            'Mozilla/5.0 Firefox/141.0'
        ),
        true
    );
    assert.equal(
        sandbox.window.NodeCastUrl.prefersHlsRemuxFallback(
            'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36'
        ),
        false
    );

    const iPhoneSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
    const iPhoneChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1';
    const iPadSafari = 'Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
    const macSafari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
    const prefersHls = sandbox.window.NodeCastUrl.prefersHlsRemuxFallback;

    // iOS and iPadOS WebKit cannot play the progressive fMP4 remux pipe.
    assert.equal(prefersHls(iPhoneSafari, 'iPhone', 5), true);
    assert.equal(prefersHls(iPhoneChrome, 'iPhone', 5), true);
    assert.equal(prefersHls(iPadSafari, 'iPad', 5), true);
    // iPadOS in desktop mode reports a Mac user agent with touch support.
    assert.equal(prefersHls(macSafari, 'MacIntel', 5), true);
    // macOS Safari keeps the direct remux pipe.
    assert.equal(prefersHls(macSafari, 'MacIntel', 0), false);
}

function createHlsStub(supported) {
    const instances = [];
    class Hls {
        constructor() { instances.push(this); }
        static isSupported() { return supported; }
        loadSource(url) { this.source = url; }
        attachMedia() {}
        on() {}
        destroy() {}
    }
    Hls.Events = {};
    Hls.instances = instances;
    return Hls;
}

function createVideoStub(nativeHlsSupport) {
    return {
        src: '',
        playCalls: 0,
        canPlayType(type) {
            return type === 'application/vnd.apple.mpegurl' ? nativeHlsSupport : '';
        },
        play() {
            this.playCalls += 1;
            return Promise.resolve();
        },
        querySelectorAll() { return []; }
    };
}

function loadClientClass(file, className, Hls, dependencies = []) {
    const context = {
        window: {},
        document: {},
        console: { log() {}, warn() {}, error() {} },
        Hls,
        NodeCastUrl: { resolve: value => value },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        setInterval() { return 1; }, clearInterval() {},
        setTimeout() { return 1; }, clearTimeout() {}
    };
    vm.createContext(context);
    for (const script of [...dependencies, file]) {
        vm.runInContext(
            fs.readFileSync(path.join(__dirname, '..', 'public', 'js', script), 'utf8'),
            context,
            { filename: script }
        );
    }
    return context.window[className];
}

function createLivePlayer(Hls, video) {
    const VideoPlayer = loadClientClass('components/VideoPlayer.js', 'VideoPlayer', Hls, [
        'components/CaptionTracks.js'
    ]);
    const player = Object.create(VideoPlayer.prototype);
    Object.assign(player, {
        _playId: 1,
        hls: null,
        video,
        getHlsConfig: () => ({}),
        startVideoPlayback: () => video.play(),
        reportBrowserPlaybackFailure() {}
    });
    return player;
}

function createWatchPage(Hls, video) {
    const WatchPage = loadClientClass('pages/WatchPage.js', 'WatchPage', Hls);
    const watch = Object.create(WatchPage.prototype);
    Object.assign(watch, {
        _diagnosticPlayId: 1,
        hls: null,
        video,
        assertPlaybackRequestCurrent() {},
        reportBrowserPlaybackFailure() {},
        renderProbeSubtitleTracks() {},
        scheduleSelectedSubtitleRestore() {}
    });
    return watch;
}

function testNativeHlsFallback() {
    const playlist = '/api/transcode/session/test/stream.m3u8';

    // iOS 16 and 17.0 select the HLS remux session but cannot run HLS.js.
    // Both players must hand the playlist to WebKit's native HLS support.
    for (const create of [createLivePlayer, createWatchPage]) {
        const Hls = createHlsStub(false);
        const video = createVideoStub('maybe');
        const target = create(Hls, video);
        target.playHls(playlist, { playId: 1 });
        assert.equal(Hls.instances.length, 0, `${create.name} must not start HLS.js without MSE.`);
        assert.equal(target.hls, null);
        assert.equal(video.src, playlist, `${create.name} must play the playlist natively.`);
        assert.equal(video.playCalls, 1);
    }

    // Browsers with MSE keep using HLS.js, even when native HLS is available.
    for (const create of [createLivePlayer, createWatchPage]) {
        const Hls = createHlsStub(true);
        const video = createVideoStub('maybe');
        const target = create(Hls, video);
        target.playHls(playlist, { playId: 1 });
        assert.equal(Hls.instances.length, 1, `${create.name} must use HLS.js when supported.`);
        assert.equal(Hls.instances[0].source, playlist);
        assert.equal(video.src, '');
    }
}

async function main() {
    assert.deepEqual(parseAudioCodecs(undefined), []);
    assert.deepEqual(parseAudioCodecs(' AAC, mp3 '), ['aac', 'mp3']);
    assert.throws(() => parseAudioCodecs(['aac']), /comma-separated/);
    assert.throws(() => parseAudioCodecs('aac,$invalid'), /invalid codec list/);

    const mixedArgs = buildRemuxArgs({
        url: 'https://media.example/live.ts',
        userAgent: 'NodeCast remux test',
        audioCodecs: ['aac', 'mp3', 'aac']
    });
    assert.equal(mixedArgs[mixedArgs.indexOf('-bsf:a:0') + 1], 'aac_adtstoasc');
    assert.equal(mixedArgs.includes('-bsf:a:1'), false);
    assert.equal(mixedArgs[mixedArgs.indexOf('-bsf:a:2') + 1], 'aac_adtstoasc');
    testClientRemuxUrl();
    testNativeHlsFallback();

    const ffmpegPath = resolveFFmpegPath().path;
    assert.ok(ffmpegPath, 'System FFmpeg or the optional ffmpeg-static package is required for the remux test.');
    const ffprobePath = availableCommand('ffprobe', bundledFfprobePath);
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-remux-test-'));
    const outputPath = path.join(testDirectory, 'remuxed.mp4');
    let mediaServer;
    try {
        const matroskaPath = path.join(testDirectory, 'avcc.mkv');
        const fixture = await run(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
            '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast',
            '-g', '15', '-flags', '+global_header', '-c:a', 'aac', matroskaPath
        ]);
        assert.equal(fixture.code, 0, fixture.stderr || 'AVCC fixture generation failed.');
        const inputProbe = await run(ffprobePath, [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=is_avc,nal_length_size', '-of', 'json', matroskaPath
        ]);
        assert.equal(inputProbe.code, 0, inputProbe.stderr || 'AVCC fixture inspection failed.');
        const [inputVideo] = JSON.parse(inputProbe.stdout).streams;
        assert.equal(inputVideo.is_avc, 'true', 'The regression requires length-prefixed AVC input.');
        assert.equal(Number(inputVideo.nal_length_size), 4);
        mediaServer = await createMediaServer(ffmpegPath, matroskaPath);
        await testAvccRemux(ffmpegPath, ffprobePath, mediaServer, testDirectory);
        const remuxArgs = buildRemuxArgs({
            url: mediaServer.url,
            userAgent: 'NodeCast remux test',
            audioCodecs: ['aac'],
            output: outputPath
        });
        // The bundled Windows FFmpeg discards synthetic real-time packets while
        // probing when nobuffer is enabled. Production Docker coverage retains
        // that low-latency option; this portable media test focuses on the AAC
        // bitstream conversion and fragmented-MP4 output.
        remuxArgs[remuxArgs.indexOf('-fflags') + 1] = '+genpts+discardcorrupt+igndts';
        remuxArgs.splice(remuxArgs.lastIndexOf('-f'), 0, '-t', '4');
        const result = await run(ffmpegPath, remuxArgs);
        assert.equal(result.code, 0, result.stderr || 'AAC MPEG-TS remux failed.');

        const probe = spawnSync(ffprobePath, [
            '-v', 'error',
            '-show_entries', 'stream=codec_name,codec_type',
            '-of', 'json',
            outputPath
        ], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 60000
        });
        assert.equal(probe.status, 0, probe.stderr || 'Failed to inspect remuxed output.');
        const resultInfo = JSON.parse(probe.stdout);
        const outputSize = fs.statSync(outputPath).size;
        assert.ok(
            outputSize > 50_000,
            `Remuxed output is unexpectedly incomplete (${outputSize} bytes): ${result.stderr}`
        );
        assert.ok(resultInfo.streams.some(stream => stream.codec_type === 'video' && stream.codec_name === 'h264'));
        assert.ok(resultInfo.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));

        const decoded = spawnSync(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode',
            '-i', outputPath,
            '-f', 'null',
            '-'
        ], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 60000
        });
        assert.equal(decoded.status, 0, decoded.stderr || 'Remuxed output could not be decoded.');
    } finally {
        if (mediaServer) await mediaServer.close();
        fs.rmSync(testDirectory, { recursive: true, force: true });
    }

    console.log('AVCC Matroska and AAC MPEG-TS remux regression tests passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
