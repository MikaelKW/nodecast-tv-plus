'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const OTPAuth = require('otpauth');
const authAudit = require('../server/services/authAudit');

const projectRoot = path.join(__dirname, '..');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

// ---------------------------------------------------------------------------
// Unit tests: storage, sanitizing, filtering and retention
// ---------------------------------------------------------------------------

function createMemoryAudit({ settings = {}, start = Date.parse('2026-11-01T12:00:00Z') } = {}) {
    const database = new Database(':memory:');
    let time = start;
    const audit = authAudit.createAuthAudit({
        getDb: () => database,
        getSettings: async () => settings,
        now: () => time,
        logger: null
    });
    return {
        audit,
        database,
        advance(ms) { time += ms; },
        set(value) { time = value; }
    };
}

function testDescribeClient() {
    assert.equal(authAudit.describeClient(IPHONE_UA), 'Safari 26 · iOS 26');
    assert.equal(
        authAudit.describeClient('Mozilla/5.0 (iPad; CPU OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1'),
        'Chrome 141 · iPadOS 18'
    );
    assert.equal(
        authAudit.describeClient('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'),
        'Edge 141 · Windows'
    );
    assert.equal(
        authAudit.describeClient('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0'),
        'Firefox 144 · macOS'
    );
    assert.equal(authAudit.describeClient('curl/8.9.1'), 'curl 8');
    assert.equal(authAudit.describeClient(''), null);
}

function testNormalizeIp() {
    assert.equal(authAudit.normalizeIp('::ffff:192.168.2.10'), '192.168.2.10');
    assert.equal(authAudit.normalizeIp('2001:db8::1'), '2001:db8::1');
    assert.equal(authAudit.normalizeIp(''), null);
    assert.equal(authAudit.normalizeIp(undefined), null);
}

function testRetentionSettings() {
    assert.deepEqual(authAudit.normalizeRetentionSettings({}), {
        authLogRetentionDays: 90, authLogMaxEntries: 50000
    });
    assert.deepEqual(authAudit.normalizeRetentionSettings({ authLogRetentionDays: 0, authLogMaxEntries: 5 }), {
        authLogRetentionDays: 1, authLogMaxEntries: 1000
    });
    assert.deepEqual(authAudit.normalizeRetentionSettings({ authLogRetentionDays: '9999', authLogMaxEntries: 1e9 }), {
        authLogRetentionDays: 3650, authLogMaxEntries: 1000000
    });
    assert.equal(authAudit.normalizeRetentionSettings({ authLogRetentionDays: 'abc' }).authLogRetentionDays, 90);
}

