const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');

class BrowserCookieJar {
    constructor() {
        this.cookies = new Map();
    }

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

    header() {
        return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }

    names(prefix) {
        return [...this.cookies.keys()].filter(name => name.startsWith(prefix));
    }
}

function randomSecret() {
    return crypto.randomBytes(48).toString('hex');
}

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

async function waitForServer(baseUrl, child, output, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited with code ${child.exitCode}.\n${output()}`);
        }
        try {
            if ((await fetch(`${baseUrl}/api/health`)).ok) return;
        } catch {
            // Startup may still be in progress.
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Server did not become ready.\n${output()}`);
}

async function startServer({ dataDirectory, port, secrets, basePath = '' }) {
    const rootUrl = `http://127.0.0.1:${port}${basePath}`;
    let output = '';
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            NODECAST_DATA_DIR: dataDirectory,
            NODECAST_BASE_PATH: basePath,
            NODECAST_INSTANCE_ID: '',
            NODECAST_DISABLE_BACKGROUND_JOBS: 'true',
            PORT: String(port),
            JWT_SECRET: secrets.jwt,
            SESSION_SECRET: secrets.session,
            OIDC_ISSUER_URL: 'http://127.0.0.1:9/oidc',
            OIDC_CLIENT_ID: 'cookie-isolation-test',
            OIDC_CLIENT_SECRET: randomSecret(),
            OIDC_CALLBACK_URL: `${rootUrl}/api/auth/oidc/callback`,
            OIDC_AUTH_URL: 'http://127.0.0.1:9/oidc/authorize',
            OIDC_TOKEN_URL: 'http://127.0.0.1:9/oidc/token',
            OIDC_USERINFO_URL: 'http://127.0.0.1:9/oidc/userinfo',
            DISABLE_LOCAL_AUTH: 'false',
            OIDC_AUTO_REDIRECT: 'false'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    await waitForServer(rootUrl, child, () => output);
    return { child, rootUrl, output: () => output };
}

async function stopServer(server) {
    if (!server?.child || server.child.exitCode !== null) return;
    server.child.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => server.child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000))
    ]);
    if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

