const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const catchup = require('../server/services/catchup');

const projectRoot = path.join(__dirname, '..');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function testArchiveWindow() {
    assert.deepEqual(catchup.archiveWindow({ tv_archive: 1, tv_archive_duration: 3 }), { days: 3 });
    assert.deepEqual(catchup.archiveWindow({ tv_archive: '1', tv_archive_duration: '7' }), { days: 7 });
    assert.equal(catchup.archiveWindow({ tv_archive: 0, tv_archive_duration: 3 }), null);
    assert.equal(catchup.archiveWindow({ tv_archive: 1, tv_archive_duration: 0 }), null);
    assert.equal(catchup.archiveWindow({ tv_archive: 1 }), null);
    assert.equal(catchup.archiveWindow(null), null);
    assert.deepEqual(catchup.archiveWindow({ tv_archive: 1, tv_archive_duration: 9999 }), { days: catchup.MAX_ARCHIVE_DAYS });
}

function testProviderTime() {
    const summer = new Date('2026-07-01T18:30:00Z');
    const winter = new Date('2026-01-15T18:30:00Z');
    assert.equal(catchup.formatProviderTime(summer, 'Europe/Amsterdam'), '2026-07-01:20-30');
    assert.equal(catchup.formatProviderTime(winter, 'Europe/Amsterdam'), '2026-01-15:19-30');
    assert.equal(catchup.formatProviderTime(summer, 'America/New_York'), '2026-07-01:14-30');
    // Midnight is written as hour 00, not 24.
    assert.equal(catchup.formatProviderTime(new Date('2026-07-01T22:05:00Z'), 'Europe/Amsterdam'), '2026-07-02:00-05');
    // Without a valid provider time zone the time is written in UTC.
    assert.equal(catchup.formatProviderTime(summer, null), '2026-07-01:18-30');
    assert.equal(catchup.formatProviderTime(summer, 'Not/AZone'), '2026-07-01:18-30');
    assert.equal(catchup.normalizeTimeZone('Europe/Amsterdam'), 'Europe/Amsterdam');
    assert.equal(catchup.normalizeTimeZone('Mars/Base'), null);
    assert.equal(catchup.normalizeTimeZone(42), null);
}

function testResolveRequest() {
    const now = Date.parse('2026-07-01T20:00:00Z');
    const window = { days: 2 };
    const iso = time => new Date(time).toISOString();

    // A programme that ended an hour ago, aligned to minutes.
    const past = catchup.resolveRequest({
        start: iso(now - 2 * 60 * MINUTE), end: iso(now - 60 * MINUTE), window, now
    });
    assert.equal(past.providerStart, now - 2 * 60 * MINUTE);
    assert.equal(past.minutes, 60);
    assert.equal(past.leadInSeconds, 0);

    // A seek to 12m30s into it starts at the whole minute before and still
    // covers the programme's end.
    const seek = catchup.resolveRequest({
        start: iso(now - 2 * 60 * MINUTE + 12.5 * MINUTE), end: iso(now - 60 * MINUTE), window, now
    });
    assert.equal(seek.providerStart, now - 2 * 60 * MINUTE + 12 * MINUTE);
    assert.equal(seek.leadInSeconds, 30);
    assert.equal(seek.minutes, 48);

    // An ongoing programme can be watched from its start.
    const ongoing = catchup.resolveRequest({
        start: iso(now - 10 * MINUTE), end: iso(now + 50 * MINUTE), window, now
    });
    assert.equal(ongoing.minutes, 60);

    // Very long requests are capped.
    const long = catchup.resolveRequest({ start: iso(now - DAY), end: iso(now), window, now });
    assert.equal(long.minutes, catchup.MAX_DURATION_MINUTES);

    const rejects = (args, status, pattern) => assert.throws(
        () => catchup.resolveRequest({ window, now, ...args }),
        error => error.statusCode === status && pattern.test(error.message)
    );
    rejects({ start: iso(now + MINUTE), end: iso(now + 60 * MINUTE) }, 400, /not started/);
    rejects({ start: iso(now - 3 * DAY), end: iso(now - 3 * DAY + 60 * MINUTE) }, 400, /no longer/);
    rejects({ start: iso(now - 60 * MINUTE), end: iso(now - 120 * MINUTE) }, 400, /after the start/);
    rejects({ start: 'yesterday', end: iso(now) }, 400, /start/);
    rejects({ start: iso(now - 60 * MINUTE), end: undefined }, 400, /end/);
    rejects({ start: iso(now - 60 * MINUTE), end: iso(now), window: null }, 404, /not available/);
}