function testRecordValidationAndSanitizing() {
    const { audit, database } = createMemoryAudit();

    assert.equal(audit.record({ event: 'hacked', outcome: 'success' }), false);
    assert.equal(audit.record({ event: 'sign_in', outcome: 'maybe' }), false);
    assert.equal(audit.record({ event: 'sign_in', outcome: 'failure', method: 'magic' }), false);
    assert.equal(audit.record({ event: 'sign_in', outcome: 'failure', reason: 'free text' }), false);

    assert.equal(audit.record({
        event: 'sign_in',
        outcome: 'failure',
        method: 'password',
        reason: 'unknown_account',
        username: '  evil‮<script>alert(1)</script>\n\tname  ',
        password: 'must-not-be-stored',
        credential: '123456',
        context: {
            ip: '::ffff:203.0.113.5',
            peerIp: '::ffff:127.0.0.1',
            forwardedFor: ['203.0.113.5', '127.0.0.1'],
            host: 'tv.example.test',
            userAgent: IPHONE_UA,
            cookie: 'session=secret'
        }
    }), true);

    const columns = database.prepare('PRAGMA table_info(auth_events)').all().map(column => column.name);
    for (const forbidden of ['password', 'credential', 'cookie', 'token', 'code']) {
        assert.equal(columns.includes(forbidden), false, `The audit table must not have a ${forbidden} column.`);
    }
    const raw = JSON.stringify(database.prepare('SELECT * FROM auth_events').all());
    assert.equal(raw.includes('must-not-be-stored'), false);
    assert.equal(raw.includes('123456'), false);
    assert.equal(raw.includes('session=secret'), false);

    const [entry] = audit.query().entries;
    assert.equal(entry.username, 'evil <script>alert(1)</script> name', 'Control and bidi characters are removed.');
    assert.equal(entry.ip, '203.0.113.5');
    assert.equal(entry.peerIp, '127.0.0.1');
    assert.deepEqual(entry.forwardedFor, ['203.0.113.5', '127.0.0.1']);
    assert.equal(entry.host, 'tv.example.test');
    assert.equal(entry.client, 'Safari 26 · iOS 26');
    assert.equal(entry.reasonText, authAudit.REASONS.unknown_account);
    assert.equal(entry.at, '2026-11-01T12:00:00.000Z');

    // Long values are bounded.
    audit.record({ event: 'sign_in', outcome: 'failure', username: 'x'.repeat(1000), context: { userAgent: 'y'.repeat(5000) } });
    const long = audit.query({ pageSize: 1 }).entries[0];
    assert.equal(long.username.length, 128);
    assert.equal(long.userAgent.length, 512);

    // A storage failure never throws into the authentication path.
    const broken = authAudit.createAuthAudit({ getDb: () => { throw new Error('disk full'); }, logger: null });
    assert.equal(broken.record({ event: 'sign_in', outcome: 'success' }), false);
}

function testQueryFilters() {
    const { audit, advance } = createMemoryAudit();
    const add = (entry, context = {}) => {
        audit.record({ event: 'sign_in', method: 'password', ...entry, context });
        advance(60 * 1000);
    };
    add({ outcome: 'failure', reason: 'invalid_password', user: { id: 1, username: 'admin' } }, { ip: '192.168.2.10' });
    add({ outcome: 'success', user: { id: 1, username: 'admin' } }, { ip: '192.168.2.10' });
    add({ outcome: 'failure', reason: 'unknown_account', username: 'root' }, { ip: '203.0.113.9' });
    add({ outcome: 'failure', reason: 'unknown_account', username: '50%_off' }, { ip: '198.51.100.4' });
    add({ outcome: 'mfa_required', user: { id: 2, username: 'Steven' } }, { ip: '192.168.1.81' });
    audit.record({ event: 'sign_out', outcome: 'success', user: { id: 2, username: 'Steven' } });

    assert.equal(audit.query().total, 6);
    assert.equal(audit.query().entries[0].event, 'sign_out', 'Newest entries come first.');
    assert.equal(audit.query({ outcome: 'failure' }).total, 3);
    assert.equal(audit.query({ event: 'sign_out' }).total, 1);
    assert.equal(audit.query({ account: 'ADM' }).total, 2, 'Account filter is a case-insensitive substring.');
    assert.equal(audit.query({ account: 'steven' }).total, 2);
    assert.equal(audit.query({ account: '%' }).total, 1, 'LIKE wildcards in the filter are literal.');
    assert.equal(audit.query({ account: '_' }).total, 1);
    assert.equal(audit.query({ ip: '192.168.2.' }).total, 2, 'IP filter matches a prefix.');
    assert.equal(audit.query({ ip: '192.168.' }).total, 3);
    assert.equal(audit.query({ outcome: 'bogus' }).total, 6, 'Unknown filter values are ignored.');
    assert.equal(audit.query({ from: '2026-11-01T12:02:00Z' }).total, 4);
    assert.equal(audit.query({ to: '2026-11-01T12:01:00Z' }).total, 2);
    assert.equal(audit.query({ method: 'password', outcome: 'failure', ip: '203.' }).total, 1);

    const page = audit.query({ pageSize: 4, page: 2 });
    assert.equal(page.entries.length, 2);
    assert.equal(page.pages, 2);
    assert.equal(audit.query({ pageSize: 5000 }).pageSize, authAudit.MAX_PAGE_SIZE);
    assert.equal(audit.query({ page: -3 }).page, 1);
    // A page beyond the end (for example after pruning) returns the last page.
    const beyond = audit.query({ pageSize: 4, page: 9 });
    assert.equal(beyond.page, 2);
    assert.equal(beyond.entries.length, 2);
    assert.equal(audit.query({ account: 'nobody', page: 3 }).page, 1);
}

