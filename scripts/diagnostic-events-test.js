'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vm = require('node:vm');
const diagnostics = require('../server/services/diagnosticEvents');
const browserPlaybackTraces = require('../server/services/browserPlaybackTraces');
const supportSnapshot = require('../server/services/supportSnapshot');

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

async function testDiagnosticsPanelInvalidation() {
    const elements = new Map();
    const makeElement = () => ({
        textContent: '', hidden: true, disabled: false,
        addEventListener() {}, replaceChildren() {}
    });
    let summaryDenied = false;
    const context = {
        window: {}, Blob,
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, makeElement());
                return elements.get(id);
            }
        },
        API: { diagnostics: {
            async getSupportPreview() {
                return { schemaVersion: 1, application: { version: 'test' } };
            },
            async getSummary() {
                if (summaryDenied) throw new Error('Forbidden');
                return null;
            }
        } },
        setTimeout() { return 1; }, clearTimeout() {}
    };
    vm.createContext(context);
    vm.runInContext(await fs.readFile(path.join(__dirname, '..', 'public/js/components/DiagnosticsPanel.js'), 'utf8'), context);
    const panel = new context.window.DiagnosticsPanel();
    panel.visible = true;
    await panel.loadPreview();
    assert.ok(panel.snapshotText);
    assert.equal(panel.preview.hidden, false);
    assert.equal(panel.downloadButton.disabled, false);

    summaryDenied = true;
    await panel.load();
    assert.equal(panel.snapshotText, null, 'access loss must remove a prepared snapshot');
    assert.equal(panel.preview.hidden, true);
    assert.equal(panel.downloadButton.disabled, true);

    let resolvePreview;
    context.API.diagnostics.getSupportPreview = () => new Promise(resolve => { resolvePreview = resolve; });
    const pendingPreview = panel.loadPreview();
    await Promise.resolve();
    await panel.load();
    resolvePreview({ schemaVersion: 1, application: { version: 'stale' } });
    await pendingPreview;
    assert.equal(panel.snapshotText, null, 'an in-flight preview must not repopulate after access loss');
    assert.equal(panel.preview.hidden, true);
    assert.equal(panel.downloadButton.disabled, true);
}