function testTimeshiftUrl() {
    const url = catchup.buildTimeshiftUrl(
        { url: 'http://provider.example:8080/', username: 'user name', password: 'p/ss' },
        '2001',
        Date.parse('2026-07-01T18:30:00Z'),
        90,
        'Europe/Amsterdam'
    );
    assert.equal(url, 'http://provider.example:8080/timeshift/user%20name/p%2Fss/90/2026-07-01:20-30/2001.ts');
}

async function testConfirmAvailable() {
    const respond = status => async (url, options) => {
        assert.equal(options.headers.Range, 'bytes=0-0', 'Only the first byte is requested.');
        return new Response(status === 206 ? 'x' : null, { status });
    };
    await catchup.confirmAvailable('http://provider/x.ts', respond(206));
    await catchup.confirmAvailable('http://provider/x.ts', respond(200));
    await assert.rejects(catchup.confirmAvailable('http://provider/x.ts', respond(403)),
        error => error.statusCode === 404 && /does not have/.test(error.message));
    await assert.rejects(catchup.confirmAvailable('http://provider/x.ts', respond(503)),
        error => error.statusCode === 502 && /unavailable/.test(error.message));
    await assert.rejects(catchup.confirmAvailable('http://provider/x.ts', async () => {
        throw new Error('connect ECONNREFUSED');
    }), error => error.statusCode === 502 && /did not respond/.test(error.message));
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// A minimal Xtream provider with one archive-enabled and one plain channel.
function startProvider(timeshiftRequests) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/player_api.php') {
            const action = url.searchParams.get('action');
            const json = body => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            if (!action) {
                return json({
                    user_info: { username: 'viewer', auth: 1, status: 'Active' },
                    server_info: { timezone: 'Europe/Amsterdam', timestamp_now: Math.floor(Date.now() / 1000) }
                });
            }
            if (action === 'get_live_categories') return json([{ category_id: '1', category_name: 'News' }]);
            if (action === 'get_live_streams') {
                return json([
                    { num: 1, name: 'Archive News', stream_id: 2001, category_id: '1', tv_archive: 1, tv_archive_duration: 3 },
                    { num: 2, name: 'Plain News', stream_id: 2002, category_id: '1', tv_archive: 0, tv_archive_duration: 0 },
                    // Advertises an archive, but the provider refuses its recordings.
                    { num: 3, name: 'Gap News', stream_id: 2003, category_id: '1', tv_archive: 1, tv_archive_duration: 3 }
                ]);
            }
            return json([]);
        }
        if (url.pathname.startsWith('/timeshift/')) {
            timeshiftRequests.push(url.pathname);
            if (url.pathname.endsWith('/2003.ts')) {
                res.writeHead(404);
                return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'video/mp2t' });
            return res.end(Buffer.alloc(188 * 4, 0x47));
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

class CookieJar {
    constructor() { this.cookies = new Map(); }
    absorb(response) {
        for (const header of response.headers.getSetCookie()) {
            const pair = header.split(';', 1)[0];
            const separator = pair.indexOf('=');
            this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
        }
    }
    header() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
}