async function testRetention() {
    const settings = { authLogRetentionDays: 7, authLogMaxEntries: 1000 };
    const { audit, advance } = createMemoryAudit({ settings });
    const day = 24 * 60 * 60 * 1000;
    audit.record({ event: 'sign_in', outcome: 'success', username: 'old' });
    advance(8 * day);
    audit.record({ event: 'sign_in', outcome: 'success', username: 'recent' });
    const result = await audit.prune();
    assert.equal(result.expired, 1);
    assert.deepEqual(audit.query().entries.map(entry => entry.username), ['recent']);

    // Beyond the maximum, the oldest entries are removed.
    for (let index = 0; index < 1005; index += 1) {
        audit.record({ event: 'sign_in', outcome: 'failure', username: `user${index}` });
    }
    await audit.prune();
    const remaining = audit.query({ pageSize: 1 });
    assert.equal(remaining.total, 1000);
    assert.equal(remaining.entries[0].username, 'user1004');

    // When the saved policy cannot be read, pruning is skipped rather than
    // falling back to the default retention.
    const database = new Database(':memory:');
    let time = Date.parse('2026-11-01T12:00:00Z');
    const unreadable = authAudit.createAuthAudit({
        getDb: () => database,
        getSettings: async () => { throw new Error('db.json is not valid JSON'); },
        now: () => time,
        logger: null
    });
    unreadable.record({ event: 'sign_in', outcome: 'success', username: 'kept' });
    time += 400 * day;
    assert.deepEqual(await unreadable.prune(), { expired: 0, overflow: 0 });
    assert.equal(unreadable.query().total, 1, 'Entries must survive when the policy cannot be read.');
}

/** settings.getStrict() rejects a damaged db.json instead of returning defaults. */
async function testStrictSettingsReader() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-strict-settings-'));
    const script = `
        const { settings } = require(${JSON.stringify(path.join(projectRoot, 'server', 'db'))});
        (async () => {
            const lenient = await settings.get();
            let strictError = null;
            try { await settings.getStrict(); } catch (error) { strictError = error.message; }
            console.log(JSON.stringify({ lenientDays: lenient.authLogRetentionDays, strictError }));
        })();
    `;
    const run = () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], {
            env: { ...process.env, NODECAST_DATA_DIR: directory },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.on('error', reject);
        child.on('close', () => {
            const line = output.trim().split('\n').pop();
            try { resolve(JSON.parse(line)); } catch { reject(new Error(`Unexpected output: ${output}`)); }
        });
    });
    try {
        await fs.writeFile(path.join(directory, 'db.json'), '{"settings": {"authLogRetentionDays": 365');
        const damaged = await run();
        assert.equal(damaged.lenientDays, 90, 'The lenient reader falls back to defaults.');
        assert.ok(damaged.strictError, 'The strict reader must reject a damaged db.json.');

        await fs.writeFile(path.join(directory, 'db.json'), JSON.stringify({ settings: { authLogRetentionDays: 365 } }));
        const valid = await run();
        assert.equal(valid.strictError, null);
        assert.equal(valid.lenientDays, 365);
    } finally {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
}

