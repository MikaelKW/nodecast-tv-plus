const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const {
    ReleaseUpdateService,
    compareStableVersions,
    parseStableVersion,
    validateReleaseMetadata,
    constants
} = require('../server/services/releaseUpdates');
const { createRouter } = require('../server/routes/settings');

function releasePayload(version = '2.5.3') {
    return {
        tag_name: `v${version}`,
        html_url: `https://github.com/MikaelKW/nodecast-tv-plus/releases/tag/v${version}`,
        published_at: '2026-08-01T08:00:00Z',
        draft: false,
        prerelease: false
    };
}

function jsonResponse(payload, { status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload)
    };
}

async function listen(app) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function close(server) {
    await new Promise(resolve => server.close(resolve));
}

async function run() {
    assert.deepEqual(parseStableVersion('v2.5.3'), [2, 5, 3]);
    assert.deepEqual(parseStableVersion('2.5.3'), [2, 5, 3]);
    assert.equal(parseStableVersion('v2.5.3-beta.1'), null);
    assert.equal(compareStableVersions('2.5.3', '2.5.2'), 1);
    assert.equal(compareStableVersions('2.5.2', '2.5.2'), 0);
    assert.equal(compareStableVersions('2.4.9', '2.5.2'), -1);

    assert.deepEqual(validateReleaseMetadata(releasePayload()), {
        version: '2.5.3',
        releaseUrl: 'https://github.com/MikaelKW/nodecast-tv-plus/releases/tag/v2.5.3',
        publishedAt: '2026-08-01T08:00:00.000Z'
    });
    assert.throws(
        () => validateReleaseMetadata({ ...releasePayload(), prerelease: true }),
        /unsupported release metadata/
    );
    assert.throws(
        () => validateReleaseMetadata({
            ...releasePayload(),
            html_url: 'https://example.invalid/releases/tag/v2.5.3'
        }),
        /unexpected release link/
    );

    let now = Date.parse('2026-08-01T09:00:00Z');
    let requests = 0;
    let observedRequest;
    const enabledSettings = { get: async () => ({ automaticUpdateChecks: true }) };
    const service = new ReleaseUpdateService({
        currentVersion: '2.5.2',
        settingsStore: enabledSettings,
        now: () => now,
        fetchImpl: async (url, options) => {
            requests += 1;
            observedRequest = { url, options };
            return jsonResponse(releasePayload());
        }
    });

    const initial = await service.getStatus();
    assert.equal(initial.state, 'update-available');
    assert.equal(initial.latestVersion, '2.5.3');
    assert.equal(initial.updateAvailable, true);
    assert.equal(initial.lastCheckedAt, '2026-08-01T09:00:00.000Z');
    assert.equal(requests, 1);
    assert.equal(observedRequest.url, constants.LATEST_RELEASE_API_URL);
    assert.equal(observedRequest.options.redirect, 'error');
    assert.equal(observedRequest.options.headers['User-Agent'], 'NodeCast-TV-Plus/2.5.2');

    await service.getStatus();
    assert.equal(requests, 1, 'a fresh successful result must be cached');
    now += constants.CACHE_TTL_MS + 1;
    await service.getStatus();
    assert.equal(requests, 2, 'an expired result must be refreshed');

    let releaseFetch;
    let concurrentRequests = 0;
    const concurrent = new ReleaseUpdateService({
        currentVersion: '2.5.2',
        settingsStore: enabledSettings,
        fetchImpl: async () => {
            concurrentRequests += 1;
            await new Promise(resolve => { releaseFetch = resolve; });
            return jsonResponse(releasePayload('2.5.2'));
        }
    });
    const firstCheck = concurrent.checkNow();
    const secondCheck = concurrent.checkNow();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(concurrentRequests, 1, 'identical concurrent checks must share one request');
    releaseFetch();
    const [firstStatus, secondStatus] = await Promise.all([firstCheck, secondCheck]);
    assert.equal(firstStatus.state, 'up-to-date');
    assert.equal(secondStatus.state, 'up-to-date');

    let disabledRequests = 0;
    const disabled = new ReleaseUpdateService({
        currentVersion: '2.5.2',
        settingsStore: { get: async () => ({ automaticUpdateChecks: false }) },
        fetchImpl: async () => {
            disabledRequests += 1;
            return jsonResponse(releasePayload());
        }
    });
    assert.equal((await disabled.getStatus()).state, 'disabled');
    assert.equal(disabledRequests, 0, 'disabled automatic checks must not contact GitHub');
    assert.equal((await disabled.checkNow()).state, 'update-available');
    assert.equal(disabledRequests, 1, 'manual checks must remain available');

    const unavailable = new ReleaseUpdateService({
        settingsStore: enabledSettings,
        fetchImpl: async () => jsonResponse({}, { status: 503 })
    });
    const unavailableStatus = await unavailable.checkNow();
    assert.equal(unavailableStatus.state, 'unavailable');
    assert.ok(unavailableStatus.lastErrorAt);

    const fakeAuth = {
        requireAuth: (req, _res, next) => next(),
        requireAdmin: (req, _res, next) => next()
    };
    const fakeReleaseUpdates = {
        getStatus: async () => ({ state: 'up-to-date', currentVersion: '2.5.2' }),
        checkNow: async () => ({ state: 'up-to-date', currentVersion: '2.5.2' })
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { id: 42 };
        next();
    });
    app.use('/api/settings', createRouter({
        authService: fakeAuth,
        releaseUpdateService: fakeReleaseUpdates
    }));
    const server = await listen(app);
    try {
        const { port } = server.address();
        const baseUrl = `http://127.0.0.1:${port}`;
        const statusResponse = await fetch(`${baseUrl}/api/settings/about`);
        assert.equal(statusResponse.status, 200);
        assert.equal((await statusResponse.json()).state, 'up-to-date');

        for (let request = 0; request < 6; request += 1) {
            const response = await fetch(`${baseUrl}/api/settings/about/check`, { method: 'POST' });
            assert.equal(response.status, 200);
        }
        const limited = await fetch(`${baseUrl}/api/settings/about/check`, { method: 'POST' });
        assert.equal(limited.status, 429);

        const invalidPreference = await fetch(`${baseUrl}/api/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ automaticUpdateChecks: 'yes' })
        });
        assert.equal(invalidPreference.status, 400);
    } finally {
        await close(server);
    }

    console.log('Release update checks passed.');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