async function testBrowserClientDiagnostics() {
    const liveRequests = [];
    let liveRenewal;
    const liveContext = {
        window: {},
        document: {},
        NodeCastUrl: { resolve: value => value },
        fetch: async (url, options = {}) => {
            liveRequests.push({ url, options });
            return { ok: true, json: async () => ({}) };
        },
        setInterval(callback) { liveRenewal = callback; return 1; },
        clearInterval() {}
    };
    vm.createContext(liveContext);
    vm.runInContext(await fs.readFile(path.join(__dirname, '..', 'public/js/components/VideoPlayer.js'), 'utf8'), liveContext);
    const player = Object.create(liveContext.window.VideoPlayer.prototype);
    Object.assign(player, { _playId: 1, browserPlaybackAttempt: null, browserPlaybackRenewalTimer: null });
    player.linkManagedPlaybackTrace(diagnostics.createTraceId(), 1);
    player.reportBrowserPlaybackFailure({ name: 'NotAllowedError' }, 1);
    player.recordBrowserPlaybackStarted(1);
    player.recordBrowserPlaybackStarted(1);
    const liveAttempt = player.browserPlaybackAttempt;
    await liveAttempt.queue;
    liveRenewal();
    await liveAttempt.queue;
    player.finishBrowserPlayback('browser_stopped');
    await liveAttempt.queue;
    const liveBodies = liveRequests.filter(item => item.options.body).map(item => JSON.parse(item.options.body));
    assert.deepEqual(liveBodies.map(item => item.event), [
        'browser_playback_failed', 'browser_playback_started', 'browser_playback_stopped'
    ]);
    assert.equal(liveRequests.filter(item => item.url.endsWith('/renew')).length, 1);

    const watchRequests = [];
    let watchTrace = diagnostics.createTraceId();
    const privateMarker = 'private-watch-provider-marker';
    const watchContext = {
        window: {},
        console: { log() {}, warn() {}, error() {} },
        NodeCastUrl: { resolve: value => value, remux: value => value },
        VodDuration: { firstValid: () => 0, fromContent: () => 0 },
        API: { settings: { get: async () => ({}) } },
        fetch: async (url, options = {}) => {
            watchRequests.push({ url, options });
            if (url === '/api/diagnostics/playback-path') {
                return { ok: true, json: async () => ({ traceId: watchTrace }) };
            }
            if (url === '/api/transcode/session') {
                watchTrace = diagnostics.createTraceId();
                return { ok: true, json: async () => ({
                    sessionId: 'test-session', diagnosticTraceId: watchTrace,
                    playlistUrl: '/test.m3u8', mediaStartTime: 0
                }) };
            }
            return { ok: true, json: async () => ({}) };
        },
        setInterval() { return 1; }, clearInterval() {},
        clearTimeout() {}, setTimeout(callback) { callback(); return 1; }
    };
    vm.createContext(watchContext);
    vm.runInContext(await fs.readFile(path.join(__dirname, '..', 'public/js/pages/WatchPage.js'), 'utf8'), watchContext);
    const watch = Object.create(watchContext.window.WatchPage.prototype);
    Object.assign(watch, {
        _diagnosticPlayId: 0, browserPlaybackAttempt: null, browserPlaybackRenewalTimer: null,
        playbackQuality: 'auto', content: {}, resumeTime: 0, currentStreamInfo: null,
        video: { src: '', play: async () => {}, paused: true },
        stop() {
            this.finishBrowserPlayback('browser_stopped');
            this._diagnosticPlayId += 1;
        },
        setSourceDuration() {}, showLoading() {}, updateTranscodeStatus() {}, setVolumeFromStorage() {}
    });
    await watch.loadVideo(`https://example.invalid/${privateMarker}.mp4`, { skipProbe: true });
    watch.recordBrowserPlaybackStarted(watch._diagnosticPlayId);
    const directAttempt = watch.browserPlaybackAttempt;
    await directAttempt.queue;
    assert.ok(watchRequests.some(item => item.url === '/api/diagnostics/playback-path'
        && JSON.parse(item.options.body).reason === 'direct_media'));
    assert.ok(watchRequests.some(item => item.url.includes('/api/diagnostics/playback/')
        && JSON.parse(item.options.body).event === 'browser_playback_started'));

    await watch.startTranscodeSession(`https://example.invalid/${privateMarker}.mp4`);
    watch.recordBrowserPlaybackStarted(watch._diagnosticPlayId);
    const managedAttempt = watch.browserPlaybackAttempt;
    await directAttempt.queue;
    await managedAttempt.queue;
    assert.ok(watchRequests.some(item => item.url.includes(encodeURIComponent(watchTrace))
        && item.options.body && JSON.parse(item.options.body).event === 'browser_playback_started'));
    const diagnosticRequests = watchRequests.filter(item => item.url.includes('/api/diagnostics/'));
    assert.equal(JSON.stringify(diagnosticRequests).includes(privateMarker), false);
}

