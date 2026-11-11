const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const { normalizeAccountInfo } = require('../server/services/xtreamApi');

const projectRoot = path.join(__dirname, '..');
const NOW = Date.parse('2026-11-05T12:00:00Z');
const DAY_SECONDS = 24 * 60 * 60;
const nowSeconds = Math.floor(NOW / 1000);

function testNormalize() {
    const account = normalizeAccountInfo({
        user_info: {
            username: 'provider-user',
            password: 'provider-password',
            message: 'Welcome',
            auth: 1,
            status: 'Active',
            exp_date: String(nowSeconds + 30 * DAY_SECONDS),
            is_trial: '0',
            active_cons: '1',
            created_at: String(nowSeconds - 365 * DAY_SECONDS),
            max_connections: '2',
            allowed_output_formats: ['m3u8', 'ts']
        },
        server_info: { url: 'provider.example', port: '8080' }
    }, NOW);

    assert.deepEqual(account, {
        authorized: true,
        status: 'Active',
        active: true,
        expiresAt: new Date((nowSeconds + 30 * DAY_SECONDS) * 1000).toISOString(),
        expired: false,
        isTrial: false,
        maxConnections: 2,
        activeConnections: 1,
        createdAt: new Date((nowSeconds - 365 * DAY_SECONDS) * 1000).toISOString()
    });
    assert.ok(!JSON.stringify(account).includes('provider-password'), 'Credentials are never returned.');

    // Panels report numbers as numbers or strings, and no end date as null, "" or 0.
    for (const expDate of [null, '', '0', 0, undefined]) {
        const unlimited = normalizeAccountInfo({ user_info: { auth: '1', status: 'Active', exp_date: expDate } }, NOW);
        assert.equal(unlimited.expiresAt, null);
        assert.equal(unlimited.expired, false);
        assert.equal(unlimited.active, true);
    }

    const expired = normalizeAccountInfo({
        user_info: { auth: 1, status: 'Active', exp_date: nowSeconds - 60, is_trial: 1, max_connections: 1, active_cons: 0 }
    }, NOW);
    assert.equal(expired.expired, true);
    assert.equal(expired.active, false, 'An account past its end date is not active, whatever the status says.');
    assert.equal(expired.isTrial, true);
    assert.equal(expired.activeConnections, 0);

    const banned = normalizeAccountInfo({ user_info: { auth: 1, status: 'Banned' } }, NOW);
    assert.equal(banned.active, false);
    assert.equal(banned.status, 'Banned');

    const unauthorized = normalizeAccountInfo({ user_info: { auth: 0 } }, NOW);
    assert.equal(unauthorized.authorized, false);
    assert.equal(unauthorized.active, false);
    assert.equal(unauthorized.status, null);

    const hostile = normalizeAccountInfo({
        user_info: { auth: 1, status: '<img src=x onerror=alert(1)>Active‮'.repeat(4), max_connections: '-3', active_cons: 'many' }
    }, NOW);
    assert.ok(hostile.status.length <= 32);
    assert.doesNotMatch(hostile.status, /[<>=()‮]/);
    assert.equal(hostile.maxConnections, null, 'Negative counts are dropped.');
    assert.equal(hostile.activeConnections, null, 'Non-numeric counts are dropped.');

    assert.equal(normalizeAccountInfo({}), null);
    assert.equal(normalizeAccountInfo(null), null);
    assert.equal(normalizeAccountInfo({ user_info: 'nope' }), null);
}

