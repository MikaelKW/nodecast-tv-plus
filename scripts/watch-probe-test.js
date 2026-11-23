'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const express = require('express');

const root = path.join(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {} };
const metadata = { video: 'h264', audio: 'aac', height: 720, compatible: true };
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
async function bounded(promise) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Probe test did not settle')), 10000);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

async function testClientCancellation() {
    let settings = {};
    let fetchHandler;
    const context = vm.createContext({
        window: {}, console: quiet, AbortController,
        NodeCastUrl: { resolve: value => value, remux: value => value },
        VodDuration: { firstValid: () => 0, fromContent: () => 0 },
        PlaybackQuality: { getHeight: () => 0 },
        API: { settings: { get: async () => settings } },
        fetch: (...args) => fetchHandler(...args),
        setTimeout, clearTimeout, setInterval, clearInterval
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'public/js/pages/WatchPage.js'), 'utf8'), context);
    const WatchPage = context.window.WatchPage;
    const makeWatch = () => Object.assign(Object.create(WatchPage.prototype), {
        _diagnosticPlayId: 0, playbackQuality: 'auto', content: {}, resumeTime: 0,
        video: {
            src: '', plays: 0,
            play() { this.plays += 1; return Promise.resolve(); },
            pause() {}, removeAttribute() {}, load() {}
        },
        nativeSubtitleContexts: new Set(),
        stop() { this.playbackProbeController?.abort(); this._diagnosticPlayId += 1; },
        setSourceDuration() {}, showLoading() {}, updateTranscodeStatus() {},
        setVolumeFromStorage() {}, updateQualityBadge() {}, applyProbeTracks(info) { this.tracks = info; },
        reportBrowserPlaybackPath() {}, finishBrowserPlayback() {},
        stopHistoryTracking() {}, setActiveSubtitleTrack() {}, stopTranscodeSession() {},
        cancelProbeSubtitleLoads() {}, resetDurationDisplay() {}, hideNowPlaying() {},
        getSelectedAudioOptions() { return {}; },
        startTranscodeSession: async () => '/synthetic.m3u8', playHls() {}
    });

    for (const mode of ['optional', 'auto', 'forced-audio']) {
        settings = { autoTranscode: mode === 'auto', forceTranscode: mode === 'forced-audio' };
        for (const phase of ['headers', 'body']) {
            const started = deferred();
            let signal;
            let requests = 0;
            fetchHandler = async (url, options) => {
                assert.ok(url.startsWith('/api/probe?'));
                requests += 1;
                // Forced-audio playback first performs optional track discovery.
                if (mode === 'forced-audio' && requests === 1) {
                    return { ok: true, json: async () => metadata };
                }
                signal = options.signal;
                const pending = () => new Promise((_, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                    started.resolve();
                });
                return phase === 'headers' ? pending() : { ok: true, json: pending };
            };
            const watch = makeWatch();
            const old = watch.loadVideo('https://example.invalid/old.mp4').catch(error => error);
            await bounded(started.promise);
            await watch.loadVideo('https://example.invalid/last.mp4', { forceDirectFallback: true });
            assert.equal((await bounded(old)).name, 'AbortError', `${mode}/${phase} must cancel`);
            assert.equal(signal.aborted, true);
            assert.equal(watch.video.src, 'https://example.invalid/last.mp4');
            assert.equal(watch.video.plays, 1, 'only the final selection starts playback');
            assert.equal(watch.playbackProbeController, null);
        }

        fetchHandler = async () => ({ ok: true, json: async () => metadata });
        const watch = makeWatch();
        await watch.loadVideo('https://example.invalid/normal.mp4');
        assert.equal(watch.currentStreamInfo, metadata, `${mode} retains successful metadata`);
        assert.equal(watch.tracks, metadata);

        fetchHandler = async () => ({ ok: false, status: 503 });
        const failed = makeWatch();
        await failed.loadVideo('https://example.invalid/unavailable.mp4');
        assert.equal(failed.playbackProbeController, null);
        if (mode !== 'forced-audio') {
            assert.equal(failed.video.src, 'https://example.invalid/unavailable.mp4',
                'a failed optional or smart probe retains ordinary playback fallback');
        }
    }

    const watch = makeWatch();
    const started = deferred();
    fetchHandler = (url, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started.resolve();
    });
    const first = watch.probePlayback('https://example.invalid/one.mp4', '', 0).catch(error => error);
    await started.promise;
    const second = watch.probePlayback('https://example.invalid/two.mp4', '', 0).catch(error => error);
    const currentController = watch.playbackProbeController;
    assert.equal((await first).name, 'AbortError');
    assert.equal(watch.playbackProbeController, currentController, 'old finally cannot clear the new owner');
    WatchPage.prototype.stop.call(watch, { saveHistory: false });
    assert.equal((await second).name, 'AbortError');
    assert.equal(currentController.signal.aborted, true, 'closing Watch cancels its probe');
    assert.equal(watch.playbackProbeController, null);

    fetchHandler = async () => ({ ok: false, status: 503 });
    await assert.rejects(watch.probePlayback('https://example.invalid/failure.mp4', '', watch._diagnosticPlayId), /503/);
    assert.equal(watch.playbackProbeController, null, 'failed requests release client ownership');
}

