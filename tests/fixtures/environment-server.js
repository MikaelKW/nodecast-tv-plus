const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
// Use a process-specific directory so repeated local/CI runs can never race
// over the same database files during server teardown.
const testRoot = path.join(projectRoot, '.test-data', `playwright-${process.pid}`);
const dataDir = path.join(testRoot, 'data');
const cacheDir = path.join(testRoot, 'cache');
const mediaPath = path.join(testRoot, 'sample.mp4');
const appPort = Number(process.env.NODECAST_TEST_APP_PORT || 3210);
const fixturePort = Number(process.env.NODECAST_TEST_FIXTURE_PORT || 3211);
const connectionStats = { active: 0, maxActive: 0, total: 0, aborted: 0 };

function assertSafeTestPath(target) {
    const relative = path.relative(projectRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith('.test-data')) {
        throw new Error(`Refusing to modify unsafe test path: ${target}`);
    }
}

function xmltvTimestamp(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`;
}

function generateMedia() {
    const ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
    const result = spawnSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '8', '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        mediaPath
    ], { encoding: 'utf8' });

    if (result.status !== 0) {
        throw new Error(`Unable to generate test media: ${result.stderr || 'FFmpeg failed'}`);
    }
}

function sendFile(req, res, filePath, contentType) {
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);

    if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
            return res.end();
        }

        const start = Number(match[1]);
        const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        res.writeHead(206, {
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`
        });
        return fs.createReadStream(filePath, { start, end }).pipe(res);
    }

    res.setHeader('Content-Length', stat.size);
    res.writeHead(200);
    return fs.createReadStream(filePath).pipe(res);
}

function sendSlowFile(req, res, filePath, contentType) {
    const stat = fs.statSync(filePath);
    connectionStats.active += 1;
    connectionStats.total += 1;
    connectionStats.maxActive = Math.max(connectionStats.maxActive, connectionStats.active);

    let settled = false;
    const settle = () => {
        if (settled) return;
        settled = true;
        connectionStats.active -= 1;
        if (!res.writableEnded) connectionStats.aborted += 1;
    };
    res.on('close', settle);

    res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': contentType,
        'Content-Length': stat.size
    });

    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 });
    stream.on('data', chunk => {
        stream.pause();
        res.write(chunk);
        setTimeout(() => stream.resume(), 50);
    });
    stream.on('end', () => res.end());
    stream.on('error', error => res.destroy(error));
    res.on('close', () => stream.destroy());
}

async function start() {
    assertSafeTestPath(testRoot);
    await fsp.rm(testRoot, { recursive: true, force: true });
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.mkdir(cacheDir, { recursive: true });
    generateMedia();

    const fixtureServer = http.createServer((req, res) => {
        const baseUrl = `http://127.0.0.1:${fixturePort}`;
        const pathname = new URL(req.url, baseUrl).pathname;

        if (pathname === '/playlist.m3u') {
            const playlist = [
                '#EXTM3U',
                `#EXTINF:-1 tvg-id="nodecast.test.one" tvg-name="NodeCast Test Pattern" tvg-logo="${baseUrl}/logo.svg" group-title="Local Test",NodeCast Test Pattern`,
                `${baseUrl}/sample.mp4`,
                `#EXTINF:-1 tvg-id="nodecast.test.two" tvg-name="NodeCast Test Backup" group-title="Local Test",NodeCast Test Backup`,
                `${baseUrl}/sample.mp4`
            ].join('\n');
            res.writeHead(200, { 'Content-Type': 'application/x-mpegURL', 'Access-Control-Allow-Origin': '*' });
            return res.end(playlist);
        }

        if (pathname === '/guide.xml') {
            const now = Date.now();
            const startTime = new Date(now - 30 * 60 * 1000);
            const endTime = new Date(now + 30 * 60 * 1000);
            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="NodeCast TV Plus tests">
  <channel id="nodecast.test.one"><display-name>NodeCast Test Pattern</display-name></channel>
  <programme start="${xmltvTimestamp(startTime)}" stop="${xmltvTimestamp(endTime)}" channel="nodecast.test.one">
    <title>Controlled Test Programme</title>
    <desc>Generated locally for NodeCast TV Plus testing.</desc>
  </programme>
</tv>`;
            res.writeHead(200, { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' });
            return res.end(xml);
        }

        if (pathname === '/sample.mp4') return sendFile(req, res, mediaPath, 'video/mp4');
        if (pathname === '/slow-sample.mp4') return sendSlowFile(req, res, mediaPath, 'video/mp4');

        if (pathname === '/connection-stats') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify(connectionStats));
        }

        if (pathname === '/connection-stats/reset' && req.method === 'POST') {
            if (connectionStats.active !== 0) {
                res.writeHead(409, { 'Access-Control-Allow-Origin': '*' });
                return res.end('Connections are still active');
            }
            Object.assign(connectionStats, { active: 0, maxActive: 0, total: 0, aborted: 0 });
            res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
            return res.end();
        }

        if (pathname === '/oidc/.well-known/openid-configuration') {
            const issuer = `http://127.0.0.1:${fixturePort}/oidc`;
            const body = JSON.stringify({
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}/token`,
                userinfo_endpoint: `${issuer}/userinfo`
            });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
            return res.end(body);
        }

        if (pathname === '/logo.svg') {
            res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*' });
            return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#6941c6"/><text x="40" y="47" text-anchor="middle" fill="white" font-size="20">TEST</text></svg>');
        }

        res.writeHead(404);
        res.end('Not found');
    });

    fixtureServer.listen(fixturePort, '127.0.0.1', () => {
        console.log(`[TestFixture] Media and playlist server listening on ${fixturePort}`);
    });

    process.env.NODE_ENV = 'test';
    process.env.PORT = String(appPort);
    process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
    process.env.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
    process.env.NODECAST_DATA_DIR = dataDir;
    process.env.NODECAST_CACHE_DIR = cacheDir;
    process.env.NODECAST_DISABLE_BACKGROUND_JOBS = 'true';
    process.env.ALLOW_LOCAL_MEDIA_URLS = 'true';
    process.env.OIDC_ISSUER_URL = `http://127.0.0.1:${fixturePort}/oidc`;
    process.env.OIDC_CLIENT_ID = 'controlled-e2e-client';
    process.env.OIDC_CLIENT_SECRET = crypto.randomBytes(32).toString('hex');
    process.env.OIDC_CALLBACK_URL = `http://127.0.0.1:${appPort}/api/auth/oidc/callback`;
    process.env.OIDC_AUTH_URL = '';
    process.env.OIDC_TOKEN_URL = '';
    process.env.OIDC_USERINFO_URL = '';

    require('../../server/index');

    const closeFixture = () => fixtureServer.close();
    process.on('SIGINT', closeFixture);
    process.on('SIGTERM', closeFixture);
    process.on('exit', () => {
        try {
            assertSafeTestPath(testRoot);
            fs.rmSync(testRoot, { recursive: true, force: true });
        } catch {
            // CI workspaces are disposable; a forced process stop may skip cleanup.
        }
    });
}

start().catch(error => {
    console.error('[TestFixture] Startup failed:', error);
    process.exit(1);
});