function testContextFromRequest() {
    const context = authAudit.contextFromRequest({
        ip: '::ffff:203.0.113.1',
        ips: ['203.0.113.1'],
        socket: { remoteAddress: '::ffff:192.168.2.222' },
        get: name => ({ host: 'tv.example.test', 'user-agent': IPHONE_UA })[name]
    });
    assert.equal(context.ip, '::ffff:203.0.113.1');
    assert.equal(context.peerIp, '::ffff:192.168.2.222');
    assert.deepEqual(context.forwardedFor, ['203.0.113.1']);
    assert.equal(context.host, 'tv.example.test');
    assert.equal(context.userAgent, IPHONE_UA);

    // A trusted proxy's public host is kept even when the upstream Host
    // header starts with the same text.
    const proxied = authAudit.contextFromRequest({
        hostname: 'tv.example.test',
        get: name => ({ host: 'tv.example.test.internal:3000' })[name]
    });
    assert.equal(proxied.host, 'tv.example.test');
    const direct = authAudit.contextFromRequest({
        hostname: 'tv.example.test',
        get: name => ({ host: 'TV.example.test:3001' })[name]
    });
    assert.equal(direct.host, 'TV.example.test:3001', 'A direct request keeps the Host header and port.');
    // Express reports a bracketed IPv6 host name; a direct request keeps the
    // complete Host header, port included.
    const ipv6 = authAudit.contextFromRequest({
        hostname: '[2001:db8::1]',
        get: name => ({ host: '[2001:db8::1]:3000' })[name]
    });
    assert.equal(ipv6.host, '[2001:db8::1]:3000');
    assert.equal(authAudit.hostWithoutPort('[2001:db8::1]'), '2001:db8::1');
    assert.equal(authAudit.hostWithoutPort('[::1]:3000'), '::1');
    assert.equal(authAudit.hostWithoutPort('2001:db8::1'), '2001:db8::1');
    assert.equal(authAudit.hostWithoutPort('Example.test:443'), 'example.test');

    const throwing = authAudit.contextFromRequest({
        get ips() { throw new Error('boom'); },
        get() { throw new Error('boom'); }
    });
    assert.deepEqual(throwing.forwardedFor, []);
    assert.equal(throwing.host, null);
    assert.deepEqual(authAudit.contextFromRequest(null), {});
}

/**
 * An expired two-factor challenge is still attributed to its account and
 * sign-in flow. The real server cannot expire a five-minute challenge within
 * a test, so the route runs here with stubbed storage and audit modules.
 */
async function testExpiredChallengeAudit() {
    const express = require('express');
    const stubbed = [];
    const stub = (request, exports) => {
        const resolved = require.resolve(request);
        stubbed.push([resolved, require.cache[resolved]]);
        require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    };
    const fresh = request => {
        const resolved = require.resolve(request);
        stubbed.push([resolved, require.cache[resolved]]);
        delete require.cache[resolved];
    };

    const recorded = [];
    const flowId = '6f1c2c1e-6c1d-4c6e-9d6a-2b1f3c4d5e6f';
    stub('../server/db', { users: { getById: async id => (id === 7 ? { id: 7, username: 'steven' } : null) } });
    stub('../server/auth', { requireAuth: (req, res, next) => next(), requireAdmin: (req, res, next) => next() });
    stub('../server/services/totpService', { isAvailable: () => true });
    stub('../server/services/authAudit', {
        contextFromRequest: () => ({ ip: '203.0.113.20' }),
        record: entry => recorded.push(entry)
    });
    fresh('../server/services/twoFactorAuth');
    fresh('../server/routes/totp');

    let server;
    try {
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            req.session = {
                twoFactorChallenge: {
                    challengeId: 'expired', userId: 7, expiresAt: Date.now() - 1000,
                    firstFactor: 'sso', flowId
                },
                regenerate(callback) { callback(); },
                save(callback) { callback(); }
            };
            next();
        });
        app.use('/2fa', require('../server/routes/totp'));
        server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        const response = await fetch(`http://127.0.0.1:${server.address().port}/2fa/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credentialType: 'totp', credential: '123456' })
        });
        assert.equal(response.status, 401);
        assert.equal(recorded.length, 1);
        assert.equal(recorded[0].reason, 'mfa_challenge_expired');
        assert.equal(recorded[0].user.username, 'steven');
        assert.equal(recorded[0].flowId, flowId);
        assert.equal(recorded[0].method, 'sso+totp');
        assert.equal(JSON.stringify(recorded).includes('123456'), false);
    } finally {
        await new Promise(resolve => (server ? server.close(resolve) : resolve()));
        for (const [resolved, original] of stubbed.reverse()) {
            if (original) require.cache[resolved] = original;
            else delete require.cache[resolved];
        }
    }
}

// ---------------------------------------------------------------------------
// Integration test: real server, real routes
// ---------------------------------------------------------------------------

class CookieJar {
    constructor() { this.cookies = new Map(); }
    absorb(response) {
        for (const header of response.headers.getSetCookie()) {
            const pair = header.split(';', 1)[0];
            const separator = pair.indexOf('=');
            const name = pair.slice(0, separator);
            const value = pair.slice(separator + 1);
            if (value) this.cookies.set(name, value);
            else this.cookies.delete(name);
        }
    }
    header() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
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

async function waitForServer(baseUrl, child, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}.`);
        try {
            if ((await fetch(`${baseUrl}/api/version`)).ok) return;
        } catch {
            // The server may still be starting.
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('Server did not become ready.');
}

