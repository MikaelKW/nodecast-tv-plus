#!/usr/bin/env node
/**
 * End-to-end tests for the single sign-on callback against a controlled
 * OpenID Connect provider: successful sign-in, rejected authentication,
 * provider errors and the hand-off to a second factor. Each case also checks
 * the administrator sign-in log.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const OTPAuth = require('otpauth');

const projectRoot = path.join(__dirname, '..');
const CLIENT_ID = 'nodecast-test-client';
const CLIENT_SECRET = crypto.randomBytes(24).toString('hex');

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

/**
 * Sends a request without following redirects, so each step of the sign-in
 * flow can be inspected.
 */
async function request(url, { method = 'GET', body, jar = new CookieJar(), headers = {} } = {}) {
    const allHeaders = { ...headers };
    if (body !== undefined) allHeaders['Content-Type'] = 'application/json';
    if (jar.header()) allHeaders.Cookie = jar.header();
    const response = await fetch(url, {
        method,
        headers: allHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
    });
    jar.absorb(response);
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    return { response, payload, jar };
}

function base64url(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * A minimal OpenID Connect provider. The test decides which identity each
 * authorization code belongs to and can make the token endpoint fail.
 */
async function startProvider() {
    const codes = new Map();
    const accessTokens = new Map();
    const tokenRequests = [];
    let issuer;
    let tokenFailure = null;

    const send = (res, status, value) => {
        const body = JSON.stringify(value);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, issuer);
        if (url.pathname === '/.well-known/openid-configuration') {
            return send(res, 200, {
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}/token`,
                userinfo_endpoint: `${issuer}/userinfo`
            });
        }
        if (url.pathname === '/token' && req.method === 'POST') {
            let raw = '';
            req.on('data', chunk => { raw += chunk; });
            req.on('end', () => {
                const form = new URLSearchParams(raw);
                tokenRequests.push(Object.fromEntries(form));
                if (tokenFailure) return send(res, tokenFailure.status, tokenFailure.body);
                const authorization = req.headers.authorization || '';
                const [basicId, basicSecret] = authorization.startsWith('Basic ')
                    ? Buffer.from(authorization.slice(6), 'base64').toString().split(':').map(decodeURIComponent)
                    : [form.get('client_id'), form.get('client_secret')];
                if (basicId !== CLIENT_ID || basicSecret !== CLIENT_SECRET) {
                    return send(res, 401, { error: 'invalid_client' });
                }
                const grant = codes.get(form.get('code'));
                codes.delete(form.get('code'));
                if (!grant || form.get('grant_type') !== 'authorization_code') {
                    return send(res, 400, { error: 'invalid_grant' });
                }
                const now = Math.floor(Date.now() / 1000);
                const claims = {
                    iss: issuer,
                    sub: grant.sub,
                    aud: CLIENT_ID,
                    iat: now,
                    exp: now + 300,
                    ...grant.profile,
                    ...grant.claims
                };
                const accessToken = crypto.randomBytes(16).toString('hex');
                accessTokens.set(accessToken, grant);
                return send(res, 200, {
                    access_token: accessToken,
                    token_type: 'Bearer',
                    expires_in: 300,
                    id_token: `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.signature`
                });
            });
            return undefined;
        }
        if (url.pathname === '/userinfo') {
            const token = (req.headers.authorization || '').replace(/^Bearer /, '');
            const grant = accessTokens.get(token);
            if (!grant) return send(res, 401, { error: 'invalid_token' });
            return send(res, 200, { sub: grant.sub, ...grant.profile });
        }
        res.writeHead(404).end();
        return undefined;
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    issuer = `http://127.0.0.1:${server.address().port}`;

    return {
        issuer,
        tokenRequests,
        issueCode(sub, profile = {}, claims = {}) {
            const code = crypto.randomBytes(16).toString('hex');
            codes.set(code, { sub, profile, claims });
            return code;
        },
        failTokenRequests(status, body) { tokenFailure = { status, body }; },
        restoreTokenRequests() { tokenFailure = null; },
        close: () => new Promise(resolve => server.close(resolve))
    };
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

async function startServer(dataDirectory, secrets, provider) {
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
            APP_ORIGIN: baseUrl,
            JWT_SECRET: secrets.jwt,
            SESSION_SECRET: secrets.session,
            TOTP_ENCRYPTION_KEY: secrets.totp,
            OIDC_ISSUER_URL: provider ? provider.issuer : '',
            OIDC_CLIENT_ID: provider ? CLIENT_ID : '',
            OIDC_CLIENT_SECRET: provider ? CLIENT_SECRET : '',
            OIDC_AUTH_URL: '',
            OIDC_TOKEN_URL: '',
            OIDC_USERINFO_URL: '',
            OIDC_CALLBACK_URL: `${baseUrl}/api/auth/oidc/callback`,
            DISABLE_LOCAL_AUTH: '',
            TRUST_PROXY: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    try {
        await waitForServer(baseUrl, child);
        if (provider) {
            // Discovery runs in the background after start-up.
            const deadline = Date.now() + 15000;
            while (!(await request(`${baseUrl}/api/auth/oidc/status`)).payload?.enabled) {
                if (Date.now() > deadline) throw new Error('Single sign-on did not become available.');
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
    } catch (error) {
        console.error(output);
        throw error;
    }
    return { baseUrl, child, output: () => output };
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

function totp(secret) {
    return new OTPAuth.TOTP({
        algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret)
    }).generate();
}

/**
 * Starts single sign-on in a fresh browser session and returns the state the
 * provider must send back, as the browser would receive it.
 */
async function beginSso(baseUrl, issuer) {
    const jar = new CookieJar();
    const start = await request(`${baseUrl}/api/auth/oidc/login`, { jar });
    assert.equal(start.response.status, 302);
    const authorize = new URL(start.response.headers.get('location'));
    assert.equal(authorize.origin + authorize.pathname, `${issuer}/authorize`);
    assert.equal(authorize.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(authorize.searchParams.get('redirect_uri'), `${baseUrl}/api/auth/oidc/callback`);
    assert.match(authorize.searchParams.get('scope'), /\bopenid\b/);
    const state = authorize.searchParams.get('state');
    assert.ok(state, 'The authorization request carries a state value.');
    return { jar, state };
}

async function callback(baseUrl, jar, params) {
    return request(`${baseUrl}/api/auth/oidc/callback?${new URLSearchParams(params)}`, { jar });
}

// The instance-specific authentication cookie (nodecast_auth_<suffix>).
function authCookie(jar) {
    return [...jar.cookies.keys()].find(name => name.startsWith('nodecast_auth_'));
}

function assertSsoFailedRedirect(result) {
    assert.equal(result.response.status, 302);
    assert.equal(result.response.headers.get('location'), '/login.html?error=SSO+Failed');
}

async function readLog(baseUrl, jar) {
    const result = await request(`${baseUrl}/api/auth-log?pageSize=100`, { jar });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    return result.payload.entries;
}

async function run() {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-oidc-callback-'));
    const secrets = {
        jwt: crypto.randomBytes(48).toString('hex'),
        session: crypto.randomBytes(48).toString('hex'),
        totp: crypto.randomBytes(48).toString('hex')
    };
    const adminPassword = `Admin-${crypto.randomBytes(8).toString('hex')}`;
    const provider = await startProvider();
    let server;

    try {
        // Without a provider configuration the callback is unavailable.
        server = await startServer(dataDirectory, secrets, null);
        const admin = new CookieJar();
        const setup = await request(`${server.baseUrl}/api/auth/setup`, {
            method: 'POST', jar: admin,
            body: { username: 'admin', password: adminPassword, passwordConfirmation: adminPassword }
        });
        assert.equal(setup.response.status, 201);
        const unavailable = await request(`${server.baseUrl}/api/auth/oidc/callback?code=x&state=y`);
        assert.equal(unavailable.response.status, 503);
        assert.equal(authCookie(unavailable.jar), undefined);

        // Enrol TOTP on the local administrator, who is later linked to the provider.
        const enroll = await request(`${server.baseUrl}/api/auth/2fa/enroll`, {
            method: 'POST', jar: admin, body: { password: adminPassword }
        });
        assert.equal(enroll.response.status, 200);
        const totpSecret = enroll.payload.manualSecret;
        const confirmed = await request(`${server.baseUrl}/api/auth/2fa/confirm`, {
            method: 'POST', jar: admin, body: { code: totp(totpSecret) }
        });
        assert.equal(confirmed.response.status, 200);
        const recoveryCode = confirmed.payload.recoveryCodes[0];
        await stopServer(server.child);

        // Link the administrator to a provider subject, as an existing SSO account would be.
        const dbPath = path.join(dataDirectory, 'db.json');
        const stored = JSON.parse(await fs.readFile(dbPath, 'utf8'));
        stored.users.find(user => user.username === 'admin').oidcId = 'subject-admin';
        await fs.writeFile(dbPath, JSON.stringify(stored, null, 2));

        server = await startServer(dataDirectory, secrets, provider);
        const { baseUrl } = server;

        // 1. Successful sign-in provisions the account and signs it in.
        {
            const { jar, state } = await beginSso(baseUrl, provider.issuer);
            const code = provider.issueCode('subject-viewer', { email: 'viewer@example.test', preferred_username: 'viewer' });
            const done = await callback(baseUrl, jar, { code, state });
            assert.equal(done.response.status, 302);
            assert.equal(done.response.headers.get('location'), '/');
            assert.ok(authCookie(jar), 'A successful sign-in sets the authentication cookie.');
            const me = await request(`${baseUrl}/api/auth/me`, { jar });
            assert.equal(me.response.status, 200);
            assert.equal(me.payload.role, 'viewer');
            const tokenRequest = provider.tokenRequests.at(-1);
            assert.equal(tokenRequest.code, code);
            assert.equal(tokenRequest.redirect_uri, `${baseUrl}/api/auth/oidc/callback`);

            // The state is single-use: replaying the callback is rejected.
            const replay = await callback(baseUrl, new CookieJar(), { code, state });
            assertSsoFailedRedirect(replay);
        }

        // 2. Rejected authentication.
        {
            // The user declines at the provider.
            const declined = await beginSso(baseUrl, provider.issuer);
            const denied = await callback(baseUrl, declined.jar, {
                error: 'access_denied', error_description: 'The user declined.', state: declined.state
            });
            assertSsoFailedRedirect(denied);
            assert.equal(authCookie(declined.jar), undefined);

            // A forged state value.
            const forged = await beginSso(baseUrl, provider.issuer);
            const forgedResult = await callback(baseUrl, forged.jar, {
                code: provider.issueCode('subject-viewer'), state: `${forged.state}x`
            });
            assertSsoFailedRedirect(forgedResult);
            assert.equal(authCookie(forged.jar), undefined);

            // An ID token for another client.
            const otherClient = await beginSso(baseUrl, provider.issuer);
            const wrongAudience = await callback(baseUrl, otherClient.jar, {
                code: provider.issueCode('subject-viewer', {}, { aud: 'another-client' }), state: otherClient.state
            });
            assertSsoFailedRedirect(wrongAudience);
            assert.equal(authCookie(otherClient.jar), undefined);

            // An expired ID token.
            const expired = await beginSso(baseUrl, provider.issuer);
            const expiredResult = await callback(baseUrl, expired.jar, {
                code: provider.issueCode('subject-viewer', {}, { exp: Math.floor(Date.now() / 1000) - 60 }), state: expired.state
            });
            assertSsoFailedRedirect(expiredResult);
            assert.equal(authCookie(expired.jar), undefined);
        }

        // 3. Provider errors.
        {
            // The provider reports an error on the authorization response.
            const authorizeError = await beginSso(baseUrl, provider.issuer);
            const errored = await callback(baseUrl, authorizeError.jar, {
                error: 'server_error', error_description: 'Provider failure', state: authorizeError.state
            });
            assert.ok(errored.response.status >= 500, `Expected a server error, received ${errored.response.status}.`);
            assert.equal(authCookie(authorizeError.jar), undefined);

            // The token endpoint fails.
            provider.failTokenRequests(500, { error: 'temporarily_unavailable' });
            const tokenError = await beginSso(baseUrl, provider.issuer);
            const tokenResult = await callback(baseUrl, tokenError.jar, {
                code: provider.issueCode('subject-viewer'), state: tokenError.state
            });
            provider.restoreTokenRequests();
            assert.ok(tokenResult.response.status >= 500, `Expected a server error, received ${tokenResult.response.status}.`);
            assert.equal(authCookie(tokenError.jar), undefined);

            // The token endpoint rejects the authorization code.
            const badGrant = await beginSso(baseUrl, provider.issuer);
            const badGrantResult = await callback(baseUrl, badGrant.jar, { code: 'unknown-code', state: badGrant.state });
            assert.notEqual(badGrantResult.response.headers.get('location'), '/');
            assert.equal(authCookie(badGrant.jar), undefined);
        }

        // 4. A linked account with TOTP is handed to the second factor.
        let totpFlowId;
        let recoveryFlowId;
        {
            const { jar, state } = await beginSso(baseUrl, provider.issuer);
            const handoff = await callback(baseUrl, jar, { code: provider.issueCode('subject-admin'), state });
            assert.equal(handoff.response.status, 302);
            assert.equal(handoff.response.headers.get('location'), '/login.html');
            assert.equal(authCookie(jar), undefined, 'No session is issued before the second factor.');
            const pending = await request(`${baseUrl}/api/auth/2fa/challenge`, { jar });
            assert.deepEqual(pending.payload, { required: true }, 'The session holds a second-factor challenge.');
            assert.equal((await request(`${baseUrl}/api/auth/me`, { jar })).response.status, 401);

            // Wait for the next TOTP step so the code is not a replay of the enrolment code.
            await new Promise(resolve => setTimeout(resolve, 30500 - (Date.now() % 30000)));
            const wrong = await request(`${baseUrl}/api/auth/2fa/verify`, {
                method: 'POST', jar, body: { credentialType: 'totp', credential: '000000' }
            });
            assert.equal(wrong.response.status, 401);
            const verified = await request(`${baseUrl}/api/auth/2fa/verify`, {
                method: 'POST', jar, body: { credentialType: 'totp', credential: totp(totpSecret) }
            });
            assert.equal(verified.response.status, 200);
            assert.ok(authCookie(jar), 'The second factor completes the sign-in.');
            const me = await request(`${baseUrl}/api/auth/me`, { jar });
            assert.equal(me.payload.username, 'admin');

            // The same hand-off completed with a recovery code.
            const recovery = await beginSso(baseUrl, provider.issuer);
            const recoveryHandoff = await callback(baseUrl, recovery.jar, {
                code: provider.issueCode('subject-admin'), state: recovery.state
            });
            assert.equal(recoveryHandoff.response.headers.get('location'), '/login.html');
            const recovered = await request(`${baseUrl}/api/auth/2fa/verify`, {
                method: 'POST', jar: recovery.jar, body: { credentialType: 'recovery', credential: recoveryCode }
            });
            assert.equal(recovered.response.status, 200);

            // The administrator sign-in log records every step.
            const entries = await readLog(baseUrl, jar);
            const sso = entries.filter(entry => entry.method?.startsWith('sso'));
            const required = sso.filter(entry => entry.outcome === 'mfa_required');
            assert.equal(required.length, 2);
            [recoveryFlowId, totpFlowId] = required.map(entry => entry.flowId);
            assert.match(totpFlowId, /^[0-9a-f-]{36}$/);
            assert.notEqual(totpFlowId, recoveryFlowId);
            assert.deepEqual(
                entries.filter(entry => entry.flowId === totpFlowId)
                    .map(entry => [entry.outcome, entry.method, entry.reason, entry.username]).reverse(),
                [
                    ['mfa_required', 'sso', null, 'admin'],
                    ['failure', 'sso+totp', 'invalid_mfa_code', 'admin'],
                    ['success', 'sso+totp', null, 'admin']
                ]
            );
            assert.deepEqual(
                entries.filter(entry => entry.flowId === recoveryFlowId)
                    .map(entry => [entry.outcome, entry.method]).reverse(),
                [['mfa_required', 'sso'], ['success', 'sso+recovery_code']]
            );

            const viewerSuccess = sso.filter(entry => entry.outcome === 'success' && entry.method === 'sso');
            assert.equal(viewerSuccess.length, 1, 'Only the direct sign-in succeeds without a second factor.');
            assert.equal(viewerSuccess[0].username, 'viewer');
            assert.equal(viewerSuccess[0].reason, null);

            const failures = sso.filter(entry => entry.outcome === 'failure' && entry.method === 'sso');
            const reasons = failures.map(entry => entry.reason).sort();
            assert.deepEqual(reasons, [
                'server_error', 'server_error', 'server_error',
                'sso_failed', 'sso_failed', 'sso_failed', 'sso_failed', 'sso_failed',
                // The callback without a provider configuration (first server run).
                'sso_unavailable'
            ].sort(), `Unexpected failure reasons: ${reasons.join(', ')}`);

            // Provider secrets and codes never reach the log.
            const serialized = JSON.stringify(entries);
            for (const value of [CLIENT_SECRET, recoveryCode, ...provider.tokenRequests.map(item => item.code)]) {
                assert.equal(serialized.includes(value), false, 'The sign-in log must not contain secrets.');
            }
        }
    } finally {
        await stopServer(server?.child);
        await provider.close();
        await fs.rm(dataDirectory, { recursive: true, force: true }).catch(() => {});
    }
    console.log('OIDC callback tests passed.');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