function loadSourceManager(globals = {}) {
    const sourceManagerPath = path.join(projectRoot, 'public', 'js', 'components', 'SourceManager.js');
    const context = vm.createContext({ console, window: {}, ...globals });
    vm.runInContext(
        `${fs.readFileSync(sourceManagerPath, 'utf8')}\nglobalThis.SourceManagerForTest = SourceManager;`,
        context,
        { filename: sourceManagerPath }
    );
    return Object.create(context.SourceManagerForTest.prototype);
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function testSupersededLookups() {
    const container = {
        hidden: true,
        texts: [],
        classes: [],
        replaceChildren(...children) {
            this.texts = children.map(child => child.textContent);
            this.classes = children.map(child => child.className);
        }
    };
    const lookups = [];
    const manager = loadSourceManager({
        document: {
            querySelector: () => container,
            createElement: () => ({ className: '', textContent: '' })
        },
        API: { sources: { getAccount: () => { const lookup = deferred(); lookups.push(lookup); return lookup.promise; } } }
    });
    const account = activeConnections => ({
        authorized: true, status: 'Active', active: true, expiresAt: null, expired: false,
        isTrial: false, maxConnections: 2, activeConnections, createdAt: null
    });

    // The source is edited while the first lookup is still pending, and the
    // first lookup finishes last.
    const first = manager.loadAccountStatus(7);
    const second = manager.loadAccountStatus(7);
    lookups[1].resolve({ account: account(2) });
    await second;
    lookups[0].resolve({ account: account(0) });
    await first;
    assert.ok(container.texts.includes('Connections 2 / 2'), 'A superseded lookup never overwrites the latest result.');

    // A superseded failure does not replace the latest result either.
    const failing = manager.loadAccountStatus(7);
    const latest = manager.loadAccountStatus(7);
    lookups[3].resolve({ account: account(1) });
    await latest;
    lookups[2].reject(new Error('old credentials'));
    await assert.rejects(failing);
    assert.ok(container.texts.includes('Connections 1 / 2'));
    assert.ok(!container.texts.includes('Account status unavailable'));

    // Lookups for other sources are tracked separately.
    const other = manager.loadAccountStatus(8);
    lookups[4].resolve({ account: account(0) });
    await other;
    assert.ok(container.texts.includes('Connections 0 / 2'));

    const currentFailure = manager.loadAccountStatus(8);
    lookups[5].reject(new Error('provider unavailable'));
    await assert.rejects(currentFailure);
    assert.deepEqual(container.texts, ['Account status unavailable']);
    assert.deepEqual(container.classes, ['source-account-part error']);
}

function testDescribeAccount() {
    const manager = loadSourceManager();
    // JSON round trip: arrays created inside the vm context have another prototype.
    const describe = account => JSON.parse(JSON.stringify(manager.describeAccount(account, NOW)));
    const base = {
        authorized: true,
        status: 'Active',
        active: true,
        expiresAt: null,
        expired: false,
        isTrial: false,
        maxConnections: 2,
        activeConnections: 1,
        createdAt: null
    };

    let parts = describe({ ...base, expiresAt: new Date(NOW + 127 * DAY_SECONDS * 1000).toISOString() });
    assert.deepEqual(parts[0], { text: 'Active', tone: 'success' });
    assert.match(parts[1].text, /^Expires .+ \(in 127 days\)$/);
    assert.equal(parts[1].tone, '');
    assert.deepEqual(parts[2], { text: 'Connections 1 / 2', tone: '' });

    parts = describe({ ...base, isTrial: true, expiresAt: new Date(NOW + 3 * DAY_SECONDS * 1000).toISOString() });
    assert.equal(parts[0].text, 'Active (trial)');
    assert.match(parts[1].text, /\(in 3 days\)$/);
    assert.equal(parts[1].tone, 'warning', 'An end date within a week is highlighted.');

    parts = describe({ ...base, expiresAt: new Date(NOW + 12 * 60 * 60 * 1000).toISOString() });
    assert.match(parts[1].text, /\(tomorrow\)$/);

    parts = describe({ ...base, activeConnections: 2 });
    assert.deepEqual(parts[1], { text: 'No end date', tone: '' });
    assert.deepEqual(parts[2], { text: 'Connections 2 / 2', tone: 'warning' }, 'All connections in use is highlighted.');

    parts = describe({ ...base, active: false, expired: true, expiresAt: new Date(NOW - DAY_SECONDS * 1000).toISOString() });
    assert.deepEqual(parts[0], { text: 'Expired', tone: 'error' });
    assert.match(parts[1].text, /^Ended /);
    assert.equal(parts[1].tone, 'error');

    parts = describe({ ...base, active: false, status: 'Banned' });
    assert.deepEqual(parts[0], { text: 'Banned', tone: 'error' });

    parts = describe({ ...base, maxConnections: null, activeConnections: 3 });
    assert.deepEqual(parts[2], { text: 'Connections 3 in use', tone: '' });

    parts = describe({ ...base, activeConnections: null });
    assert.deepEqual(parts[2], { text: 'Up to 2 connections', tone: '' }, 'Unknown usage is never shown as zero.');

    parts = describe({ ...base, activeConnections: 0 });
    assert.deepEqual(parts[2], { text: 'Connections 0 / 2', tone: '' });

    parts = describe({ ...base, maxConnections: null, activeConnections: null });
    assert.equal(parts.length, 2, 'Unknown connection counts are left out.');

    assert.deepEqual(describe(null), [{ text: 'Account status unavailable', tone: 'error' }]);
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

function createProviderFixture() {
    const state = { accountRequests: 0, activeConnections: 1 };
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://fixture.invalid');
        response.setHeader('Content-Type', 'application/json');
        if (url.pathname !== '/player_api.php' || url.searchParams.get('password') !== 'provider-password') {
            response.end(JSON.stringify({ user_info: { auth: 0 } }));
            return;
        }
        if (url.searchParams.get('action')) {
            response.end('[]');
            return;
        }
        state.accountRequests += 1;
        response.end(JSON.stringify({
            user_info: {
                username: 'provider-user',
                password: 'provider-password',
                auth: 1,
                status: 'Active',
                exp_date: String(Math.floor(Date.now() / 1000) + 30 * DAY_SECONDS),
                is_trial: '0',
                active_cons: String(state.activeConnections),
                max_connections: '2',
                created_at: String(Math.floor(Date.now() / 1000) - DAY_SECONDS)
            },
            server_info: { url: '127.0.0.1' }
        }));
    });
    return { server, state };
}

