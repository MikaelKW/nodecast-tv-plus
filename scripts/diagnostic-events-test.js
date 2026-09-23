'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const diagnostics = require('../server/services/diagnosticEvents');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function waitFor(predicate, description, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const result = await predicate();
            if (result) return result;
        } catch {
            // The isolated application may still be starting.
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`Timed out waiting for ${description}`);
}

async function stopServer(child) {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

async function run() {
    let now = 1000;
    const store = diagnostics.createStore({ now: () => now, maxEvents: 3, maxAgeMs: 1000 });
    const traceId = diagnostics.createTraceId();
    const privateMarker = 'synthetic-private-provider-marker';
    assert.equal(store.record({ traceId, event: 'session_start', reason: 'requested',
        url: `https://example.invalid/?token=${privateMarker}`,
        headers: { Authorization: privateMarker },
        error: { message: privateMarker, cause: { message: privateMarker } },
        args: ['-headers', privateMarker],
        metadata: { nested: [privateMarker] }
    }), true);
    assert.equal(JSON.stringify(store.list()).includes(privateMarker), false);
    assert.equal(store.record({ traceId, event: 'sync_failed', reason: 'sync_error', sourceId: 1 }), true);
    assert.equal(store.record({ traceId, event: 'sync_failed', reason: 'requested', sourceId: 1 }), false);
    assert.equal(store.record({ traceId, event: 'browser_path_selected', reason: 'direct_hls',
        url: `https://example.invalid/?token=${privateMarker}`,
        error: { message: privateMarker }
    }), true);
    assert.equal(JSON.stringify(store.list()).includes(privateMarker), false);
    assert.equal(store.record({ traceId, event: 'browser_path_selected', reason: 'sync_error' }), false);
    assert.equal(store.record({ traceId: privateMarker, event: 'session_start', reason: 'requested' }), false);
    assert.equal(store.record({ traceId, event: 'sync_start', reason: 'requested', sourceId: privateMarker }), false);
    assert.equal(store.record({ get traceId() { throw new Error(privateMarker); } }), false);
    store.record({ traceId, event: 'playback_ready', reason: 'playlist_ready' });
    store.record({ traceId, event: 'session_cleanup', reason: 'cleanup_requested' });
    assert.equal(store.list().length, 3, 'event count must stay bounded');
    const copy = store.list();
    copy[0].reason = privateMarker;
    assert.notEqual(store.list()[0].reason, privateMarker, 'readers must not mutate stored events');
    now = 2001;
    assert.equal(store.list().length, 0, 'old events must expire');
    const boundedStore = diagnostics.createStore();
    for (let index = 0; index < 1000; index += 1) {
        boundedStore.record({ traceId, event: 'session_start', reason: 'requested' });
    }
    assert.equal(boundedStore.list(1000).length, diagnostics.MAX_EVENTS);
    assert.ok(Buffer.byteLength(JSON.stringify(boundedStore.list(1000))) < 64 * 1024);

    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-diagnostic-events-'));
    const port = await getFreePort();
    const fixture = http.createServer((_req, res) => {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end(privateMarker);
    });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const fixturePort = fixture.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const revision = crypto.randomBytes(20).toString('hex');
    let output = '';
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            NODE_ENV: 'test',
            NODECAST_DATA_DIR: dataDirectory,
            NODECAST_CACHE_DIR: path.join(dataDirectory, 'cache'),
            NODECAST_DISABLE_BACKGROUND_JOBS: 'true',
            ALLOW_LOCAL_MEDIA_URLS: 'true',
            PORT: String(port),
            NODECAST_REVISION: revision,
            JWT_SECRET: crypto.randomBytes(48).toString('hex'),
            SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
            OIDC_ISSUER_URL: '',
            OIDC_CLIENT_ID: '',
            OIDC_CLIENT_SECRET: '',
            DISABLE_LOCAL_AUTH: '',
            OIDC_AUTO_REDIRECT: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });

    try {
        await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok, 'application readiness');
        const unauthenticated = await fetch(`${baseUrl}/api/diagnostics/events`);
        assert.equal(unauthenticated.status, 401);
        const unauthenticatedSummary = await fetch(`${baseUrl}/api/diagnostics/summary`);
        assert.equal(unauthenticatedSummary.status, 401);
        const unauthenticatedReport = await fetch(`${baseUrl}/api/diagnostics/playback-path`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'direct_hls' })
        });
        assert.equal(unauthenticatedReport.status, 401);

        const adminPassword = crypto.randomBytes(24).toString('base64url');
        const setup = await fetch(`${baseUrl}/api/auth/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'diagnostic-admin',
                password: adminPassword,
                passwordConfirmation: adminPassword
            })
        });
        assert.equal(setup.status, 201);
        const adminCookie = (setup.headers.get('set-cookie') || '').split(';', 1)[0];
        assert.ok(adminCookie);
        const adminHeaders = { Cookie: adminCookie, 'Content-Type': 'application/json' };

        const viewerPassword = crypto.randomBytes(24).toString('base64url');
        const createViewer = await fetch(`${baseUrl}/api/auth/users`, {
            method: 'POST', headers: adminHeaders,
            body: JSON.stringify({
                username: 'diagnostic-viewer', role: 'viewer',
                password: viewerPassword, passwordConfirmation: viewerPassword
            })
        });
        assert.equal(createViewer.status, 201);
        const viewerLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'diagnostic-viewer', password: viewerPassword })
        });
        assert.equal(viewerLogin.status, 200);
        const viewerCookie = (viewerLogin.headers.get('set-cookie') || '').split(';', 1)[0];
        assert.ok(viewerCookie);
        const viewer = await fetch(`${baseUrl}/api/diagnostics/events`, {
            headers: { Cookie: viewerCookie }
        });
        assert.equal(viewer.status, 403);
        const viewerSummary = await fetch(`${baseUrl}/api/diagnostics/summary`, {
            headers: { Cookie: viewerCookie }
        });
        assert.equal(viewerSummary.status, 403);
        const rejectedReport = await fetch(`${baseUrl}/api/diagnostics/playback-path`, {
            method: 'POST', headers: { Cookie: viewerCookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'process_error', url: privateMarker })
        });
        assert.equal(rejectedReport.status, 400);
        const acceptedReport = await fetch(`${baseUrl}/api/diagnostics/playback-path`, {
            method: 'POST', headers: { Cookie: viewerCookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                reason: 'direct_hls', url: `https://example.invalid/?token=${privateMarker}`,
                headers: { Authorization: privateMarker },
                error: { message: privateMarker, cause: { message: privateMarker } },
                args: ['-headers', privateMarker], metadata: { nested: [privateMarker] }
            })
        });
        assert.equal(acceptedReport.status, 204);
        assert.equal(acceptedReport.headers.get('cache-control'), 'no-store');

        const sourceUrl = `http://127.0.0.1:${fixturePort}/playlist.m3u?token=${privateMarker}`;
        const createSource = await fetch(`${baseUrl}/api/sources`, {
            method: 'POST', headers: adminHeaders,
            body: JSON.stringify({ type: 'm3u', name: privateMarker, url: sourceUrl })
        });
        assert.equal(createSource.status, 201);
        const source = await createSource.json();
        const observed = await waitFor(async () => {
            const response = await fetch(`${baseUrl}/api/diagnostics/events?limit=999`, {
                headers: { Cookie: adminCookie }
            });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            const payload = await response.json();
            assert.ok(Array.isArray(payload.events));
            assert.ok(payload.events.length <= 100);
            return payload.events.some(event => event.event === 'sync_failed' && event.sourceId === source.id)
                ? payload.events : null;
        }, 'synthetic synchronization failure');
        const related = observed.filter(event => event.sourceId === source.id);
        assert.ok(related.some(event => event.event === 'sync_start'));
        assert.ok(related.some(event => event.event === 'sync_failed' && event.reason === 'sync_error'));
        assert.equal(new Set(related.map(event => event.traceId)).size, 1);
        assert.equal(JSON.stringify(observed).includes(privateMarker), false);
        assert.equal(JSON.stringify(observed).includes(sourceUrl), false);

        const summaryResponse = await fetch(`${baseUrl}/api/diagnostics/summary`, {
            headers: { Cookie: adminCookie }
        });
        assert.equal(summaryResponse.status, 200);
        assert.equal(summaryResponse.headers.get('cache-control'), 'no-store');
        const summary = await summaryResponse.json();
        assert.equal(summary.version, require('../package.json').version);
        assert.equal(summary.revision, revision);
        assert.ok(Number.isSafeInteger(summary.resources.processUptimeSeconds));
        assert.ok(Number.isSafeInteger(summary.resources.processRssBytes));
        assert.ok(Array.isArray(summary.playback.managedSessions));
        assert.equal(summary.synchronization.available, true);
        assert.ok(summary.synchronization.sources.some(item => (
            item.sourceId === source.id && item.status === 'error'
        )));
        assert.ok(summary.events.some(event => event.event === 'sync_failed'));
        assert.ok(summary.events.some(event => event.event === 'browser_path_selected'
            && event.reason === 'direct_hls'
            && event.reasonText === 'The browser plays HLS without conversion.'));
        assert.ok(summary.events.length <= 50);
        assert.equal(summary.retention.maxEvents, diagnostics.MAX_EVENTS);
        assert.equal(JSON.stringify(summary).includes(privateMarker), false);
        assert.equal(JSON.stringify(summary).includes(sourceUrl), false);
        assert.equal(JSON.stringify(summary).includes('errorText'), false);

        console.log('Diagnostic event, admin summary, access control, bounded storage, and sync trace tests passed.');
    } catch (error) {
        console.error(output.replaceAll(privateMarker, '[synthetic marker]'));
        throw error;
    } finally {
        await stopServer(child);
        await new Promise(resolve => fixture.close(resolve));
        await fs.rm(dataDirectory, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
