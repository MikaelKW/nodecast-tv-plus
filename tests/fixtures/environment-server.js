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
const recoverableHlsDir = path.join(testRoot, 'recoverable-hls');
const appPort = Number(process.env.NODECAST_TEST_APP_PORT || 3210);
const fixturePort = Number(process.env.NODECAST_TEST_FIXTURE_PORT || 3211);
const connectionStats = { active: 0, maxActive: 0, total: 0, aborted: 0 };
const recoverableHlsStats = { failedRequests: 0, segmentRequests: 0 };
const recoverableSegmentFailures = 4;
let retryGuideRequests = 0;

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

function xmltvMinuteTimestamp(date) {
    return xmltvTimestamp(date).replace(/\d{2} \+0000$/, ' +0000');
}

function controlledPlaylist(baseUrl) {
    return [
        '#EXTM3U',
        `#EXTINF:-1 tvg-id="nodecast.test.one" tvg-name="NodeCast Test Pattern" tvg-logo="${baseUrl}/logo.svg" group-title="Local Test",NodeCast Test Pattern`,
        `${baseUrl}/sample.mp4`,
        `#EXTINF:-1 tvg-id="nodecast.test.two" tvg-name="NodeCast Test Backup" group-title="Secondary Test",NodeCast Test Backup`,
        `${baseUrl}/sample.mp4`
    ].join('\n');
}

function controlledGuideXml() {
    const now = Date.now();
    const startTime = new Date(now - 30 * 60 * 1000);
    const endTime = new Date(now + 30 * 60 * 1000);
    return `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="NodeCast TV Plus tests">
  <channel id="nodecast.test.one"><display-name>NodeCast Test Pattern</display-name></channel>
  <programme start="${xmltvTimestamp(startTime)}" stop="${xmltvTimestamp(endTime)}" channel="nodecast.test.one">
    <title>Controlled Test Programme</title>
    <desc>Generated locally for NodeCast TV Plus testing.</desc>
  </programme>
</tv>`;
}

