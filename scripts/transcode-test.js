const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-transcode-test-'));
process.env.NODECAST_CACHE_DIR = path.join(testRoot, 'cache');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const { HTTP_RECONNECT_ARGS } = require('../server/services/ffmpegNetwork');
const { TranscodeSession } = require('../server/services/transcodeSession');
const { parseMaxResolutionOverride } = require('../server/services/playbackQuality');
const {
    DEFAULT_TRANSCODE_START_TIMEOUT_SECONDS,
    MAX_TRANSCODE_START_TIMEOUT_SECONDS,
    MIN_TRANSCODE_START_TIMEOUT_SECONDS,
    parseTranscodeStartTimeoutSeconds
} = require('../server/config/transcode');
const PlaybackQuality = require('../public/js/components/PlaybackQuality');

function probe(url) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            ...HTTP_RECONNECT_ARGS,
            '-show_entries', 'format=duration',
            '-of', 'json',
            url
        ];
        const child = spawn(ffprobePath, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) return reject(new Error(`ffprobe failed (${code}): ${stderr}`));
            resolve(JSON.parse(stdout));
        });
    });
}

async function createTransientServer(mediaPath, initialStatus) {
    let requests = 0;
    const server = http.createServer((req, res) => {
        requests += 1;
        if (requests === 1) {
            res.writeHead(initialStatus, { Connection: 'close', 'Retry-After': '0' });
            return res.end('temporary provider rejection');
        }
        const stat = fs.statSync(mediaPath);
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size });
        fs.createReadStream(mediaPath).pipe(res);
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}/sample.mp4`,
        requestCount: () => requests,
        close: () => new Promise(resolve => {
            server.close(resolve);
            server.closeAllConnections();
        })
    };
}

async function main() {
    assert.ok(ffmpegPath, 'ffmpeg-static is required for the transcode test.');
    assert.ok(!HTTP_RECONNECT_ARGS.includes('-http_persistent'), 'Do not use an option unsupported by the bundled FFmpeg.');

    assert.equal(parseTranscodeStartTimeoutSeconds(), DEFAULT_TRANSCODE_START_TIMEOUT_SECONDS);
    assert.equal(parseTranscodeStartTimeoutSeconds('1'), MIN_TRANSCODE_START_TIMEOUT_SECONDS);
    assert.equal(parseTranscodeStartTimeoutSeconds(' 30 '), 30);
    assert.equal(parseTranscodeStartTimeoutSeconds('300'), MAX_TRANSCODE_START_TIMEOUT_SECONDS);
    for (const invalidTimeout of ['', '0', '-1', '1.5', '15seconds', '301']) {
        assert.throws(
            () => parseTranscodeStartTimeoutSeconds(invalidTimeout),
            /TRANSCODE_START_TIMEOUT_SECONDS/
        );
    }

    const projectRoot = path.join(__dirname, '..');
    const configuredTimeout = spawnSync(process.execPath, [
        '-e',
        "process.stdout.write(String(require('./server/config/transcode').TRANSCODE_START_TIMEOUT_MS))"
    ], {
        cwd: projectRoot,
        env: { ...process.env, TRANSCODE_START_TIMEOUT_SECONDS: '45' },
        encoding: 'utf8'
    });
    assert.equal(configuredTimeout.status, 0, configuredTimeout.stderr);
    assert.equal(configuredTimeout.stdout, '45000');

    const invalidConfiguredTimeout = spawnSync(process.execPath, [
        '-e',
        "require('./server/config/transcode')"
    ], {
        cwd: projectRoot,
        env: { ...process.env, TRANSCODE_START_TIMEOUT_SECONDS: '0' },
        encoding: 'utf8'
    });
    assert.notEqual(invalidConfiguredTimeout.status, 0);
    assert.match(invalidConfiguredTimeout.stderr, /TRANSCODE_START_TIMEOUT_SECONDS/);

    assert.equal(parseMaxResolutionOverride(undefined), null);
    assert.equal(parseMaxResolutionOverride('720p'), '720p');
    assert.throws(() => parseMaxResolutionOverride('1440p'), /maxResolution/);
    assert.throws(() => parseMaxResolutionOverride({}), /maxResolution/);

    const adaptiveLevels = [
        { height: 1080, bitrate: 5_000_000 },
        { height: 480, bitrate: 1_000_000 },
        { height: 720, bitrate: 3_000_000 }
    ];
    assert.equal(PlaybackQuality.findAdaptiveLevel(adaptiveLevels, '720p'), 2);
    assert.equal(PlaybackQuality.findAdaptiveLevel(adaptiveLevels, '480p'), 1);
    assert.equal(PlaybackQuality.findAdaptiveLevel(adaptiveLevels, 'auto'), -1);
    assert.equal(PlaybackQuality.findAdaptiveLevel([{ height: 1080 }], '720p'), -1);

    const capped = new TranscodeSession('https://example.com/source', {
        maxResolution: '4k',
        videoHeight: 720
    });
    assert.equal(capped.buildScaleFilter('software', 2160), 'scale=-2:720');

    const downscaled = new TranscodeSession('https://example.com/source', {
        maxResolution: '1080p',
        videoHeight: 2160
    });
    assert.equal(downscaled.buildScaleFilter('qsv', 1080), 'scale_qsv=w=-2:h=1080:format=nv12');

    const upscaled = new TranscodeSession('https://example.com/source', {
        upscaleEnabled: true,
        upscaleTarget: '1080p',
        videoHeight: 720
    });
    assert.equal(upscaled.buildScaleFilter('software', 1080), 'scale=-2:1080:flags=lanczos');

    const mediaPath = path.join(testRoot, 'sample.mp4');
    try {
        const generated = spawnSync(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=0.5',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', mediaPath
        ], { windowsHide: true, encoding: 'utf8' });
        assert.equal(generated.status, 0, generated.stderr || 'Failed to generate test media.');
        const retryableServer = await createTransientServer(mediaPath, 503);
        try {
            const result = await probe(retryableServer.url);
            assert.ok(Number(result.format.duration) > 0, 'ffprobe should recover from a transient HTTP 503.');
            assert.equal(retryableServer.requestCount(), 2, 'ffprobe should retry a transient server error exactly once.');
        } finally {
            await retryableServer.close();
        }

        const rejectedServer = await createTransientServer(mediaPath, 407);
        let session;
        try {
            session = new TranscodeSession('https://example.com/test-source.mp4', {
                ffmpegPath,
                videoMode: 'copy',
                videoCodec: 'h264',
                audioMixPreset: 'passthrough'
            });
            // The production constructor validates and blocks loopback URLs. The
            // controlled test swaps in its loopback fixture only after validation.
            session.url = rejectedServer.url;
            assert.equal(
                await session.startAndWaitForPlaylist(5_000),
                true,
                'A transcode session should retry one initial HTTP 407 and produce HLS output.'
            );
            assert.equal(rejectedServer.requestCount(), 2, 'The application-level retry should reconnect exactly once.');
        } finally {
            if (session) await session.cleanup();
            await rejectedServer.close();
        }
    } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
    }

    console.log('Transcode tests passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