async function run() {
    await testDiagnosticsPanelInvalidation();
    await testBrowserClientDiagnostics();
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
    const maliciousSummary = {
        version: '2.6.2', revision: 'a'.repeat(40),
        resources: { processUptimeSeconds: 42, processRssBytes: 1000,
            processHeapUsedBytes: 500, secret: privateMarker },
        playback: { managedSessions: [{ traceId, status: 'running', ageSeconds: 3,
            url: privateMarker, args: [privateMarker], metadata: { nested: privateMarker } }] },
        synchronization: { available: true, sources: [{ sourceId: 4, status: 'error',
            at: new Date().toISOString(), url: privateMarker,
            error: { cause: { message: privateMarker } } }] },
        events: [{ at: new Date().toISOString(), traceId, domain: 'playback',
            event: 'session_start', reason: 'requested', reasonText: privateMarker,
            headers: { Authorization: privateMarker }, query: `token=${privateMarker}` }],
        rawLogs: privateMarker,
        user: { email: privateMarker }
    };
    const safeSnapshot = supportSnapshot.createSnapshot(maliciousSummary);
    assert.deepEqual(Object.keys(safeSnapshot), [
        'schemaVersion', 'generatedAt', 'application', 'resources', 'playback',
        'synchronization', 'events', 'retention'
    ]);
    assert.equal(safeSnapshot.events[0].reasonText, 'Playback was requested.');
    assert.equal(JSON.stringify(safeSnapshot).includes(privateMarker), false);
    assert.equal(Buffer.byteLength(JSON.stringify(safeSnapshot, null, 2) + '\n') <= supportSnapshot.MAX_EXPORT_BYTES, true);
    maliciousSummary.events = Array.from({ length: 1000 }, () => maliciousSummary.events[0]);
    assert.equal(supportSnapshot.createSnapshot(maliciousSummary).events.length <= supportSnapshot.MAX_EXPORT_EVENTS, true);
    maliciousSummary.events[0] = { ...maliciousSummary.events[0], reason: privateMarker };
    assert.equal(supportSnapshot.createSnapshot(maliciousSummary).events.some(event => event.reason === privateMarker), false);

    const lifecycleEvents = diagnostics.createStore({ now: () => now });
    const lifecycle = browserPlaybackTraces.createStore({
        now: () => now,
        maxTraces: 2,
        maxAgeMs: 1000,
        events: { ...lifecycleEvents, createTraceId: diagnostics.createTraceId }
    });
    now = 3000;
    const firstTrace = lifecycle.start(1, 'direct_hls');
    assert.ok(firstTrace);
    assert.equal(lifecycle.record(2, firstTrace, 'browser_playback_started', 'media_playing'), false);
    assert.equal(lifecycle.record(1, firstTrace, 'browser_playback_started', privateMarker), false);
    assert.equal(lifecycle.record(1, firstTrace, 'browser_playback_started', 'media_playing'), true);
    assert.equal(lifecycle.record(1, firstTrace, 'browser_proxy_retry', 'proxy_retry'), true);
    assert.equal(lifecycle.record(1, firstTrace, 'browser_path_selected', 'proxied_hls'), true);
    assert.equal(lifecycle.record(1, firstTrace, 'browser_playback_stopped', 'browser_stopped'), true);
    assert.equal(lifecycle.record(1, firstTrace, 'browser_playback_started', 'media_playing'), false);
    assert.equal(new Set(lifecycleEvents.list().map(event => event.traceId)).size, 1);
    assert.equal(lifecycle.start(1, privateMarker), null);
    const evictedTrace = lifecycle.start(1, 'native_hls');
    const retainedTrace = lifecycle.start(1, 'direct_media');
    lifecycle.start(1, 'auto_remux');
    assert.equal(lifecycle.record(1, evictedTrace, 'browser_playback_started', 'media_playing'), false);
    assert.equal(lifecycle.record(1, retainedTrace, 'browser_playback_started', 'media_playing'), true);
    now = 3900;
    assert.equal(lifecycle.renew(2, retainedTrace), false, 'a trace cannot be renewed by another account');
    assert.equal(lifecycle.renew(1, retainedTrace), true);
    now = 4001;
    assert.equal(lifecycle.record(1, retainedTrace, 'browser_playback_started', 'media_playing'), true,
        'recently renewed playback must remain reportable after its original expiry time');
    now = 5002;
    assert.equal(lifecycle.record(1, retainedTrace, 'browser_playback_started', 'media_playing'), false,
        'inactive traces must still expire');
    const managedTraceId = diagnostics.createTraceId();
    assert.equal(lifecycle.registerManaged(1, privateMarker), false);
    assert.equal(lifecycle.registerManaged(1, managedTraceId), true);
    assert.equal(lifecycle.registerManaged(2, managedTraceId), false, 'a managed trace cannot change owners');
    assert.equal(lifecycle.record(2, managedTraceId, 'browser_playback_started', 'media_playing'), false);
    assert.equal(lifecycle.record(1, managedTraceId, 'browser_path_selected', 'proxied_hls'), false);
    assert.equal(lifecycle.record(1, managedTraceId, 'browser_proxy_retry', 'proxy_retry'), false);
    assert.equal(lifecycle.record(1, managedTraceId, 'browser_playback_started', 'media_playing'), true);
    assert.equal(lifecycle.record(1, managedTraceId, 'browser_playback_failed', 'hls_failed'), true);
    assert.equal(lifecycle.record(1, managedTraceId, 'browser_playback_stopped', 'browser_replaced'), true);
    assert.equal(lifecycle.record(1, managedTraceId, 'browser_playback_started', 'media_playing'), false);
    assert.equal(new Set(lifecycleEvents.list().filter(event => event.traceId === managedTraceId)
        .map(event => event.reason)).has('hls_failed'), true);

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
        const unauthenticatedPreview = await fetch(`${baseUrl}/api/diagnostics/support-preview`);
        assert.equal(unauthenticatedPreview.status, 401);
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
        const viewerPreview = await fetch(`${baseUrl}/api/diagnostics/support-preview`, {
            headers: { Cookie: viewerCookie }
        });
        assert.equal(viewerPreview.status, 403);
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
        assert.equal(acceptedReport.status, 201);
        assert.equal(acceptedReport.headers.get('cache-control'), 'no-store');
        const browserTraceId = (await acceptedReport.json()).traceId;
        assert.match(browserTraceId, /^[0-9a-f-]{36}$/i);
        const reportEvent = (cookie, trace, event, reason) => fetch(
            `${baseUrl}/api/diagnostics/playback/${encodeURIComponent(trace)}/events`, {
                method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ event, reason, url: privateMarker,
                    error: { message: privateMarker }, metadata: { nested: [privateMarker] } })
            }
        );
        const unauthenticatedEvent = await reportEvent('', browserTraceId, 'browser_playback_started', 'media_playing');
        assert.equal(unauthenticatedEvent.status, 401);
        const invalidEvent = await reportEvent(viewerCookie, browserTraceId, 'browser_playback_failed', privateMarker);
        assert.equal(invalidEvent.status, 404);
        const startedEvent = await reportEvent(viewerCookie, browserTraceId, 'browser_playback_started', 'media_playing');
        assert.equal(startedEvent.status, 204);
        const differentAccountRenew = await fetch(
            `${baseUrl}/api/diagnostics/playback/${encodeURIComponent(browserTraceId)}/renew`,
            { method: 'POST', headers: { Cookie: adminCookie } }
        );
        assert.equal(differentAccountRenew.status, 404);
        const renewedEvent = await fetch(
            `${baseUrl}/api/diagnostics/playback/${encodeURIComponent(browserTraceId)}/renew`,
            { method: 'POST', headers: { Cookie: viewerCookie } }
        );
        assert.equal(renewedEvent.status, 204);
        assert.equal(renewedEvent.headers.get('cache-control'), 'no-store');
        const differentAccountEvent = await reportEvent(adminCookie, browserTraceId, 'browser_proxy_retry', 'proxy_retry');
        assert.equal(differentAccountEvent.status, 404);
        const retryEvent = await reportEvent(viewerCookie, browserTraceId, 'browser_proxy_retry', 'proxy_retry');
        assert.equal(retryEvent.status, 204);
        const proxiedEvent = await reportEvent(viewerCookie, browserTraceId, 'browser_path_selected', 'proxied_hls');
        assert.equal(proxiedEvent.status, 204);
        const stoppedEvent = await reportEvent(viewerCookie, browserTraceId, 'browser_playback_stopped', 'browser_stopped');
        assert.equal(stoppedEvent.status, 204);
        const lateEvent = await reportEvent(viewerCookie, browserTraceId, 'browser_playback_started', 'media_playing');
        assert.equal(lateEvent.status, 404);
        const lateRenew = await fetch(
            `${baseUrl}/api/diagnostics/playback/${encodeURIComponent(browserTraceId)}/renew`,
            { method: 'POST', headers: { Cookie: viewerCookie } }
        );
        assert.equal(lateRenew.status, 404);

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
            && event.reasonText === 'HLS playback without conversion was selected.'));
        const browserEvents = summary.events.filter(event => event.traceId === browserTraceId);
        assert.deepEqual(browserEvents.map(event => event.event).reverse(), [
            'browser_path_selected', 'browser_playback_started', 'browser_proxy_retry',
            'browser_path_selected', 'browser_playback_stopped'
        ]);
        assert.ok(summary.events.length <= 50);
        assert.equal(summary.retention.maxEvents, diagnostics.MAX_EVENTS);
        assert.equal(JSON.stringify(summary).includes(privateMarker), false);
        assert.equal(JSON.stringify(summary).includes(sourceUrl), false);
        assert.equal(JSON.stringify(summary).includes('errorText'), false);

        const previewResponse = await fetch(`${baseUrl}/api/diagnostics/support-preview`, {
            headers: { Cookie: adminCookie }
        });
        assert.equal(previewResponse.status, 200);
        assert.equal(previewResponse.headers.get('cache-control'), 'no-store');
        const preview = await previewResponse.json();
        assert.equal(preview.schemaVersion, 1);
        assert.equal(preview.application.version, require('../package.json').version);
        assert.equal(preview.application.revision, revision);
        assert.ok(preview.events.some(event => event.event === 'sync_failed'));
        assert.ok(preview.events.some(event => event.traceId === browserTraceId));
        assert.equal(JSON.stringify(preview).includes(privateMarker), false);
        assert.equal(JSON.stringify(preview).includes(sourceUrl), false);
        assert.ok(Buffer.byteLength(JSON.stringify(preview, null, 2) + '\n') <= supportSnapshot.MAX_EXPORT_BYTES);

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