async function startServer(dataDirectory, secrets, extraEnv = {}) {
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
            PORT: String(port),
            JWT_SECRET: secrets.jwt,
            SESSION_SECRET: secrets.session,
            TOTP_ENCRYPTION_KEY: secrets.totp,
            OIDC_ISSUER_URL: '',
            OIDC_CLIENT_ID: '',
            OIDC_CLIENT_SECRET: '',
            DISABLE_LOCAL_AUTH: '',
            TRUST_PROXY: '',
            ...extraEnv
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    try {
        await waitForServer(baseUrl, child);
    } catch (error) {
        console.error(output);
        throw error;
    }
    return { baseUrl, child };
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

async function request(baseUrl, route, { method = 'GET', body, jar = new CookieJar(), headers = {} } = {}) {
    const allHeaders = { ...headers };
    if (body !== undefined) allHeaders['Content-Type'] = 'application/json';
    if (jar.header()) allHeaders.Cookie = jar.header();
    const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: allHeaders,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    jar.absorb(response);
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    return { response, payload, jar };
}

function totp(secret) {
    return new OTPAuth.TOTP({
        algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret)
    }).generate();
}

async function readLog(baseUrl, jar, query = '') {
    const result = await request(baseUrl, `/api/auth-log${query}`, { jar });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    return result.payload;
}

