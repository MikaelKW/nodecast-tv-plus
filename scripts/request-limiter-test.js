const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ipKeyGenerator } = require('express-rate-limit');
const { isApplicationReady } = require('./helpers/applicationReadiness');

const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const OIDC_LIMIT_BODY = { error: 'Too many single sign-on requests. Try again shortly.' };
const STARTUP_LIMIT_BODY = { error: 'Too many startup checks. Try again shortly.' };

async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function ipv6LoopbackAvailable() {
    const server = net.createServer();
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '::1', resolve);
        });
        return true;
    } catch {
        return false;
    } finally {
        await new Promise(resolve => server.close(() => resolve()));
    }
}

async function startServer(directory, trustProxy) {
    await fs.mkdir(directory, { recursive: true });
    const port = await freePort();
    const server = { output: '', port, base: `http://127.0.0.1:${port}`, base6: `http://[::1]:${port}` };
    server.child = spawn(process.execPath, ['server/index.js'], {
        cwd: root,
        env: {
            ...process.env, NODE_ENV: 'test', PORT: String(port), TRUST_PROXY: trustProxy,
            NODECAST_DATA_DIR: path.join(directory, 'data'), NODECAST_CACHE_DIR: path.join(directory, 'cache'),
            NODECAST_DISABLE_BACKGROUND_JOBS: 'true',
            JWT_SECRET: crypto.randomBytes(48).toString('hex'),
            SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
            OIDC_ISSUER_URL: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '',
            OIDC_AUTH_URL: '', OIDC_TOKEN_URL: '', OIDC_USERINFO_URL: '',
            DISABLE_LOCAL_AUTH: '', OIDC_AUTO_REDIRECT: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.child.stdout.on('data', chunk => { server.output += chunk; });
    server.child.stderr.on('data', chunk => { server.output += chunk; });
    for (let i = 0; i < 150; i++) {
        if (server.child.exitCode !== null) throw new Error(`Test server exited: ${server.output}`);
        try { if (await isApplicationReady(server.base)) return server; } catch {}
        await sleep(100);
    }
    server.child.kill('SIGKILL');
    throw new Error(`Request-limiter test server did not start: ${server.output}`);
}

async function stopServer(server) {
    if (!server || server.child.exitCode !== null) return;
    server.child.kill('SIGTERM');
    for (let i = 0; i < 50 && server.child.exitCode === null; i++) await sleep(100);
    if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

async function request(base, route, headers = {}) {
    const response = await fetch(`${base}${route}`, { headers, redirect: 'manual' });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { response, body };
}

function forwarded(address) {
    return address ? { 'X-Forwarded-For': address } : {};
}

function assertAllowed(result, limit, message) {
    // Single sign-on is not configured here, so an allowed request reaches the
    // route and reports it unavailable. Only the limiter answers with 429.
    assert.notEqual(result.response.status, 429, message);
    assert.match(result.response.headers.get('ratelimit-policy') || '', new RegExp(`^${limit};w=\\d+$`), message);
    assert.equal(result.response.headers.get('x-ratelimit-limit'), null, 'Legacy headers stay disabled');
}

function assertLimited(result, { limit, windowSeconds, body, noStore = false }, message) {
    assert.equal(result.response.status, 429, message);
    assert.deepEqual(result.body, body, message);
    assert.equal(result.response.headers.get('ratelimit-policy'), `${limit};w=${windowSeconds}`, message);
    assert.match(result.response.headers.get('ratelimit') || '', new RegExp(`^limit=${limit}, remaining=0, reset=\\d+$`), message);
    const retry = Number(result.response.headers.get('retry-after'));
    assert(retry > 0 && retry <= windowSeconds, `${message}: Retry-After stays inside the window`);
    assert.equal(result.response.headers.get('x-ratelimit-limit'), null, 'Legacy headers stay disabled');
    if (noStore) assert.equal(result.response.headers.get('cache-control'), 'no-store', message);
}

const OIDC = { limit: 60, windowSeconds: 900, body: OIDC_LIMIT_BODY };
const STARTUP = { limit: 600, windowSeconds: 60, body: STARTUP_LIMIT_BODY, noStore: true };

async function exhaustOidc(base, address, used = 0) {
    for (let i = used; i < OIDC.limit; i++) {
        assertAllowed(await request(base, '/api/auth/oidc/login', forwarded(address)), OIDC.limit,
            `Single sign-on request ${i + 1} from ${address || 'the socket address'} stays below the limit`);
    }
}

function validationCodes(output) {
    return [...new Set(output.match(/ERR_ERL_[A-Z0-9_]+/g) || [])].sort();
}

function testKeyHelper() {
    // These keys are what the default key generator stores for a request IP.
    assert.equal(ipKeyGenerator('198.51.100.7'), '198.51.100.7');
    assert.equal(ipKeyGenerator('::ffff:198.51.100.7'), '198.51.100.7', 'IPv4-mapped IPv6 shares the IPv4 key');
    assert.equal(ipKeyGenerator('::ffff:127.0.0.1'), '127.0.0.1', 'Dual-stack IPv4 loopback shares the IPv4 key');
    assert.equal(ipKeyGenerator('2001:db8:abcd:1234::1'), '2001:db8:abcd:1200::/56', 'IPv6 clients group per /56');
    assert.equal(ipKeyGenerator('2001:db8:abcd:12ff:ffff::9'), '2001:db8:abcd:1200::/56');
    assert.notEqual(ipKeyGenerator('2001:db8:abcd:1300::1'), ipKeyGenerator('2001:db8:abcd:1200::1'));
    assert.equal(ipKeyGenerator('::1'), '::/56', 'IPv6 loopback is not mistaken for an IPv4 address');
}

(async () => {
    testKeyHelper();
    const ipv6 = await ipv6LoopbackAvailable();
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-request-limiter-'));
    let server;
    try {
        // The default proxy trust honours forwarded addresses from loopback and
        // private networks, so the test client can act as a reverse proxy.
        server = await startServer(path.join(temporary, 'default'), '');
        await exhaustOidc(server.base, '198.51.100.20');
        assertLimited(await request(server.base, '/api/auth/oidc/login', forwarded('198.51.100.20')), OIDC,
            'The single sign-on limit triggers after 60 requests');
        assertLimited(await request(server.base, '/api/auth/oidc/callback?code=x&state=y', forwarded('198.51.100.20')), OIDC,
            'Sign-in start and callback share one allowance');
        assertLimited(await request(server.base, '/api/auth/oidc/login', forwarded('::ffff:198.51.100.20')), OIDC,
            'An IPv4-mapped IPv6 address uses the IPv4 client key');
        assertAllowed(await request(server.base, '/api/auth/oidc/login', forwarded('198.51.100.21')), OIDC.limit,
            'A different IPv4 client keeps its own allowance');
        assertAllowed(await request(server.base, '/api/auth/oidc/login'), OIDC.limit,
            'The proxy itself is not charged for its forwarded clients');

        for (let i = 0; i < OIDC.limit; i++) {
            assertAllowed(await request(server.base, '/api/auth/oidc/login', forwarded(`2001:db8:abcd:1200::${i + 1}`)),
                OIDC.limit, 'IPv6 clients stay below the limit');
        }
        assertLimited(await request(server.base, '/api/auth/oidc/login', forwarded('2001:db8:abcd:12ff::1')), OIDC,
            'IPv6 addresses in the same /56 share one allowance');
        assertAllowed(await request(server.base, '/api/auth/oidc/login', forwarded('2001:db8:abcd:1300::1')), OIDC.limit,
            'A different IPv6 /56 keeps its own allowance');

        for (let i = 0; i < STARTUP.limit; i++) {
            const result = await request(server.base, '/api/startup', forwarded('203.0.113.5'));
            assert.equal(result.response.status, 200, 'Startup checks stay available below the limit');
        }
        assertLimited(await request(server.base, '/api/startup', forwarded('203.0.113.5')), STARTUP,
            'The startup-check limit triggers after 600 requests');
        assert.equal((await request(server.base, '/api/startup', forwarded('203.0.113.6'))).response.status, 200);

        if (ipv6) {
            // Direct connections: the dual-stack IPv4 loopback arrives as
            // ::ffff:127.0.0.1 and must not share a key with IPv6 loopback.
            // One direct request was already counted above.
            await exhaustOidc(server.base, null, 1);
            assertLimited(await request(server.base, '/api/auth/oidc/login'), OIDC, 'A direct IPv4 client is limited');
            assertAllowed(await request(server.base6, '/api/auth/oidc/login'), OIDC.limit,
                'A direct IPv6 client keeps its own allowance');
        }
        assert.deepEqual(validationCodes(server.output), [], `No limiter validation warnings with trusted proxies:\n${server.output}`);
        await stopServer(server);

        // Without proxy trust, forwarded addresses must not split or reset the
        // allowance of the connecting client.
        server = await startServer(path.join(temporary, 'untrusted'), 'false');
        assertAllowed(await request(server.base, '/api/auth/oidc/login'), OIDC.limit, 'The first direct request is allowed');
        assert.deepEqual(validationCodes(server.output), [], 'No limiter validation warnings without forwarded headers');
        for (let i = 1; i < OIDC.limit; i++) {
            assertAllowed(await request(server.base, '/api/auth/oidc/login', forwarded(`198.51.100.${i}`)), OIDC.limit,
                'Untrusted forwarded addresses stay below the limit');
        }
        assertLimited(await request(server.base, '/api/auth/oidc/login', forwarded('198.51.100.200')), OIDC,
            'Untrusted forwarded addresses are ignored');
        assertLimited(await request(server.base, '/api/auth/oidc/login', forwarded('2001:db8::1')), OIDC,
            'An untrusted forwarded IPv6 address is ignored');
        if (ipv6) {
            assertAllowed(await request(server.base6, '/api/auth/oidc/login'), OIDC.limit,
                'A direct IPv6 client keeps its own allowance without proxy trust');
        }
        // Each library check runs once per limiter, on its first request. A
        // first request with a forwarded header and no proxy trust is logged
        // as a misconfiguration hint; it neither throws nor stops the server.
        assert.deepEqual(validationCodes(server.output), [],
            `The single sign-on limiter validated its first, direct request without warnings:\n${server.output}`);
        assert.equal((await request(server.base, '/api/auth/session', forwarded('198.51.100.40'))).response.status, 200);
        for (let i = 0; i < 20 && !validationCodes(server.output).length; i++) await sleep(50);
        assert.deepEqual(validationCodes(server.output), ['ERR_ERL_UNEXPECTED_X_FORWARDED_FOR'],
            `Only the forwarded-header hint appears without proxy trust:\n${server.output}`);
        assert.equal((await request(server.base, '/api/auth/session', forwarded('198.51.100.41'))).response.status, 200);
        await sleep(200);
        assert.equal(server.output.match(/ValidationError:/g).length, 1, 'The hint is logged once');
        assert.equal((await request(server.base, '/api/version')).response.status, 200, 'The hint does not stop the server');
        await stopServer(server);

        // TRUST_PROXY=true is narrowed by the application, so the limiter never
        // sees the permissive Express setting. A hop count is accepted as is.
        for (const trustProxy of ['true', '1', 'loopback']) {
            server = await startServer(path.join(temporary, `trust-${trustProxy}`), trustProxy);
            for (const address of ['198.51.100.30', '2001:db8:abcd:1400::1', '::ffff:198.51.100.31', null]) {
                assertAllowed(await request(server.base, '/api/auth/oidc/login', forwarded(address)), OIDC.limit,
                    `TRUST_PROXY=${trustProxy} accepts a request from ${address || 'the socket address'}`);
                assert.equal((await request(server.base, '/api/auth/session', forwarded(address))).response.status, 200);
                assert.equal((await request(server.base, '/api/startup', forwarded(address))).response.status, 200);
            }
            if (ipv6) assertAllowed(await request(server.base6, '/api/auth/oidc/login'), OIDC.limit, 'IPv6 loopback is accepted');
            assert.deepEqual(validationCodes(server.output), [],
                `No limiter validation warnings with TRUST_PROXY=${trustProxy}:\n${server.output}`);
            if (trustProxy === 'true') assert.match(server.output, /TRUST_PROXY=true is unrestricted/);
            await stopServer(server);
        }

        console.log(`Request-limiter counts, headers, IPv4/IPv4-mapped/IPv6 keys, proxy trust and startup validation passed${ipv6 ? '' : ' (IPv6 loopback unavailable; direct IPv6 checks skipped)'}.`);
    } finally {
        await stopServer(server);
        await fs.rm(temporary, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