async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
}

async function testServerDisconnect() {
    let providerStarted;
    let providerClosed;
    const provider = http.createServer((req, res) => {
        const closed = providerClosed;
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.flushHeaders();
        req.once('close', () => closed.resolve());
        providerStarted.resolve();
        // Deliberately hold the input open until the probe is cancelled.
    });
    const providerUrl = await listen(provider);
    const children = [];
    let authorizationStarted;
    let finishAuthorization;
    const realRequire = require;
    const moduleObject = { exports: {} };
    const routeContext = vm.createContext({
        module: moduleObject, console: quiet, AbortController, setTimeout, clearTimeout,
        require(name) {
            if (name === '../auth') return { requireAuth(req, res, next) { req.user = { id: 'probe-test' }; next(); } };
            if (name === '../services/mediaAccess') return {
                async authorizeMediaUrl(url) {
                    if (url.endsWith('/authorization')) {
                        authorizationStarted.resolve();
                        await finishAuthorization.promise;
                    }
                    return url;
                }
            };
            if (name === 'child_process') return {
                spawn(...args) {
                    const child = spawn(...args);
                    const closed = new Promise(resolve => child.once('close', resolve));
                    children.push({ child, closed });
                    return child;
                }
            };
            return name.startsWith('.') ? realRequire(path.resolve(root, 'server/routes', name)) : realRequire(name);
        }
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'server/routes/probe.js'), 'utf8'), routeContext);
    const app = express();
    app.locals.ffprobePath = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0
        ? 'ffprobe' : require('@ffprobe-installer/ffprobe').path;
    app.use('/api/probe', moduleObject.exports);
    const server = http.createServer(app);
    const appUrl = await listen(server);
    const disconnected = [];
    server.on('request', (req, res) => {
        const closed = deferred();
        res.once('close', () => closed.resolve());
        disconnected.push(closed.promise);
    });
    const requestProbe = url => {
        const request = http.get(`${appUrl}/api/probe?url=${encodeURIComponent(url)}`);
        request.on('error', () => {}); // Deliberate client disconnect below.
        return request;
    };
    try {
        // More cancellations than the per-account process limit also exercise
        // slot release and prove cancelled probes do not populate the cache.
        for (let attempt = 0; attempt < 4; attempt += 1) {
            providerStarted = deferred();
            providerClosed = deferred();
            const request = requestProbe(`${providerUrl}/pending.ts`);
            await bounded(providerStarted.promise);
            assert.equal(children.length, attempt + 1);
            request.destroy();
            await bounded(providerClosed.promise);
            await bounded(children[attempt].closed);
            assert.notEqual(children[attempt].child.exitCode, 0, 'disconnected input must terminate ffprobe');
        }

        authorizationStarted = deferred();
        finishAuthorization = deferred();
        const authorizing = requestProbe(`${providerUrl}/authorization`);
        await bounded(authorizationStarted.promise);
        authorizing.destroy();
        await bounded(disconnected.at(-1));
        finishAuthorization.resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(children.length, 4, 'disconnect during authorization must not spawn ffprobe');
    } finally {
        finishAuthorization?.resolve();
        for (const { child } of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        server.closeAllConnections();
        provider.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    }
}

(async () => {
    await testClientCancellation();
    await testServerDisconnect();
    console.log('Watch probe cancellation checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