async function waitForServer(baseUrl, child, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}.`);
        try {
            const response = await fetch(`${baseUrl}/api/health`);
            if (response.ok) return;
        } catch {
            // Server is still starting.
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('Server did not become ready.');
}

async function stopServer(child) {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

async function testAccountRoute() {
    const testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodecast-xtream-account-'));
    const dataDirectory = path.join(testRoot, 'data');
    await fsp.mkdir(dataDirectory, { recursive: true });
    const { server: provider, state } = createProviderFixture();
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    let child;

    try {
        const providerUrl = `http://127.0.0.1:${provider.address().port}`;
        const port = await getFreePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath, ['server/index.js'], {
            cwd: projectRoot,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                NODECAST_DATA_DIR: dataDirectory,
                PORT: String(port),
                ALLOW_LOCAL_MEDIA_URLS: 'true',
                JWT_SECRET: crypto.randomBytes(48).toString('hex'),
                SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
                TOTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
                OIDC_ISSUER_URL: '',
                OIDC_CLIENT_ID: '',
                OIDC_CLIENT_SECRET: ''
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        let serverOutput = '';
        child.stdout.on('data', chunk => { serverOutput += chunk; });
        child.stderr.on('data', chunk => { serverOutput += chunk; });
        await waitForServer(baseUrl, child);

        const unauthenticated = await fetch(`${baseUrl}/api/sources/1/account`);
        assert.equal(unauthenticated.status, 401);

        const adminPassword = crypto.randomBytes(24).toString('base64url');
        const setup = await fetch(`${baseUrl}/api/auth/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'AccountAdmin', password: adminPassword, passwordConfirmation: adminPassword })
        });
        assert.equal(setup.status, 201);
        const cookie = (setup.headers.get('set-cookie') || '').split(';', 1)[0];
        const request = (method, url, body) => fetch(`${baseUrl}${url}`, {
            method,
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: body ? JSON.stringify(body) : undefined
        });

        const created = await request('POST', '/api/sources', {
            type: 'xtream', name: 'Provider', url: providerUrl, username: 'provider-user', password: 'provider-password'
        });
        assert.equal(created.status, 201, await created.clone().text());
        const source = await created.json();

        const firstResponse = await request('GET', `/api/sources/${source.id}/account`);
        const firstText = await firstResponse.text();
        assert.equal(firstResponse.status, 200, firstText);
        assert.equal(firstResponse.headers.get('cache-control'), 'no-store');
        assert.ok(!firstText.includes('provider-password'), 'The provider password never reaches the browser.');
        const first = JSON.parse(firstText);
        assert.equal(first.sourceId, source.id);
        assert.ok(Number.isFinite(Date.parse(first.checkedAt)));
        assert.equal(first.account.active, true);
        assert.equal(first.account.maxConnections, 2);
        assert.equal(first.account.activeConnections, 1);
        assert.ok(Date.parse(first.account.expiresAt) > Date.now());

        const requestsAfterFirst = state.accountRequests;
        state.activeConnections = 2;
        const cached = await (await request('GET', `/api/sources/${source.id}/account`)).json();
        assert.equal(state.accountRequests, requestsAfterFirst, 'A repeated request within the cache period is served from the cache.');
        assert.equal(cached.account.activeConnections, 1);

        const refreshed = await (await request('GET', `/api/sources/${source.id}/account?refresh=1`)).json();
        assert.equal(state.accountRequests, requestsAfterFirst + 1, 'refresh=1 asks the provider again.');
        assert.equal(refreshed.account.activeConnections, 2);

        // Changed credentials never reuse the cached account of the old ones.
        const updated = await request('PUT', `/api/sources/${source.id}`, { password: 'wrong-password' });
        assert.equal(updated.status, 200);
        const rejected = await request('GET', `/api/sources/${source.id}/account`);
        assert.equal(rejected.status, 200);
        assert.equal((await rejected.json()).account.authorized, false);

        const m3u = await (await request('POST', '/api/sources', {
            type: 'm3u', name: 'Playlist', url: `${providerUrl}/playlist.m3u`
        })).json();
        assert.equal((await request('GET', `/api/sources/${m3u.id}/account`)).status, 400);
        assert.equal((await request('GET', '/api/sources/999999/account')).status, 404);

        assert.doesNotMatch(serverOutput, /provider-password/, 'Logs never contain the provider password.');
    } finally {
        await stopServer(child);
        await new Promise(resolve => provider.close(resolve));
        await fsp.rm(testRoot, { recursive: true, force: true });
    }
}

async function run() {
    testNormalize();
    testDescribeAccount();
    await testSupersededLookups();
    await testAccountRoute();
    console.log('Xtream account status tests passed.');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
