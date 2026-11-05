const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const OTPAuth = require('otpauth');
const { SoftwareAuthenticator } = require('../tests/fixtures/software-authenticator');

const projectRoot = path.join(__dirname, '..');

class CookieJar {
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

    hasPrefix(prefix) {
        return [...this.cookies.keys()].some(name => name.startsWith(prefix));
    }
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

async function startServer(dataDirectory, secrets, { appOrigin = true } = {}) {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const origin = `http://localhost:${port}`;
    let output = '';
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            NODECAST_DATA_DIR: dataDirectory,
            NODECAST_DISABLE_BACKGROUND_JOBS: 'true',
            PORT: String(port),
            APP_ORIGIN: appOrigin ? origin : '',
            JWT_SECRET: secrets.jwt,
            SESSION_SECRET: secrets.session,
            TOTP_ENCRYPTION_KEY: secrets.totp,
            OIDC_ISSUER_URL: '',
            OIDC_CLIENT_ID: '',
            OIDC_CLIENT_SECRET: '',
            OIDC_AUTH_URL: '',
            OIDC_TOKEN_URL: '',
            OIDC_USERINFO_URL: '',
            DISABLE_LOCAL_AUTH: '',
            OIDC_AUTO_REDIRECT: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    await waitForServer(baseUrl, child);
    return { baseUrl, origin, child, getOutput: () => output };
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

function client(baseUrl) {
    return async function request(route, { method = 'GET', body, jar = new CookieJar() } = {}) {
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (jar.header()) headers.Cookie = jar.header();
        const response = await fetch(`${baseUrl}${route}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        jar.absorb(response);
        const text = await response.text();
        return { response, status: response.status, payload: text ? JSON.parse(text) : null, jar };
    };
}

function totp(secret, timestamp = Date.now()) {
    return new OTPAuth.TOTP({
        issuer: 'NodeCast TV Plus',
        label: 'test',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret)
    }).generate({ timestamp });
}

function legacyRecoveryHash(totpKey, code) {
    // The keyed format used before recovery codes became independent of TOTP.
    const key = Buffer.from(crypto.hkdfSync(
        'sha256',
        Buffer.from(totpKey, 'utf8'),
        Buffer.from('nodecast-tv-plus-totp-v1', 'utf8'),
        Buffer.from('recovery-code-hashing', 'utf8'),
        32
    ));
    return crypto.createHmac('sha256', key).update(code.replace(/-/g, ''), 'utf8').digest('base64url');
}

function testRelyingPartyConfiguration() {
    const { resolveRelyingParty } = require('../server/config/webauthn');
    assert.deepEqual(resolveRelyingParty('https://TV.Example.com/nodecast/'), {
        available: true,
        rpName: 'NodeCast TV Plus',
        rpID: 'tv.example.com',
        origin: 'https://tv.example.com'
    });
    assert.equal(resolveRelyingParty('https://tv.example.com:8443').origin, 'https://tv.example.com:8443');
    assert.equal(resolveRelyingParty('https://tv.example.com:8443').rpID, 'tv.example.com');
    assert.equal(resolveRelyingParty('http://localhost:3000').available, true);
    assert.equal(resolveRelyingParty('').reason, 'APP_ORIGIN_MISSING');
    assert.equal(resolveRelyingParty('not a url').reason, 'APP_ORIGIN_INVALID');
    assert.equal(resolveRelyingParty('http://tv.example.com').reason, 'HTTPS_REQUIRED');
    assert.equal(resolveRelyingParty('http://192.168.1.20:3000').reason, 'IP_ADDRESS_ORIGIN');
    assert.equal(resolveRelyingParty('https://192.168.1.20').reason, 'IP_ADDRESS_ORIGIN');
    assert.equal(resolveRelyingParty('https://[::1]').reason, 'IP_ADDRESS_ORIGIN');
}

async function run() {
    testRelyingPartyConfiguration();

    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-passkeys-'));
    const secrets = {
        jwt: crypto.randomBytes(48).toString('hex'),
        session: crypto.randomBytes(48).toString('hex'),
        totp: crypto.randomBytes(48).toString('hex')
    };
    const admin = { username: 'PasskeyAdmin', password: crypto.randomBytes(24).toString('base64url') };
    const sensitiveValues = [admin.password, ...Object.values(secrets)];
    const outputs = [];
    let server;

    try {
        server = await startServer(dataDirectory, secrets);
        let request = client(server.baseUrl);
        const rp = { rpId: 'localhost', origin: server.origin };

        const adminJar = new CookieJar();
        const setup = await request('/api/auth/setup', {
            method: 'POST',
            jar: adminJar,
            body: { ...admin, passwordConfirmation: admin.password }
        });
        assert.equal(setup.status, 201);

        const availability = await request('/api/auth/passkeys/availability');
        assert.deepEqual(availability.payload, { available: true, origin: server.origin, rpID: 'localhost' });

        // Adding a passkey requires the current password.
        const wrongPassword = await request('/api/auth/passkeys/registration/options', {
            method: 'POST', jar: adminJar, body: { password: 'incorrect-password' }
        });
        assert.equal(wrongPassword.status, 401);

        async function registrationOptions(jar, body) {
            const result = await request('/api/auth/passkeys/registration/options', { method: 'POST', jar, body });
            assert.equal(result.status, 200, JSON.stringify(result.payload));
            return result.payload;
        }

        async function registerPasskey(jar, authenticator, body, name, overrides = {}) {
            const { options } = await registrationOptions(jar, body);
            return request('/api/auth/passkeys/registration/verify', {
                method: 'POST',
                jar,
                body: { response: authenticator.register(options, overrides), name }
            });
        }

        const synced = new SoftwareAuthenticator({ ...rp, synced: true });
        const firstOptions = await registrationOptions(adminJar, { password: admin.password });
        assert.equal(firstOptions.firstSecondFactor, true);
        assert.equal(firstOptions.options.authenticatorSelection.residentKey, 'required');
        assert.equal(firstOptions.options.authenticatorSelection.userVerification, 'required');
        assert.equal(firstOptions.options.rp.id, 'localhost');
        assert.deepEqual(firstOptions.options.pubKeyCredParams.map(param => param.alg), [-8, -7, -257]);
        assert.equal(firstOptions.options.attestation, 'none');
        assert.match(firstOptions.options.user.id, /^[A-Za-z0-9_-]{43}$/, 'The WebAuthn user handle must be random.');
        assert.notEqual(firstOptions.options.user.id, Buffer.from(String(setup.payload.user.id)).toString('base64url'));

        // Responses for another origin or RP ID are rejected, and a consumed
        // registration challenge cannot be replayed.
        const wrongOrigin = await request('/api/auth/passkeys/registration/verify', {
            method: 'POST',
            jar: adminJar,
            body: { response: synced.register(firstOptions.options, { origin: 'https://attacker.example' }), name: 'x' }
        });
        assert.equal(wrongOrigin.status, 400);
        const wrongRpId = await registerPasskey(adminJar, synced, { password: admin.password }, 'x', { rpId: 'attacker.example' });
        assert.equal(wrongRpId.status, 400);
        const noUserVerification = await registerPasskey(adminJar, synced, { password: admin.password }, 'x', { userVerified: false });
        assert.equal(noUserVerification.status, 400);

        const replayOptions = await registrationOptions(adminJar, { password: admin.password });
        const registrationResponse = synced.register(replayOptions.options);
        const registered = await request('/api/auth/passkeys/registration/verify', {
            method: 'POST', jar: adminJar, body: { response: registrationResponse, name: '  Laptop\u0007 passkey  ' }
        });
        assert.equal(registered.status, 201, JSON.stringify(registered.payload));
        assert.equal(registered.payload.passkey.name, 'Laptop passkey');
        assert.equal(registered.payload.passkey.backedUp, true);
        assert.equal(registered.payload.passkey.deviceType, 'multiDevice');
        assert.equal(registered.payload.recoveryCodes.length, 10, 'The first second factor issues recovery codes.');
        const adminRecoveryCodes = registered.payload.recoveryCodes;
        sensitiveValues.push(...adminRecoveryCodes);
        const replayedRegistration = await request('/api/auth/passkeys/registration/verify', {
            method: 'POST', jar: adminJar, body: { response: registrationResponse, name: 'Replay' }
        });
        assert.equal(replayedRegistration.status, 400);

        // Further changes require an existing factor; a passkey can provide it.
        const missingFactor = await request('/api/auth/passkeys/registration/options', {
            method: 'POST', jar: adminJar, body: { password: admin.password }
        });
        assert.equal(missingFactor.status, 401);

        async function passkeyFactor(jar, authenticator, overrides) {
            const options = await request('/api/auth/2fa/reauth/passkey-options', { method: 'POST', jar, body: {} });
            assert.equal(options.status, 200, JSON.stringify(options.payload));
            return { credentialType: 'passkey', credential: authenticator.assert(options.payload.options, overrides) };
        }

        const duplicate = await registerPasskey(adminJar, synced, {
            password: admin.password, ...await passkeyFactor(adminJar, synced)
        }, 'Duplicate');
        assert.equal(duplicate.status, 409, 'A credential ID can be registered only once.');

        const deviceBound = new SoftwareAuthenticator({ ...rp, initialCounter: 10 });
        const secondPasskey = await registerPasskey(adminJar, deviceBound, {
            password: admin.password, ...await passkeyFactor(adminJar, synced)
        }, 'Security key');
        assert.equal(secondPasskey.status, 201);
        assert.equal(secondPasskey.payload.passkey.backedUp, false);
        assert.deepEqual(secondPasskey.payload.recoveryCodes, [], 'Existing recovery codes are kept.');

        const publicUsers = await request('/api/auth/users', { jar: adminJar });
        assert.equal(publicUsers.payload[0].twoFactorEnabled, true);
        assert.equal(publicUsers.payload[0].passkeyCount, 2);
        assert.equal(publicUsers.payload[0].totpEnabled, false);
        assert.equal(JSON.stringify(publicUsers.payload).includes('publicKey'), false);
        assert.equal(JSON.stringify(publicUsers.payload).includes('webauthnUserId'), false);

        // Password sign-in now requires a second factor.
        async function beginPasswordLogin(username, password) {
            const jar = new CookieJar();
            const login = await request('/api/auth/login', { method: 'POST', jar, body: { username, password } });
            assert.equal(login.status, 200);
            assert.equal(login.payload.requiresTwoFactor, true);
            assert.equal(jar.hasPrefix('nodecast_auth_'), false);
            return { jar, methods: login.payload.methods };
        }

        const passwordLogin = await beginPasswordLogin(admin.username, admin.password);
        assert.deepEqual(passwordLogin.methods, ['passkey', 'recovery']);
        const challengeStatus = await request('/api/auth/2fa/challenge', { jar: passwordLogin.jar });
        assert.deepEqual(challengeStatus.payload, { required: true, methods: ['passkey', 'recovery'] });
        const secondFactorOptions = await request('/api/auth/2fa/passkey-options', {
            method: 'POST', jar: passwordLogin.jar, body: {}
        });
        assert.equal(secondFactorOptions.status, 200);
        assert.deepEqual(
            secondFactorOptions.payload.options.allowCredentials.map(item => item.id).sort(),
            [synced.id, deviceBound.id].sort()
        );
        const secondFactorAssertion = synced.assert(secondFactorOptions.payload.options);
        const secondFactor = await request('/api/auth/2fa/verify', {
            method: 'POST',
            jar: passwordLogin.jar,
            body: { credentialType: 'passkey', credential: secondFactorAssertion }
        });
        assert.equal(secondFactor.status, 200);
        assert.equal(secondFactor.jar.hasPrefix('nodecast_auth_'), true);

        const replayLogin = await beginPasswordLogin(admin.username, admin.password);
        await request('/api/auth/2fa/passkey-options', { method: 'POST', jar: replayLogin.jar, body: {} });
        const replayedAssertion = await request('/api/auth/2fa/verify', {
            method: 'POST',
            jar: replayLogin.jar,
            body: { credentialType: 'passkey', credential: secondFactorAssertion }
        });
        assert.equal(replayedAssertion.status, 401, 'An assertion for an earlier challenge must be rejected.');

        // Passwordless sign-in uses discoverable credentials and requires user verification.
        async function passwordlessOptions() {
            const jar = new CookieJar();
            const options = await request('/api/auth/passkeys/login/options', { method: 'POST', jar, body: {} });
            assert.equal(options.status, 200);
            return { jar, options: options.payload.options };
        }

        async function passwordless(authenticator, overrides) {
            const { jar, options } = await passwordlessOptions();
            const response = authenticator.assert(options, overrides);
            const result = await request('/api/auth/passkeys/login/verify', { method: 'POST', jar, body: { response } });
            return { ...result, assertion: response };
        }

        const discoverable = await passwordlessOptions();
        assert.equal(discoverable.options.userVerification, 'required');
        assert.equal(discoverable.options.allowCredentials, undefined);

        const signedIn = await passwordless(synced);
        assert.equal(signedIn.status, 200);
        assert.equal(signedIn.payload.user.username, admin.username);
        assert.equal(signedIn.jar.hasPrefix('nodecast_auth_'), true);
        const me = await request('/api/auth/me', { jar: signedIn.jar });
        assert.equal(me.status, 200);
        assert.equal((await passwordless(synced)).status, 200, 'Synced passkeys that always report zero remain valid.');
        assert.equal((await passwordless(synced, { userVerified: false })).status, 401);
        assert.equal((await passwordless(synced, { userHandle: crypto.randomBytes(32).toString('base64url') })).status, 401);
        assert.equal((await passwordless(synced, { origin: 'https://attacker.example' })).status, 401);
        const replayedPasswordless = await request('/api/auth/passkeys/login/verify', {
            method: 'POST', jar: signedIn.jar, body: { response: signedIn.assertion }
        });
        assert.equal(replayedPasswordless.status, 400);

        // Authenticators that report a counter must keep increasing it.
        assert.equal((await passwordless(deviceBound)).status, 200);
        assert.equal((await passwordless(deviceBound, { counter: 5 })).status, 401, 'Counter regressions are rejected.');
        assert.equal((await passwordless(deviceBound, { counter: 50 })).status, 200);

        const listed = await request('/api/auth/passkeys', { jar: adminJar });
        assert.equal(listed.payload.passkeys.length, 2);
        assert.ok(listed.payload.passkeys.every(passkey => passkey.lastUsedAt));

        // Renaming needs no re-authentication but validates the name.
        const renamed = await request(`/api/auth/passkeys/${synced.id}`, {
            method: 'PATCH', jar: adminJar, body: { name: 'Phone' }
        });
        assert.equal(renamed.payload.passkey.name, 'Phone');
        const emptyName = await request(`/api/auth/passkeys/${synced.id}`, {
            method: 'PATCH', jar: adminJar, body: { name: '   ' }
        });
        assert.equal(emptyName.status, 400);

        // Adding TOTP keeps the shared recovery codes, and disabling it keeps
        // them while passkeys remain.
        const enrollment = await request('/api/auth/2fa/enroll', {
            method: 'POST', jar: adminJar, body: { password: admin.password, ...await passkeyFactor(adminJar, synced) }
        });
        assert.equal(enrollment.status, 200);
        sensitiveValues.push(enrollment.payload.manualSecret);
        const confirmed = await request('/api/auth/2fa/confirm', {
            method: 'POST', jar: adminJar, body: { code: totp(enrollment.payload.manualSecret) }
        });
        assert.equal(confirmed.status, 200);
        assert.deepEqual(confirmed.payload.recoveryCodes, []);
        const withTotp = await beginPasswordLogin(admin.username, admin.password);
        assert.deepEqual(withTotp.methods, ['passkey', 'totp', 'recovery']);

        const disabledTotp = await request('/api/auth/2fa/disable', {
            method: 'POST', jar: adminJar, body: { password: admin.password, ...await passkeyFactor(adminJar, synced) }
        });
        assert.equal(disabledTotp.status, 200);
        assert.equal(disabledTotp.payload.secondFactorEnabled, true);
        let status = await request('/api/auth/2fa/status', { jar: adminJar });
        assert.equal(status.payload.enabled, false);
        assert.equal(status.payload.secondFactorEnabled, true);
        assert.equal(status.payload.recoveryCodesRemaining, 10);

        // Recovery codes work for passkey-only accounts, and concurrent use of
        // one code succeeds only once.
        const firstRace = await beginPasswordLogin(admin.username, admin.password);
        const secondRace = await beginPasswordLogin(admin.username, admin.password);
        const race = await Promise.all([firstRace, secondRace].map(login => request('/api/auth/2fa/verify', {
            method: 'POST', jar: login.jar, body: { credentialType: 'recovery', credential: adminRecoveryCodes[0] }
        })));
        assert.deepEqual(race.map(result => result.status).sort(), [200, 401]);

        // A viewer with a pending sign-in loses it when an administrator resets
        // the account's second factors.
        const viewerPassword = crypto.randomBytes(24).toString('base64url');
        sensitiveValues.push(viewerPassword);
        const viewer = await request('/api/auth/users', {
            method: 'POST',
            jar: adminJar,
            body: { username: 'PasskeyViewer', password: viewerPassword, passwordConfirmation: viewerPassword, role: 'viewer' }
        });
        assert.equal(viewer.status, 201);
        const viewerJar = new CookieJar();
        assert.equal((await request('/api/auth/login', {
            method: 'POST', jar: viewerJar, body: { username: 'PasskeyViewer', password: viewerPassword }
        })).status, 200);
        const viewerKey = new SoftwareAuthenticator({ ...rp, synced: true });
        const viewerRegistered = await registerPasskey(viewerJar, viewerKey, { password: viewerPassword }, 'Viewer phone');
        assert.equal(viewerRegistered.status, 201);
        sensitiveValues.push(...viewerRegistered.payload.recoveryCodes);

        const pendingViewer = await beginPasswordLogin('PasskeyViewer', viewerPassword);
        const pendingOptions = await request('/api/auth/2fa/passkey-options', {
            method: 'POST', jar: pendingViewer.jar, body: {}
        });
        assert.equal(pendingOptions.status, 200);
        const reset = await request(`/api/auth/2fa/admin/${viewer.payload.id}`, {
            method: 'DELETE',
            jar: adminJar,
            body: { password: admin.password, ...await passkeyFactor(adminJar, synced) }
        });
        assert.equal(reset.status, 200);
        const afterReset = await request('/api/auth/2fa/verify', {
            method: 'POST',
            jar: pendingViewer.jar,
            body: { credentialType: 'passkey', credential: viewerKey.assert(pendingOptions.payload.options) }
        });
        assert.equal(afterReset.status, 401, 'The reset invalidates outstanding challenges.');
        assert.equal((await passwordless(viewerKey)).status, 401, 'The reset removes the passkeys.');
        const resetViewer = (await request('/api/auth/users', { jar: adminJar })).payload
            .find(user => user.id === viewer.payload.id);
        assert.equal(resetViewer.twoFactorEnabled, false);
        assert.equal(resetViewer.passkeyCount, 0);
        const viewerDirect = await request('/api/auth/login', {
            method: 'POST', body: { username: 'PasskeyViewer', password: viewerPassword }
        });
        assert.equal(viewerDirect.payload.requiresTwoFactor, undefined);

        // A second viewer keeps a passkey to check the fallback when passkeys
        // become unavailable on the server.
        const fallbackPassword = crypto.randomBytes(24).toString('base64url');
        sensitiveValues.push(fallbackPassword);
        assert.equal((await request('/api/auth/users', {
            method: 'POST',
            jar: adminJar,
            body: { username: 'FallbackViewer', password: fallbackPassword, passwordConfirmation: fallbackPassword, role: 'viewer' }
        })).status, 201);
        const fallbackJar = new CookieJar();
        await request('/api/auth/login', {
            method: 'POST', jar: fallbackJar, body: { username: 'FallbackViewer', password: fallbackPassword }
        });
        const fallbackRegistered = await registerPasskey(
            fallbackJar, new SoftwareAuthenticator({ ...rp, synced: true }), { password: fallbackPassword }, 'Phone'
        );
        assert.equal(fallbackRegistered.status, 201);
        const fallbackRecoveryCodes = fallbackRegistered.payload.recoveryCodes;
        sensitiveValues.push(...fallbackRecoveryCodes);

        // Removing the last passkey leaves TOTP enabled when it is configured.
        const totpViewerPassword = crypto.randomBytes(24).toString('base64url');
        sensitiveValues.push(totpViewerPassword);
        assert.equal((await request('/api/auth/users', {
            method: 'POST',
            jar: adminJar,
            body: { username: 'TotpViewer', password: totpViewerPassword, passwordConfirmation: totpViewerPassword, role: 'viewer' }
        })).status, 201);
        const totpViewerJar = new CookieJar();
        await request('/api/auth/login', {
            method: 'POST', jar: totpViewerJar, body: { username: 'TotpViewer', password: totpViewerPassword }
        });
        const totpViewerEnrollment = await request('/api/auth/2fa/enroll', {
            method: 'POST', jar: totpViewerJar, body: { password: totpViewerPassword }
        });
        const totpViewerSecret = totpViewerEnrollment.payload.manualSecret;
        sensitiveValues.push(totpViewerSecret);
        const totpViewerConfirmed = await request('/api/auth/2fa/confirm', {
            method: 'POST', jar: totpViewerJar, body: { code: totp(totpViewerSecret) }
        });
        assert.equal(totpViewerConfirmed.payload.recoveryCodes.length, 10);
        sensitiveValues.push(...totpViewerConfirmed.payload.recoveryCodes);
        const totpViewerKey = new SoftwareAuthenticator({ ...rp, synced: true });
        const totpViewerPasskey = await registerPasskey(totpViewerJar, totpViewerKey, {
            password: totpViewerPassword, credentialType: 'totp', credential: totp(totpViewerSecret, Date.now() + 30_000)
        }, 'Phone');
        assert.equal(totpViewerPasskey.status, 201);
        assert.deepEqual(totpViewerPasskey.payload.recoveryCodes, []);
        const removedLast = await request(`/api/auth/passkeys/${totpViewerKey.id}`, {
            method: 'DELETE',
            jar: totpViewerJar,
            body: { password: totpViewerPassword, ...await passkeyFactor(totpViewerJar, totpViewerKey) }
        });
        assert.equal(removedLast.status, 200);
        assert.deepEqual(removedLast.payload, { remainingPasskeys: 0, totpEnabled: true, secondFactorEnabled: true });
        status = await request('/api/auth/2fa/status', { jar: totpViewerJar });
        assert.equal(status.payload.recoveryCodesRemaining, 10);

        // Removing the admin's passkeys ends two-factor sign-in and the codes.
        const removedOne = await request(`/api/auth/passkeys/${deviceBound.id}`, {
            method: 'DELETE', jar: adminJar, body: { password: admin.password, ...await passkeyFactor(adminJar, synced) }
        });
        assert.deepEqual(removedOne.payload, { remainingPasskeys: 1, totpEnabled: false, secondFactorEnabled: true });
        const removedAll = await request(`/api/auth/passkeys/${synced.id}`, {
            method: 'DELETE',
            jar: adminJar,
            body: { password: admin.password, credentialType: 'recovery', credential: adminRecoveryCodes[1] }
        });
        assert.deepEqual(removedAll.payload, { remainingPasskeys: 0, totpEnabled: false, secondFactorEnabled: false });
        status = await request('/api/auth/2fa/status', { jar: adminJar });
        assert.equal(status.payload.recoveryCodesRemaining, 0);
        const adminDirect = await request('/api/auth/login', {
            method: 'POST', body: { username: admin.username, password: admin.password }
        });
        assert.equal(adminDirect.payload.requiresTwoFactor, undefined);

        let database = JSON.parse(await fs.readFile(path.join(dataDirectory, 'db.json'), 'utf8'));
        assert.equal(database.users.find(user => user.username === admin.username).recoveryCodes, undefined);
        const databaseText = JSON.stringify(database);
        for (const code of [...adminRecoveryCodes, ...fallbackRecoveryCodes]) {
            assert.equal(databaseText.includes(code), false, 'Recovery codes are stored only as hashes.');
        }

        await stopServer(server.child);
        outputs.push(server.getOutput());

        // Recovery codes created before this change were stored inside the
        // TOTP record. They must keep working after an upgrade.
        const legacyCodes = ['A1B2C3-D4E5F6-A7B8C9-D0E1F2', 'ABCDEF-012345-6789AB-CDEF01'];
        sensitiveValues.push(...legacyCodes);
        const totpViewer = database.users.find(user => user.username === 'TotpViewer');
        delete totpViewer.recoveryCodes;
        totpViewer.totp.recoveryCodeHashes = legacyCodes.map(code => legacyRecoveryHash(secrets.totp, code));
        await fs.writeFile(path.join(dataDirectory, 'db.json'), JSON.stringify(database, null, 2));

        server = await startServer(dataDirectory, secrets);
        request = client(server.baseUrl);
        const legacyLogin = await beginPasswordLogin('TotpViewer', totpViewerPassword);
        assert.deepEqual(legacyLogin.methods, ['totp', 'recovery']);
        const legacyVerified = await request('/api/auth/2fa/verify', {
            method: 'POST', jar: legacyLogin.jar, body: { credentialType: 'recovery', credential: legacyCodes[0] }
        });
        assert.equal(legacyVerified.status, 200);
        database = JSON.parse(await fs.readFile(path.join(dataDirectory, 'db.json'), 'utf8'));
        const migrated = database.users.find(user => user.username === 'TotpViewer');
        assert.equal(Object.hasOwn(migrated.totp, 'recoveryCodeHashes'), false);
        assert.equal(migrated.recoveryCodes.hashes.length, 1);

        // Failed passwordless attempts are rate limited per client address.
        let limited = null;
        for (let attempt = 0; attempt < 30 && !limited; attempt += 1) {
            const jar = new CookieJar();
            const options = await request('/api/auth/passkeys/login/options', { method: 'POST', jar, body: {} });
            if (options.status === 429) {
                limited = options;
                break;
            }
            const failed = await request('/api/auth/passkeys/login/verify', {
                method: 'POST', jar, body: { response: new SoftwareAuthenticator(rp).assert(options.payload.options) }
            });
            if (failed.status === 429) limited = failed;
            else assert.equal(failed.status, 401);
        }
        assert.ok(limited, 'Repeated passkey failures must be rate limited.');
        assert.ok(Number(limited.response.headers.get('retry-after')) > 0);

        await stopServer(server.child);
        outputs.push(server.getOutput());

        // Without a usable APP_ORIGIN, passkeys are unavailable and password
        // sign-in falls back to the account's other methods.
        server = await startServer(dataDirectory, secrets, { appOrigin: false });
        request = client(server.baseUrl);
        const unavailable = await request('/api/auth/passkeys/availability');
        assert.equal(unavailable.payload.available, false);
        assert.equal(unavailable.payload.reason, 'APP_ORIGIN_MISSING');
        const fallbackLogin = await beginPasswordLogin('FallbackViewer', fallbackPassword);
        assert.deepEqual(fallbackLogin.methods, ['recovery']);
        const fallbackVerified = await request('/api/auth/2fa/verify', {
            method: 'POST', jar: fallbackLogin.jar, body: { credentialType: 'recovery', credential: fallbackRecoveryCodes[0] }
        });
        assert.equal(fallbackVerified.status, 200);
        const unavailableOptions = await request('/api/auth/passkeys/registration/options', {
            method: 'POST', jar: fallbackVerified.jar, body: { password: fallbackPassword }
        });
        assert.equal(unavailableOptions.status, 503);
        assert.equal((await request('/api/auth/passkeys/login/options', { method: 'POST', body: {} })).status, 503);

        await stopServer(server.child);
        outputs.push(server.getOutput());
        for (const output of outputs) {
            assert.equal(output.includes('ExperimentalWarning'), false, 'Passkey verification must not use experimental runtime APIs.');
            for (const value of sensitiveValues) {
                assert.equal(output.includes(value), false, 'Authentication secrets and credentials must not appear in server logs.');
            }
        }

        console.log('Passkey authentication security test passed.');
    } catch (error) {
        if (server) console.error(server.getOutput());
        throw error;
    } finally {
        if (server) await stopServer(server.child);
        await fs.rm(dataDirectory, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
