const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
    discoverOidcEndpoints,
    resolveOidcEndpoints
} = require('../server/services/oidcDiscovery');

async function run() {
    let issuer;
    const server = http.createServer((req, res) => {
        if (req.url !== '/application/o/nodecast/.well-known/openid-configuration') {
            res.writeHead(404).end();
            return;
        }

        const body = JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            userinfo_endpoint: `${issuer}/userinfo`
        });
        res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body)
        });
        res.end(body);
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    try {
        const { port } = server.address();
        issuer = `http://127.0.0.1:${port}/application/o/nodecast`;

        const discovered = await discoverOidcEndpoints(`${issuer}/`);
        assert.deepEqual(discovered, {
            authorizationURL: `${issuer}/authorize`,
            tokenURL: `${issuer}/token`,
            userInfoURL: `${issuer}/userinfo`
        });

        let discoveryCalled = false;
        const manual = await resolveOidcEndpoints({
            issuerUrl: issuer,
            authorizationUrl: 'https://login.example.test/authorize',
            tokenUrl: 'https://login.example.test/token',
            userInfoUrl: 'https://login.example.test/userinfo'
        }, {
            fetchImpl: async () => {
                discoveryCalled = true;
                throw new Error('Manual configuration must skip discovery.');
            }
        });
        assert.equal(discoveryCalled, false);
        assert.equal(manual.source, 'manual');

        await assert.rejects(
            discoverOidcEndpoints('ftp://identity.example.test'),
            /must use HTTPS/
        );

        await assert.rejects(
            discoverOidcEndpoints('http://identity.example.test'),
            /must use HTTPS/
        );

        await assert.rejects(
            discoverOidcEndpoints(issuer, {
                fetchImpl: async () => new Response(JSON.stringify({
                    issuer: 'https://different-issuer.example.test',
                    authorization_endpoint: 'https://different-issuer.example.test/authorize',
                    token_endpoint: 'https://different-issuer.example.test/token',
                    userinfo_endpoint: 'https://different-issuer.example.test/userinfo'
                }))
            }),
            /issuer does not match/
        );

        const appPort = await getAvailablePort();
        const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-oidc-route-'));
        const app = spawn(process.execPath, ['server/index.js'], {
            cwd: path.join(__dirname, '..'),
            env: {
                ...process.env,
                NODE_ENV: 'production',
                PORT: String(appPort),
                NODECAST_DATA_DIR: testData,
                NODECAST_DISABLE_BACKGROUND_JOBS: 'true',
                JWT_SECRET: crypto.randomBytes(48).toString('hex'),
                SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
                OIDC_ISSUER_URL: issuer,
                OIDC_CLIENT_ID: 'controlled-test-client',
                OIDC_CLIENT_SECRET: crypto.randomBytes(32).toString('hex'),
                OIDC_CALLBACK_URL: `http://127.0.0.1:${appPort}/api/auth/oidc/callback`,
                OIDC_AUTH_URL: '',
                OIDC_TOKEN_URL: '',
                OIDC_USERINFO_URL: '',
                DISABLE_LOCAL_AUTH: 'true',
                OIDC_AUTO_REDIRECT: 'true'
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        let appErrors = '';
        app.stderr.on('data', data => { appErrors += data.toString(); });

        try {
            await waitForServer(`http://127.0.0.1:${appPort}/api/version`);
            const statusResponse = await fetch(`http://127.0.0.1:${appPort}/api/auth/oidc/status`);
            assert.equal(statusResponse.status, 200);
            assert.deepEqual(await statusResponse.json(), {
                enabled: true,
                localAuthEnabled: false,
                autoRedirect: true
            });

            const bootstrapPassword = crypto.randomBytes(24).toString('base64url');
            const setupResponse = await fetch(`http://127.0.0.1:${appPort}/api/auth/setup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: 'bootstrap-admin',
                    password: bootstrapPassword,
                    passwordConfirmation: bootstrapPassword
                })
            });
            assert.equal(setupResponse.status, 201, appErrors);

            const localLoginResponse = await fetch(`http://127.0.0.1:${appPort}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'bootstrap-admin', password: bootstrapPassword })
            });
            assert.equal(localLoginResponse.status, 403);
            assert.deepEqual(await localLoginResponse.json(), {
                error: 'Local sign-in is disabled. Use single sign-on.'
            });

            const loginResponse = await fetch(`http://127.0.0.1:${appPort}/api/auth/oidc/login`, {
                redirect: 'manual'
            });
            assert.equal(loginResponse.status, 302, appErrors);
            assert.match(loginResponse.headers.get('location') || '', new RegExp(`^${escapeRegExp(issuer)}/authorize\\?`));
        } finally {
            app.kill();
            await new Promise(resolve => app.once('exit', resolve));
            fs.rmSync(testData, { recursive: true, force: true });
        }

        console.log('OIDC discovery tests passed.');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

async function getAvailablePort() {
    const probe = http.createServer();
    await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
}

async function waitForServer(url) {
    let lastError;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw lastError || new Error('Application server did not start in time.');
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