function generateMedia() {
    const ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
    const result = spawnSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '8', '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        mediaPath
    ], { encoding: 'utf8' });

    if (result.status !== 0) {
        throw new Error(`Unable to generate test media: ${result.stderr || 'FFmpeg failed'}`);
    }

    fs.mkdirSync(recoverableHlsDir, { recursive: true });
    const hlsResult = spawnSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', mediaPath,
        '-c', 'copy',
        '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
        '-hls_segment_filename', path.join(recoverableHlsDir, 'segment-%03d.ts'),
        path.join(recoverableHlsDir, 'playlist.m3u8')
    ], { encoding: 'utf8' });

    if (hlsResult.status !== 0) {
        throw new Error(`Unable to generate recoverable HLS fixture: ${hlsResult.stderr || 'FFmpeg failed'}`);
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
        const requestUrl = new URL(req.url, baseUrl);
        const pathname = requestUrl.pathname;

        if (pathname === '/playlist.m3u' || pathname === '/delayed-playlist.m3u') {
            const sendPlaylist = () => {
                res.writeHead(200, { 'Content-Type': 'application/x-mpegURL', 'Access-Control-Allow-Origin': '*' });
                res.end(controlledPlaylist(baseUrl));
            };
            if (pathname === '/delayed-playlist.m3u') return setTimeout(sendPlaylist, 1500);
            return sendPlaylist();
        }

        if (pathname === '/guide.xml') {
            res.writeHead(200, { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' });
            return res.end(controlledGuideXml());
        }

        if (pathname === '/retry-guide.xml') {
            retryGuideRequests += 1;
            if (retryGuideRequests === 1) {
                res.writeHead(503, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
                return res.end('controlled initial synchronization failure');
            }
            res.writeHead(200, { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' });
            return res.end(controlledGuideXml());
        }

        if (pathname === '/reduced-precision-guide.xml') {
            const minute = 60 * 1000;
            const middle = new Date(Math.floor(Date.now() / minute) * minute);
            const firstStart = new Date(middle.getTime() - (30 * minute));
            const secondStop = new Date(middle.getTime() + (30 * minute));
            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="NodeCast TV Plus reduced-precision tests">
  <channel id="timestamp.test"><display-name>Timestamp Test</display-name></channel>
  <programme start="${xmltvTimestamp(firstStart)}" stop="${xmltvMinuteTimestamp(middle)}" channel="timestamp.test">
    <title>Full precision start</title>
  </programme>
  <programme start="${xmltvMinuteTimestamp(middle)}" stop="${xmltvMinuteTimestamp(secondStop)}" channel="timestamp.test">
    <title>Minute precision</title>
  </programme>
  <programme start="20260230060000 +0000" stop="${xmltvMinuteTimestamp(secondStop)}" channel="timestamp.test">
    <title>Invalid calendar date</title>
  </programme>
  <programme start="${xmltvMinuteTimestamp(middle)}" stop="20260714250000 +0000" channel="timestamp.test">
    <title>Invalid stop time</title>
  </programme>
</tv>`;
            res.writeHead(200, { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' });
            return res.end(xml);
        }

        if (pathname === '/xtream/player_api.php') {
            const username = requestUrl.searchParams.get('username');
            const password = requestUrl.searchParams.get('password');
            if (!username || !password) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ user_info: { auth: 0, status: 'Disabled' } }));
            }

            const action = requestUrl.searchParams.get('action');
            let response;
            if (!action) {
                response = {
                    user_info: {
                        username,
                        auth: 1,
                        status: 'Active',
                        allowed_output_formats: ['m3u8', 'ts']
                    },
                    server_info: {
                        url: '127.0.0.1',
                        port: String(fixturePort),
                        server_protocol: 'http',
                        timezone: 'UTC',
                        timestamp_now: Math.floor(Date.now() / 1000)
                    }
                };
            } else if (action === 'get_live_categories') {
                response = [{ category_id: '15', category_name: 'Visibility Live Test', parent_id: 0 }];
            } else if (action === 'get_live_streams') {
                response = [{
                    num: 1,
                    name: 'Controlled Visibility Channel',
                    stream_type: 'live',
                    stream_id: 1501,
                    stream_icon: `${baseUrl}/logo.svg`,
                    epg_channel_id: 'visibility.live.test',
                    added: '1784073598',
                    category_id: '15',
                    container_extension: 'm3u8'
                }];
            } else if (action === 'get_vod_categories') {
                response = [{ category_id: '16', category_name: 'Visibility Movie Test', parent_id: 0 }];
            } else if (action === 'get_vod_streams') {
                response = [{
                    num: 1,
                    name: 'Controlled Visibility Movie',
                    stream_type: 'movie',
                    stream_id: 1601,
                    stream_icon: `${baseUrl}/logo.svg`,
                    added: '1784073599',
                    category_id: '16',
                    container_extension: 'mp4'
                }];
            } else if (action === 'get_series_categories') {
                response = [{ category_id: '17', category_name: 'Safari Layout Test', parent_id: 0 }];
            } else if (action === 'get_series') {
                response = [
                    {
                        num: 1,
                        name: 'Controlled Safari Series',
                        series_id: 17,
                        cover: `${baseUrl}/logo.svg`,
                        plot: 'Controlled Series details used for Safari layout testing.',
                        releaseDate: '2026-07-15',
                        last_modified: '1784073600',
                        rating: '8.5',
                        category_id: '17'
                    },
                    {
                        num: 2,
                        name: 'Controlled Mobile Long Series',
                        series_id: 18,
                        cover: `${baseUrl}/logo.svg`,
                        plot: 'Long controlled Series details used to verify mobile scrolling.',
                        releaseDate: '2026-07-15',
                        last_modified: '1784073601',
                        rating: '8.0',
                        category_id: '17'
                    }
                ];
            } else if (action === 'get_series_info' && requestUrl.searchParams.get('series_id') === '17') {
                response = {
                    episodes: {
                        1: [
                            { id: '1701', episode_num: 1, title: 'Controlled Episode One', duration: '00:24:00', container_extension: 'mp4' },
                            { id: '1702', episode_num: 2, title: 'Controlled Episode Two', duration: '00:24:00', container_extension: 'mp4' }
                        ]
                    }
                };
            } else if (action === 'get_series_info' && requestUrl.searchParams.get('series_id') === '18') {
                response = {
                    episodes: {
                        1: Array.from({ length: 12 }, (_, index) => ({
                            id: String(1801 + index),
                            episode_num: index + 1,
                            title: `Controlled Long Episode ${index + 1}`,
                            duration: '00:24:00',
                            container_extension: 'mp4'
                        }))
                    }
                };
            } else {
                response = [];
            }

            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify(response));
        }

        if (pathname === '/xtream/xmltv.php') {
            res.writeHead(200, { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' });
            return res.end('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
        }

        if (pathname === '/sample.mp4') return sendFile(req, res, mediaPath, 'video/mp4');
        if (pathname === '/recoverable-hls/playlist.m3u8') {
            return sendFile(req, res, path.join(recoverableHlsDir, 'playlist.m3u8'), 'application/vnd.apple.mpegurl');
        }
        if (pathname.startsWith('/recoverable-hls/segment-') && pathname.endsWith('.ts')) {
            recoverableHlsStats.segmentRequests += 1;
            const segmentName = path.basename(pathname);
            if (segmentName === 'segment-001.ts' && recoverableHlsStats.failedRequests < recoverableSegmentFailures) {
                recoverableHlsStats.failedRequests += 1;
                res.writeHead(503, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
                return res.end('controlled transient segment failure');
            }
            return sendFile(req, res, path.join(recoverableHlsDir, segmentName), 'video/mp2t');
        }
        if (pathname === '/recoverable-hls/stats') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify(recoverableHlsStats));
        }
        if (pathname === '/browser-only.mp4') {
            // Models providers that allow browser playback but reject server-side
            // FFmpeg/ffprobe clients regardless of their configured User-Agent.
            if (!req.headers['sec-fetch-mode']) {
                res.writeHead(403, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
                return res.end('browser requests only');
            }
            return sendFile(req, res, mediaPath, 'video/mp4');
        }
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
    process.env.TOTP_ENCRYPTION_KEY = crypto.randomBytes(48).toString('hex');
    process.env.NODECAST_DATA_DIR = dataDir;
    process.env.NODECAST_CACHE_DIR = cacheDir;
    process.env.NODECAST_DISABLE_BACKGROUND_JOBS = 'true';
    process.env.ALLOW_LOCAL_MEDIA_URLS = 'true';
    process.env.OIDC_ISSUER_URL = `http://127.0.0.1:${fixturePort}/oidc`;
    process.env.OIDC_CLIENT_ID = 'controlled-e2e-client';
    process.env.OIDC_CLIENT_SECRET = crypto.randomBytes(32).toString('hex');
    process.env.OIDC_CALLBACK_URL ||= `http://127.0.0.1:${appPort}/api/auth/oidc/callback`;
    process.env.OIDC_AUTH_URL = '';
    process.env.OIDC_TOKEN_URL = '';
    process.env.OIDC_USERINFO_URL = '';
    process.env.DISABLE_LOCAL_AUTH = '';
    process.env.OIDC_AUTO_REDIRECT = '';

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