async function testRoute() {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-catchup-'));
    const timeshiftRequests = [];
    const provider = await startProvider(timeshiftRequests);
    const providerUrl = `http://127.0.0.1:${provider.address().port}`;
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let output = '';
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            NODECAST_DATA_DIR: dataDirectory,
            NODECAST_DISABLE_BACKGROUND_JOBS: 'true',
            // The test provider listens on the loopback interface.
            ALLOW_LOCAL_MEDIA_URLS: 'true',
            PORT: String(port),
            JWT_SECRET: crypto.randomBytes(48).toString('hex'),
            SESSION_SECRET: crypto.randomBytes(48).toString('hex')
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });

    const jar = new CookieJar();
    const request = async (route, { method = 'GET', body, auth = true } = {}) => {
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (auth && jar.header()) headers.Cookie = jar.header();
        const response = await fetch(`${baseUrl}${route}`, {
            method, headers, body: body === undefined ? undefined : JSON.stringify(body)
        });
        jar.absorb(response);
        const text = await response.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
        return { status: response.status, payload };
    };

    try {
        const deadline = Date.now() + 30000;
        while (true) {
            if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
            try {
                if ((await fetch(`${baseUrl}/api/version`)).ok) break;
            } catch { /* starting */ }
            if (Date.now() > deadline) throw new Error('Server did not start');
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        const password = crypto.randomBytes(18).toString('base64url');
        assert.equal((await request('/api/auth/setup', {
            method: 'POST', body: { username: 'admin', password, passwordConfirmation: password }
        })).status, 201);
        const created = await request('/api/sources', {
            method: 'POST',
            body: { type: 'xtream', name: 'Archive provider', url: providerUrl, username: 'viewer', password: 'secret' }
        });
        assert.ok([200, 201].includes(created.status), JSON.stringify(created.payload));
        const sourceId = created.payload.id;

        const syncDeadline = Date.now() + 30000;
        while (true) {
            const summary = await request(`/api/proxy/catalogue/${sourceId}/live/summary`);
            if (summary.status === 200 && JSON.stringify(summary.payload).includes('"News"')) break;
            if (Date.now() > syncDeadline) throw new Error(`Live catalogue not synced: ${JSON.stringify(summary.payload)}`);
            await new Promise(resolve => setTimeout(resolve, 250));
        }

        // The archive fields reach the browser with the channel.
        const channel = await request(`/api/proxy/catalogue/${sourceId}/live/channels/2001`);
        assert.equal(channel.status, 200);
        assert.equal(Number(channel.payload.tv_archive), 1);
        assert.equal(Number(channel.payload.tv_archive_duration), 3);

        const now = Date.now();
        const minute = Math.floor(now / MINUTE) * MINUTE;
        const start = new Date(minute - 120 * MINUTE).toISOString();
        const end = new Date(minute - 60 * MINUTE).toISOString();
        const route = (streamId, from, to) => `/api/proxy/xtream/${sourceId}/catchup/${streamId}?`
            + new URLSearchParams({ start: from, end: to });

        const ok = await request(route(2001, start, end));
        assert.equal(ok.status, 200, JSON.stringify(ok.payload));
        const expectedStart = catchup.formatProviderTime(new Date(start), 'Europe/Amsterdam');
        assert.equal(ok.payload.url, `${providerUrl}/timeshift/viewer/secret/60/${expectedStart}/2001.ts`);
        assert.equal(ok.payload.providerStart, start);
        assert.equal(ok.payload.minutes, 60);

        // The returned URL is accepted by the media proxy, as for live streams.
        const proxied = await fetch(`${baseUrl}/api/proxy/stream?url=${encodeURIComponent(ok.payload.url)}`, {
            headers: { Cookie: jar.header() }
        });
        assert.equal(proxied.status, 200);
        await proxied.arrayBuffer();
        // One request confirms the recording exists, one is the playback.
        assert.equal(timeshiftRequests.length, 2);

        // A recording the provider refuses is reported before playback starts.
        const refused = await request(route(2003, start, end));
        assert.equal(refused.status, 404);
        assert.equal(refused.payload.error, 'The provider archive does not have this programme.');

        assert.equal((await request(route(2002, start, end))).status, 404, 'Channels without an archive have no catch-up.');
        assert.equal((await request(route(9999, start, end))).status, 404);
        assert.equal((await request(route(2001, new Date(now + 10 * MINUTE).toISOString(), new Date(now + 70 * MINUTE).toISOString()))).status, 400);
        assert.equal((await request(route(2001, new Date(now - 5 * DAY).toISOString(), new Date(now - 5 * DAY + 60 * MINUTE).toISOString()))).status, 400);
        assert.equal((await request(route(2001, 'not-a-date', end))).status, 400);
        assert.equal((await request(route(2001, start, end), { auth: false })).status, 401);

        // Provider credentials never appear in the server log.
        assert.equal(output.includes('secret/'), false);
    } catch (error) {
        console.error(output);
        throw error;
    } finally {
        child.kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 500));
        if (child.exitCode === null) child.kill('SIGKILL');
        await new Promise(resolve => provider.close(resolve));
        await fs.rm(dataDirectory, { recursive: true, force: true });
    }
}

async function run() {
    testArchiveWindow();
    testProviderTime();
    testResolveRequest();
    testTimeshiftUrl();
    await testConfirmAvailable();
    await testRoute();
    console.log('Catch-up tests passed.');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
