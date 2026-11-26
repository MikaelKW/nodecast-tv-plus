const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function startServer(directory, trustProxy) {
    await fs.mkdir(directory, { recursive: true });
    const clock = path.join(directory, 'clock.cjs');
    // This preload exists only in the disposable temporary directory. Advancing
    // the child clock tests expiry without sleeping through the real window.
    await fs.writeFile(clock, `const now=Date.now.bind(Date);let offset=0;Date.now=()=>now()+offset;
process.on('message',m=>{if(m?.advance===61000){offset+=m.advance;process.send({advanced:true});}});`);
    const port = await freePort();
    let output = '';
    const child = spawn(process.execPath, ['--require', clock, 'server/index.js'], {
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
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 150; i++) {
        if (child.exitCode !== null) throw new Error(`Test server exited: ${output}`);
        try { if (await require('./helpers/applicationReadiness').isApplicationReady(base)) return { child, base }; } catch {}
        await sleep(100);
    }
    child.kill('SIGKILL');
    throw new Error('Session-limit test server did not start');
}

async function stopServer(server) {
    if (!server || server.child.exitCode !== null) return;
    server.child.kill('SIGTERM');
    for (let i = 0; i < 50 && server.child.exitCode === null; i++) await sleep(100);
    if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

async function session(server, headers = {}) {
    const response = await fetch(`${server.base}/api/auth/session`, { headers });
    const body = await response.json();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { response, body };
}

function assertLimited(result) {
    assert.equal(result.response.status, 429);
    assert.deepEqual(result.body, { error: 'Too many session checks. Try again shortly.' });
    assert.match(result.response.headers.get('ratelimit-policy'), /^120;w=60$/);
    const retry = Number(result.response.headers.get('retry-after'));
    assert(retry > 0 && retry <= 60, 'A blocked response provides the remaining retry window');
}

(async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-session-limit-'));
    let direct;
    let proxy;
    try {
        direct = await startServer(path.join(temporary, 'direct'), 'false');
        const password = crypto.randomBytes(24).toString('base64url');
        const setup = await fetch(`${direct.base}/api/auth/setup`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'limit-test-account', password, passwordConfirmation: password })
        });
        assert.equal(setup.status, 201);
        const cookie = setup.headers.getSetCookie().find(value => value.startsWith('nodecast_auth_')).split(';')[0];
        await setup.arrayBuffer();
        for (let i = 0; i < 120; i++) {
            const headers = {};
            if (i) headers['X-Forwarded-For'] = `198.51.100.${i + 1}`;
            if (i % 2) headers.Cookie = cookie;
            const result = await session(direct, headers);
            assert.equal(result.response.status, 200, 'Shared-IP normal checks remain available below the limit');
            assert.equal(result.body.authenticated, Boolean(i % 2));
        }
        assertLimited(await session(direct, { 'X-Forwarded-For': '203.0.113.10', Cookie: cookie }));
        assertLimited(await session(direct, { 'X-Forwarded-For': '203.0.113.11' }));
        assert.equal((await fetch(`${direct.base}/api/auth/me`)).status, 401);
        assert.equal((await fetch(`${direct.base}/api/auth/me`, { headers: { Cookie: cookie } })).status, 200);
        assert.equal((await fetch(`${direct.base}/api/settings`)).status, 401);
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Clock acknowledgement timed out')), 5000);
            direct.child.once('message', message => {
                clearTimeout(timeout);
                try { assert.equal(message.advanced, true); resolve(); } catch (error) { reject(error); }
            });
            direct.child.send({ advance: 61000 });
        });
        assert.equal((await session(direct)).response.status, 200, 'The real limiter recovers after its window');
        await stopServer(direct);

        proxy = await startServer(path.join(temporary, 'proxy'), 'loopback');
        for (let i = 0; i < 120; i++) {
            assert.equal((await session(proxy, { 'X-Forwarded-For': '198.51.100.10' })).response.status, 200);
        }
        assertLimited(await session(proxy, { 'X-Forwarded-For': '198.51.100.10' }));
        assert.equal((await session(proxy, { 'X-Forwarded-For': '198.51.100.11' })).response.status, 200);
        for (let i = 0; i < 120; i++) {
            assert.equal((await session(proxy, { 'X-Forwarded-For': `2001:db8:abcd:1200::${i + 1}` })).response.status, 200);
        }
        assertLimited(await session(proxy, { 'X-Forwarded-For': '2001:db8:abcd:12ff::1' }));
        assert.equal((await session(proxy, { 'X-Forwarded-For': '2001:db8:abcd:1300::1' })).response.status, 200);
        console.log('Session-status bounds, shared-IP usage, retry/expiry, proxy trust and IPv6 grouping passed.');
    } finally {
        await stopServer(direct);
        await stopServer(proxy);
        await fs.rm(temporary, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
