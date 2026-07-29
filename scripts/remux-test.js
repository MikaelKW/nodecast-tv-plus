'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const bundledFfmpegPath = require('ffmpeg-static');
const bundledFfprobePath = require('@ffprobe-installer/ffprobe').path;
const { buildRemuxArgs, parseAudioCodecs } = require('../server/services/remux');

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
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

function createMediaServer(ffmpegPath) {
    const generators = new Set();
    const server = http.createServer((request, response) => {
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
            }
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

    const ffmpegPath = availableCommand('ffmpeg', bundledFfmpegPath);
    const ffprobePath = availableCommand('ffprobe', bundledFfprobePath);
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-remux-test-'));
    const outputPath = path.join(testDirectory, 'remuxed.mp4');

    const mediaServer = await createMediaServer(ffmpegPath);
    try {
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
            windowsHide: true
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
            '-hide_banner', '-loglevel', 'error',
            '-i', outputPath,
            '-f', 'null',
            '-'
        ], {
            encoding: 'utf8',
            windowsHide: true
        });
        assert.equal(decoded.status, 0, decoded.stderr || 'Remuxed output could not be decoded.');
    } finally {
        await mediaServer.close();
        fs.rmSync(testDirectory, { recursive: true, force: true });
    }

    console.log('AAC MPEG-TS remux regression test passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