async function request(rootUrl, route, {
    method = 'GET',
    body,
    jar,
    redirect = 'follow'
} = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (jar?.header()) headers.Cookie = jar.header();
    const response = await fetch(`${rootUrl}${route}`, {
        method,
        headers,
        redirect,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    jar?.absorb(response);
    return response;
}

function assertProtectedCookie(header, expectedMaxAge) {
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=Lax/i);
    if (expectedMaxAge !== null) {
        assert.match(header, new RegExp(`Max-Age=${expectedMaxAge}(?:;|$)`, 'i'));
    }
}

function cookieNameFromResponse(response, prefix) {
    const header = response.headers.getSetCookie()
        .find(value => value.startsWith(prefix));
    assert.ok(header, `Expected a ${prefix} cookie.`);
    return header.slice(0, header.indexOf('='));
}

async function run() {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-cookie-isolation-'));
    const dataA = path.join(temporaryRoot, 'instance-a');
    const dataB = path.join(temporaryRoot, 'instance-b');
    const portA = await getFreePort();
    const portB = await getFreePort();
    const secretsA = { jwt: randomSecret(), session: randomSecret() };
    const secretsB = { jwt: randomSecret(), session: randomSecret() };
    const browser = new BrowserCookieJar();
    let serverA;
    let serverB;

    try {
        serverA = await startServer({ dataDirectory: dataA, port: portA, secrets: secretsA });
        serverB = await startServer({
            dataDirectory: dataB,
            port: portB,
            secrets: secretsB,
            basePath: '/second'
        });

        const oidcA = await request(serverA.rootUrl, '/api/auth/oidc/login', {
            jar: browser,
            redirect: 'manual'
        });
        assert.equal(oidcA.status, 302, serverA.output());
        const oidcAHeader = oidcA.headers.getSetCookie().join('; ');
        assertProtectedCookie(oidcAHeader, null);

        const oidcB = await request(serverB.rootUrl, '/api/auth/oidc/login', {
            jar: browser,
            redirect: 'manual'
        });
        assert.equal(oidcB.status, 302, serverB.output());
        const oidcBHeader = oidcB.headers.getSetCookie().join('; ');
        assertProtectedCookie(oidcBHeader, null);
        const sessionCookieNames = browser.names('nodecast.sid.');
        assert.equal(sessionCookieNames.length, 2, 'OIDC sessions from both instances must coexist.');
        assert.notEqual(sessionCookieNames[0], sessionCookieNames[1]);

        const passwordA = randomSecret();
        const passwordB = randomSecret();
        const setupA = await request(serverA.rootUrl, '/api/auth/setup', {
            method: 'POST',
            jar: browser,
            body: {
                username: 'instance-a-admin',
                password: passwordA,
                passwordConfirmation: passwordA
            }
        });
        assert.equal(setupA.status, 201, serverA.output());
        assertProtectedCookie(setupA.headers.getSetCookie().join('; '), 86400);
        const instanceAAuthCookie = cookieNameFromResponse(setupA, 'nodecast_auth_');

        const setupB = await request(serverB.rootUrl, '/api/auth/setup', {
            method: 'POST',
            jar: browser,
            body: {
                username: 'instance-b-admin',
                password: passwordB,
                passwordConfirmation: passwordB
            }
        });
        assert.equal(setupB.status, 201, serverB.output());
        assertProtectedCookie(setupB.headers.getSetCookie().join('; '), 86400);
        const instanceBAuthCookie = cookieNameFromResponse(setupB, 'nodecast_auth_');

        const authCookieNames = browser.names('nodecast_auth_');
        assert.equal(authCookieNames.length, 2, 'Authentication cookies from both instances must coexist.');
        assert.notEqual(authCookieNames[0], authCookieNames[1]);

        const meA = await request(serverA.rootUrl, '/api/auth/me', { jar: browser });
        const meB = await request(serverB.rootUrl, '/api/auth/me', { jar: browser });
        assert.equal(meA.status, 200);
        assert.equal((await meA.json()).username, 'instance-a-admin');
        assert.equal(meB.status, 200);
        assert.equal((await meB.json()).username, 'instance-b-admin');

        const cookieNamesBeforeRestart = new Set(browser.cookies.keys());
        await stopServer(serverB);
        serverB = await startServer({
            dataDirectory: dataB,
            port: portB,
            secrets: secretsB,
            basePath: '/second'
        });
        const restartedMeB = await request(serverB.rootUrl, '/api/auth/me', { jar: browser });
        assert.equal(restartedMeB.status, 200, serverB.output());
        assert.equal((await restartedMeB.json()).username, 'instance-b-admin');
        assert.deepEqual(new Set(browser.cookies.keys()), cookieNamesBeforeRestart);
        assert.ok(browser.cookies.has(instanceBAuthCookie));

        const legacyJar = new BrowserCookieJar();
        legacyJar.cookies.set('nodecast_auth', browser.cookies.get(instanceAAuthCookie));
        const legacyMe = await request(serverA.rootUrl, '/api/auth/me', { jar: legacyJar });
        assert.equal(legacyMe.status, 200);
        assert.equal((await legacyMe.json()).username, 'instance-a-admin');
        assert.equal(legacyJar.names('nodecast_auth_').length, 1, 'A valid legacy cookie must migrate.');

        const logoutA = await request(serverA.rootUrl, '/api/auth/logout', {
            method: 'POST',
            jar: browser
        });
        assert.equal(logoutA.status, 200);
        assert.equal((await request(serverA.rootUrl, '/api/auth/me', { jar: browser })).status, 401);
        assert.equal((await request(serverB.rootUrl, '/api/auth/me', { jar: browser })).status, 200);

        console.log('Session-cookie isolation tests passed.');
    } finally {
        await stopServer(serverA);
        await stopServer(serverB);
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
