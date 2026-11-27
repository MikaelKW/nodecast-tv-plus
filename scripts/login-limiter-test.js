const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { isApplicationReady } = require('./helpers/applicationReadiness');

const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ACCOUNT_LIMIT = 5;
const ADDRESS_LIMIT = 25;
const WINDOW_SECONDS = 15 * 60;
const USERNAME = 'limit-owner';

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
    const server = { output: '', base: `http://127.0.0.1:${port}`, base6: `http://[::1]:${port}` };
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
        try { if (await isApplicationReady(server.base)) break; } catch {}
        await sleep(100);
    }
    if (server.child.exitCode !== null || !await isApplicationReady(server.base).catch(() => false)) {
        server.child.kill('SIGKILL');
        throw new Error(`Login-limiter test server did not start: ${server.output}`);
    }
    server.password = crypto.randomBytes(24).toString('base64url');
    const setup = await fetch(`${server.base}/api/auth/setup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: server.password, passwordConfirmation: server.password })
    });
    assert.equal(setup.status, 201, 'The test account is created');
    await setup.arrayBuffer();
    return server;
}

async function stopServer(server) {
    if (!server || server.child.exitCode !== null) return;
    server.child.kill('SIGTERM');
    for (let i = 0; i < 50 && server.child.exitCode === null; i++) await sleep(100);
    if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

async function login(base, { username = USERNAME, password, address } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (address) headers['X-Forwarded-For'] = address;
    const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers, body: JSON.stringify({ username, password })
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { response, body };
}

function assertRejected(result, message) {
    assert.equal(result.response.status, 401, message);
    assert.deepEqual(result.body, { error: 'Invalid credentials' }, message);
}

function assertSignedIn(result, message) {
    assert.equal(result.response.status, 200, message);
    assert.equal(result.body?.user?.username, USERNAME, message);
}

function assertLimited(result, message) {
    assert.equal(result.response.status, 429, message);
    assert.deepEqual(result.body, { error: 'Too many authentication attempts. Try again later.' }, message);
    const retry = Number(result.response.headers.get('retry-after'));
    assert(retry > 0 && retry <= WINDOW_SECONDS, `${message}: Retry-After stays inside the window`);
    assert.equal(result.response.headers.get('ratelimit-policy'), null, `${message}: no request-limiter headers`);
}

async function failAccount(base, addressFor) {
    for (let i = 0; i < ACCOUNT_LIMIT; i++) {
        assertRejected(await login(base, { password: 'wrong-password', address: addressFor(i) }),
            `Failed sign-in ${i + 1} for the account stays below the limit`);
    }
}

async function failAddress(base, addressFor, prefix, count = ADDRESS_LIMIT) {
    // Distinct unknown usernames keep the account limiter out of the way.
    for (let i = 0; i < count; i++) {
        assertRejected(await login(base, { username: `${prefix}-${i}`, password: 'wrong-password', address: addressFor(i) }),
            `Failed sign-in ${i + 1} from one address stays below the limit`);
    }
}

(async () => {
    const ipv6 = await ipv6LoopbackAvailable();
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-login-limiter-'));
    let server;
    try {
        // The default proxy trust honours forwarded addresses from loopback and
        // private networks, so the test client can act as a reverse proxy.
        server = await startServer(path.join(temporary, 'trusted'), '');
        const { password } = server;

        await failAccount(server.base, () => '198.51.100.10');
        assertLimited(await login(server.base, { password, address: '198.51.100.10' }),
            'The account limit applies to the failing client');
        assertLimited(await login(server.base, { password, address: '::ffff:198.51.100.10' }),
            'An IPv4-mapped IPv6 address uses the IPv4 client key');
        assertSignedIn(await login(server.base, { password, address: '198.51.100.11' }),
            'Another client behind the proxy keeps its own account allowance');
        assertSignedIn(await login(server.base, { password }),
            'The proxy itself is not charged for its forwarded clients');

        await failAddress(server.base, () => '203.0.113.5', 'unknown-v4');
        assertLimited(await login(server.base, { password, address: '203.0.113.5' }),
            'The address limit applies to the failing client');
        assertSignedIn(await login(server.base, { password, address: '203.0.113.6' }),
            'Another client behind the proxy keeps its own address allowance');

        await failAddress(server.base, i => `2001:db8:abcd:1200::${i + 1}`, 'unknown-v6');
        assertLimited(await login(server.base, { password, address: '2001:db8:abcd:12ff::1' }),
            'IPv6 addresses in the same /56 share one address allowance');
        assertSignedIn(await login(server.base, { password, address: '2001:db8:abcd:1300::1' }),
            'A different IPv6 /56 keeps its own allowance');

        await failAccount(server.base, i => `2001:db8:abcd:1400::${i + 1}`);
        assertLimited(await login(server.base, { password, address: '2001:db8:abcd:14ff::1' }),
            'IPv6 addresses in the same /56 share one account allowance');
        assertSignedIn(await login(server.base, { password, address: '2001:db8:abcd:1500::1' }),
            'A different IPv6 /56 keeps its own account allowance');
        await stopServer(server);

        // Without proxy trust, forwarded addresses must not split or reset the
        // allowance of the connecting client.
        server = await startServer(path.join(temporary, 'untrusted'), 'false');
        await failAccount(server.base, i => `198.51.100.${i + 1}`);
        assertLimited(await login(server.base, { password: server.password, address: '198.51.100.100' }),
            'Untrusted forwarded addresses do not split the account allowance');
        await failAddress(server.base, i => `198.51.100.${i + 101}`, 'unknown-untrusted', ADDRESS_LIMIT - ACCOUNT_LIMIT);
        assertLimited(await login(server.base, { username: 'another-user', password: 'wrong-password', address: '203.0.113.50' }),
            'Untrusted forwarded addresses do not split the address allowance');
        assertLimited(await login(server.base, { username: 'another-user', password: 'wrong-password', address: '2001:db8::1' }),
            'An untrusted forwarded IPv6 address is ignored');
        assertLimited(await login(server.base, { password: server.password }),
            'The connecting client stays limited without forwarded headers');
        if (ipv6) {
            assertSignedIn(await login(server.base6, { password: server.password }),
                'A direct IPv6 client keeps its own allowance');
        }

        console.log(`Login-limiter client keys, proxy trust, IPv4-mapped and IPv6 grouping passed${ipv6 ? '' : ' (IPv6 loopback unavailable; direct IPv6 check skipped)'}.`);
    } finally {
        await stopServer(server);
        await fs.rm(temporary, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