async function testServerFlow() {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-auth-audit-'));
    const secrets = {
        jwt: crypto.randomBytes(48).toString('hex'),
        session: crypto.randomBytes(48).toString('hex'),
        totp: crypto.randomBytes(48).toString('hex')
    };
    const adminPassword = `Admin-${crypto.randomBytes(8).toString('hex')}`;
    const wrongPassword = `Wrong-${crypto.randomBytes(8).toString('hex')}`;
    const viewerPassword = `Viewer-${crypto.randomBytes(8).toString('hex')}`;
    let server;

    try {
        server = await startServer(dataDirectory, secrets);
        const { baseUrl } = server;

        // Initial setup.
        const admin = new CookieJar();
        const setup = await request(baseUrl, '/api/auth/setup', {
            method: 'POST', jar: admin,
            body: { username: 'admin', password: adminPassword, passwordConfirmation: adminPassword }
        });
        assert.equal(setup.response.status, 201);

        // Unknown account through a trusted (loopback) proxy with a forwarded client.
        const unknown = await request(baseUrl, '/api/auth/login', {
            method: 'POST',
            body: { username: 'ghost', password: wrongPassword },
            headers: { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Host': 'tv.example.test', 'User-Agent': IPHONE_UA }
        });
        assert.equal(unknown.response.status, 401);
        assert.equal(unknown.payload.error, 'Invalid credentials', 'Clients cannot tell unknown accounts apart.');

        // Wrong password for an existing account.
        const wrong = await request(baseUrl, '/api/auth/login', {
            method: 'POST', body: { username: 'admin', password: wrongPassword }
        });
        assert.equal(wrong.response.status, 401);
        assert.equal(wrong.payload.error, 'Invalid credentials');

        // Missing credentials.
        await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'admin' } });

        // A successful password sign-in.
        const login = await request(baseUrl, '/api/auth/login', {
            method: 'POST', jar: admin, body: { username: 'admin', password: adminPassword }
        });
        assert.equal(login.response.status, 200);

        // Rate limiting is unchanged and its rejections are recorded.
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await request(baseUrl, '/api/auth/login', {
                method: 'POST', body: { username: 'target', password: wrongPassword }
            });
        }
        const limited = await request(baseUrl, '/api/auth/login', {
            method: 'POST', body: { username: 'target', password: wrongPassword }
        });
        assert.equal(limited.response.status, 429);

        let log = await readLog(baseUrl, admin, '?pageSize=100');
        const find = predicate => log.entries.find(predicate);

        const setupEntry = find(entry => entry.event === 'setup');
        assert.equal(setupEntry.outcome, 'success');
        assert.equal(setupEntry.username, 'admin');

        const unknownEntry = find(entry => entry.reason === 'unknown_account' && entry.username === 'ghost');
        assert.equal(unknownEntry.username, 'ghost');
        assert.equal(unknownEntry.userId, null);
        assert.equal(unknownEntry.ip, '203.0.113.7', 'A trusted proxy supplies the client IP.');
        assert.equal(unknownEntry.peerIp, '127.0.0.1');
        assert.ok(unknownEntry.forwardedFor.includes('203.0.113.7'));
        assert.equal(unknownEntry.host, 'tv.example.test');
        assert.equal(unknownEntry.client, 'Safari 26 · iOS 26');
        assert.equal(unknownEntry.method, 'password');

        const wrongEntry = find(entry => entry.reason === 'invalid_password');
        assert.equal(wrongEntry.username, 'admin');
        assert.ok(Number.isInteger(wrongEntry.userId));
        assert.equal(wrongEntry.ip, '127.0.0.1');
        assert.match(wrongEntry.host, /^127\.0\.0\.1:\d+$/, 'A direct request keeps the Host header with its port.');

        assert.ok(find(entry => entry.reason === 'missing_credentials'));
        assert.ok(find(entry => entry.outcome === 'success' && entry.event === 'sign_in' && entry.method === 'password'));
        assert.equal(log.entries.filter(entry => entry.username === 'target' && entry.reason === 'invalid_password').length, 0,
            'An unknown account is never reported as a wrong password.');
        assert.equal(log.entries.filter(entry => entry.username === 'target' && entry.reason === 'unknown_account').length, 5);
        assert.ok(find(entry => entry.username === 'target' && entry.reason === 'rate_limited'));

        // Two-factor sign-in links both steps with one flow ID.
        const enroll = await request(baseUrl, '/api/auth/2fa/enroll', {
            method: 'POST', jar: admin, body: { password: adminPassword }
        });
        assert.equal(enroll.response.status, 200);
        const secret = enroll.payload.manualSecret;
        const confirmed = await request(baseUrl, '/api/auth/2fa/confirm', {
            method: 'POST', jar: admin, body: { code: totp(secret) }
        });
        assert.equal(confirmed.response.status, 200);
        const recoveryCode = confirmed.payload.recoveryCodes[0];

        // Wait for the next TOTP step so the code is not a replay of the enrollment code.
        await new Promise(resolve => setTimeout(resolve, 30500 - (Date.now() % 30000)));

        const mfa = new CookieJar();
        const first = await request(baseUrl, '/api/auth/login', {
            method: 'POST', jar: mfa, body: { username: 'admin', password: adminPassword }
        });
        assert.equal(first.payload.requiresTwoFactor, true);
        const badCode = await request(baseUrl, '/api/auth/2fa/verify', {
            method: 'POST', jar: mfa, body: { credentialType: 'totp', credential: '000000' }
        });
        assert.equal(badCode.response.status, 401);
        const goodCode = totp(secret);
        const verified = await request(baseUrl, '/api/auth/2fa/verify', {
            method: 'POST', jar: mfa, body: { credentialType: 'totp', credential: goodCode }
        });
        assert.equal(verified.response.status, 200);

        // Recovery code sign-in.
        const recovery = new CookieJar();
        await request(baseUrl, '/api/auth/login', {
            method: 'POST', jar: recovery, body: { username: 'admin', password: adminPassword }
        });
        const recovered = await request(baseUrl, '/api/auth/2fa/verify', {
            method: 'POST', jar: recovery, body: { credentialType: 'recovery', credential: recoveryCode }
        });
        assert.equal(recovered.response.status, 200);

        // Verify without a challenge.
        await request(baseUrl, '/api/auth/2fa/verify', {
            method: 'POST', body: { credentialType: 'totp', credential: '123456' }
        });

        // Sign-out without a session, or with a forged token, records nothing.
        await request(baseUrl, '/api/auth/logout', { method: 'POST' });
        await request(baseUrl, '/api/auth/logout', {
            method: 'POST', headers: { Authorization: 'Bearer forged.token.value' }
        });

        // Sign-out of the recovery session.
        const logout = await request(baseUrl, '/api/auth/logout', { method: 'POST', jar: recovery });
        assert.equal(logout.response.status, 200);

        log = await readLog(baseUrl, mfa, '?pageSize=100');
        const required = log.entries.filter(entry => entry.outcome === 'mfa_required');
        assert.equal(required.length, 2);
        const firstFlow = required.at(-1).flowId;
        assert.match(firstFlow, /^[0-9a-f-]{36}$/);
        const flowEntries = log.entries.filter(entry => entry.flowId === firstFlow);
        assert.deepEqual(flowEntries.map(entry => [entry.outcome, entry.method, entry.reason]).reverse(), [
            ['mfa_required', 'password', null],
            ['failure', 'password+totp', 'invalid_mfa_code'],
            ['success', 'password+totp', null]
        ]);
        assert.ok(log.entries.find(entry => entry.method === 'password+recovery_code' && entry.outcome === 'success'));
        assert.ok(log.entries.find(entry => entry.reason === 'mfa_challenge_expired'));
        const signOuts = log.entries.filter(entry => entry.event === 'sign_out');
        assert.equal(signOuts.length, 1, 'Only the authenticated sign-out is recorded.');
        assert.equal(signOuts[0].username, 'admin');

        // API filters and pagination.
        const failures = await readLog(baseUrl, mfa, '?outcome=failure&account=ghost');
        assert.equal(failures.total, 1);
        assert.equal((await readLog(baseUrl, mfa, '?ip=203.0.113.')).total, 1);
        const paged = await readLog(baseUrl, mfa, '?pageSize=2&page=2');
        assert.equal(paged.entries.length, 2);
        assert.equal(paged.page, 2);

        // Secrets never appear in the API or in the database file.
        const everything = JSON.stringify(await readLog(baseUrl, mfa, '?pageSize=100'));
        for (const secretValue of [adminPassword, wrongPassword, goodCode, recoveryCode, secret]) {
            assert.equal(everything.includes(secretValue), false, 'The log API must not expose secrets.');
        }
        // Checkpoint the WAL so every recorded row is in the main file.
        const contentDb = new Database(path.join(dataDirectory, 'content.db'));
        contentDb.pragma('wal_checkpoint(FULL)');
        contentDb.close();
        const files = await fs.readdir(dataDirectory);
        for (const file of files.filter(name => name.startsWith('content.db'))) {
            const bytes = await fs.readFile(path.join(dataDirectory, file));
            for (const secretValue of [adminPassword, wrongPassword, recoveryCode]) {
                assert.equal(bytes.includes(Buffer.from(secretValue)), false, `${file} must not contain secrets.`);
            }
        }

        // Retention settings are clamped.
        const saved = await request(baseUrl, '/api/settings', {
            method: 'PUT', jar: mfa, body: { authLogRetentionDays: 0, authLogMaxEntries: 5 }
        });
        assert.equal(saved.payload.authLogRetentionDays, 1);
        assert.equal(saved.payload.authLogMaxEntries, 1000);

        // Only administrators can read the log.
        const created = await request(baseUrl, '/api/auth/users', {
            method: 'POST', jar: mfa,
            body: { username: 'viewer', password: viewerPassword, passwordConfirmation: viewerPassword, role: 'viewer' }
        });
        assert.equal(created.response.status, 201);
        const viewer = new CookieJar();
        await request(baseUrl, '/api/auth/login', {
            method: 'POST', jar: viewer, body: { username: 'viewer', password: viewerPassword }
        });
        assert.equal((await request(baseUrl, '/api/auth-log', { jar: viewer })).response.status, 403);
        assert.equal((await request(baseUrl, '/api/auth-log')).response.status, 401);

        // Entries survive a restart.
        await stopServer(server.child);
        server = await startServer(dataDirectory, secrets);
        const afterRestart = new CookieJar();
        await request(server.baseUrl, '/api/auth/login', {
            method: 'POST', jar: afterRestart, body: { username: 'viewer', password: viewerPassword }
        });
        const adminAgain = new CookieJar();
        await request(server.baseUrl, '/api/auth/login', {
            method: 'POST', jar: adminAgain, body: { username: 'admin', password: adminPassword }
        });
        await request(server.baseUrl, '/api/auth/2fa/verify', {
            method: 'POST', jar: adminAgain, body: { credentialType: 'recovery', credential: confirmed.payload.recoveryCodes[1] }
        });
        const persisted = await readLog(server.baseUrl, adminAgain, '?account=ghost');
        assert.equal(persisted.total, 1, 'Entries persist across restarts.');
        await stopServer(server.child);

        // With TRUST_PROXY=false, forwarded headers are ignored.
        server = await startServer(dataDirectory, secrets, { TRUST_PROXY: 'false' });
        await request(server.baseUrl, '/api/auth/login', {
            method: 'POST', body: { username: 'spoofed', password: wrongPassword },
            headers: { 'X-Forwarded-For': '198.51.100.99', 'X-Forwarded-Host': 'evil.example.test' }
        });
        const untrusted = new CookieJar();
        await request(server.baseUrl, '/api/auth/login', {
            method: 'POST', jar: untrusted, body: { username: 'admin', password: adminPassword }
        });
        await request(server.baseUrl, '/api/auth/2fa/verify', {
            method: 'POST', jar: untrusted, body: { credentialType: 'recovery', credential: confirmed.payload.recoveryCodes[2] }
        });
        const spoofed = (await readLog(server.baseUrl, untrusted, '?account=spoofed')).entries[0];
        assert.equal(spoofed.ip, '127.0.0.1', 'Untrusted forwarded headers must not set the client IP.');
        assert.match(spoofed.host, /^127\.0\.0\.1:\d+$/, 'Untrusted forwarded hosts are ignored.');
        assert.deepEqual(spoofed.forwardedFor, []);
    } finally {
        await stopServer(server?.child);
        await fs.rm(dataDirectory, { recursive: true, force: true }).catch(() => {});
    }
}

async function run() {
    testDescribeClient();
    testNormalizeIp();
    testRetentionSettings();
    testRecordValidationAndSanitizing();
    testQueryFilters();
    await testRetention();
    await testStrictSettingsReader();
    testContextFromRequest();
    await testExpiredChallengeAudit();
    await testServerFlow();
    console.log('Authentication audit log tests passed.');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
