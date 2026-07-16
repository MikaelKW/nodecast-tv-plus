const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const OTPAuth = require('otpauth');
const { AttemptLimiter } = require('../server/services/authRateLimiter');

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

    has(name) {
        return this.cookies.has(name);
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

async function startServer(dataDirectory, secrets) {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let output = '';
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            NODECAST_DATA_DIR: dataDirectory,
            PORT: String(port),
            JWT_SECRET: secrets.jwt,
            SESSION_SECRET: secrets.session,
            TOTP_ENCRYPTION_KEY: secrets.totp,
            OIDC_ISSUER_URL: '',
            OIDC_CLIENT_ID: '',
            OIDC_CLIENT_SECRET: '',
            OIDC_AUTH_URL: '',
            OIDC_TOKEN_URL: '',
            OIDC_USERINFO_URL: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    await waitForServer(baseUrl, child);
    return { baseUrl, child, getOutput: () => output };
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

async function request(baseUrl, route, { method = 'GET', body, jar = new CookieJar() } = {}) {
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
    const payload = text ? JSON.parse(text) : null;
    return { response, payload, jar };
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

async function enroll(baseUrl, jar, password) {
    const started = await request(baseUrl, '/api/auth/2fa/enroll', {
        method: 'POST',
        jar,
        body: { password }
    });
    assert.equal(started.response.status, 200);
    assert.match(started.payload.manualSecret, /^[A-Z2-7]+$/);
    assert.match(started.payload.qrDataUrl, /^data:image\/png;base64,/);

    const code = totp(started.payload.manualSecret);
    const confirmed = await request(baseUrl, '/api/auth/2fa/confirm', {
        method: 'POST',
        jar,
        body: { code }
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.payload.recoveryCodes.length, 10);
    return {
        secret: started.payload.manualSecret,
        enrollmentCode: code,
        recoveryCodes: confirmed.payload.recoveryCodes
    };
}

async function beginPasswordLogin(baseUrl, username, password) {
    const jar = new CookieJar();
    const login = await request(baseUrl, '/api/auth/login', {
        method: 'POST',
        jar,
        body: { username, password }
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.payload.requiresTwoFactor, true);
    assert.equal(jar.has('nodecast_auth'), false, 'Password step must not issue the app authentication cookie.');
    assert.equal(jar.has('nodecast.sid'), true, 'The pending challenge must remain server-side behind the session cookie.');
    return jar;
}

async function verifyLogin(baseUrl, jar, credentialType, credential, expectedStatus = 200) {
    const result = await request(baseUrl, '/api/auth/2fa/verify', {
        method: 'POST',
        jar,
        body: { credentialType, credential }
    });
    assert.equal(result.response.status, expectedStatus);
    return result;
}

function testLimiter() {
    const limiter = new AttemptLimiter({ maxAttempts: 3, windowMs: 1000, blockMs: 2000 });
    assert.equal(limiter.check('key', 100).allowed, true);
    limiter.recordFailure('key', 100);
    limiter.recordFailure('key', 200);
    assert.equal(limiter.recordFailure('key', 300).allowed, false);
    assert.equal(limiter.check('key', 400).allowed, false);
    assert.equal(limiter.check('key', 2400).allowed, true);
}

async function run() {
    testLimiter();
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-totp-'));
    const secrets = {
        jwt: crypto.randomBytes(48).toString('hex'),
        session: crypto.randomBytes(48).toString('hex'),
        totp: crypto.randomBytes(48).toString('hex')
    };
    const admin = {
        username: 'SecurityAdmin',
        password: crypto.randomBytes(24).toString('base64url')
    };
    admin.passwordConfirmation = admin.password;
    let server;
    const sensitiveValues = [admin.password, ...Object.values(secrets)];

    try {
        server = await startServer(dataDirectory, secrets);
        const adminJar = new CookieJar();
        const setup = await request(server.baseUrl, '/api/auth/setup', {
            method: 'POST',
            jar: adminJar,
            body: admin
        });
        assert.equal(setup.response.status, 201);

        const statusBefore = await request(server.baseUrl, '/api/auth/2fa/status', { jar: adminJar });
        assert.deepEqual(
            { enabled: statusBefore.payload.enabled, canEnroll: statusBefore.payload.canEnroll },
            { enabled: false, canEnroll: true }
        );

        const enrollment = await enroll(server.baseUrl, adminJar, admin.password);
        sensitiveValues.push(enrollment.secret, enrollment.enrollmentCode, ...enrollment.recoveryCodes);

        const databaseText = await fs.readFile(path.join(dataDirectory, 'db.json'), 'utf8');
        assert.equal(databaseText.includes(enrollment.secret), false, 'The TOTP secret must not be stored in plaintext.');
        for (const code of enrollment.recoveryCodes) {
            assert.equal(databaseText.includes(code), false, 'Recovery codes must be stored only as hashes.');
        }
        const database = JSON.parse(databaseText);
        assert.equal(database.users[0].totp.encryptedSecret.version, 1);
        assert.equal(database.users[0].totp.recoveryCodeHashes.length, 10);

        const publicUsers = await request(server.baseUrl, '/api/auth/users', { jar: adminJar });
        assert.equal(publicUsers.response.status, 200);
        assert.equal(publicUsers.payload[0].twoFactorEnabled, true);
        assert.equal(JSON.stringify(publicUsers.payload).includes('encryptedSecret'), false);
        assert.equal(JSON.stringify(publicUsers.payload).includes('recoveryCodeHashes'), false);
        assert.equal(JSON.stringify(publicUsers.payload).includes('passwordHash'), false);

        const firstChallenge = await beginPasswordLogin(server.baseUrl, admin.username, admin.password);
        const nextStepCode = totp(enrollment.secret, Date.now() + 30_000);
        sensitiveValues.push(nextStepCode);
        const verified = await verifyLogin(server.baseUrl, firstChallenge, 'totp', nextStepCode);
        assert.equal(verified.jar.has('nodecast_auth'), true);

        const replayChallenge = await beginPasswordLogin(server.baseUrl, admin.username, admin.password);
        await verifyLogin(server.baseUrl, replayChallenge, 'totp', nextStepCode, 401);

        const recoveryChallenge = await beginPasswordLogin(server.baseUrl, admin.username, admin.password);
        const recovered = await verifyLogin(server.baseUrl, recoveryChallenge, 'recovery', enrollment.recoveryCodes[0]);
        assert.equal(recovered.jar.has('nodecast_auth'), true);

        const usedRecoveryChallenge = await beginPasswordLogin(server.baseUrl, admin.username, admin.password);
        await verifyLogin(server.baseUrl, usedRecoveryChallenge, 'recovery', enrollment.recoveryCodes[0], 401);

        const viewerPassword = crypto.randomBytes(24).toString('base64url');
        sensitiveValues.push(viewerPassword);
        const viewer = await request(server.baseUrl, '/api/auth/users', {
            method: 'POST',
            jar: recovered.jar,
            body: { username: 'SecurityViewer', password: viewerPassword, role: 'viewer' }
        });
        assert.equal(viewer.response.status, 201);

        const viewerJar = new CookieJar();
        const viewerLogin = await request(server.baseUrl, '/api/auth/login', {
            method: 'POST',
            jar: viewerJar,
            body: { username: 'SecurityViewer', password: viewerPassword }
        });
        assert.equal(viewerLogin.response.status, 200);
        const viewerEnrollment = await enroll(server.baseUrl, viewerJar, viewerPassword);
        sensitiveValues.push(viewerEnrollment.secret, viewerEnrollment.enrollmentCode, ...viewerEnrollment.recoveryCodes);

        const adminReset = await request(server.baseUrl, `/api/auth/2fa/admin/${viewer.payload.id}`, {
            method: 'DELETE',
            jar: recovered.jar,
            body: {
                password: admin.password,
                credentialType: 'recovery',
                credential: enrollment.recoveryCodes[1]
            }
        });
        assert.equal(adminReset.response.status, 200);

        const usersAfterReset = await request(server.baseUrl, '/api/auth/users', { jar: recovered.jar });
        const resetViewer = usersAfterReset.payload.find(user => user.id === viewer.payload.id);
        assert.equal(resetViewer.twoFactorEnabled, false);

        const regenerated = await request(server.baseUrl, '/api/auth/2fa/recovery-codes', {
            method: 'POST',
            jar: recovered.jar,
            body: {
                password: admin.password,
                credentialType: 'recovery',
                credential: enrollment.recoveryCodes[2]
            }
        });
        assert.equal(regenerated.response.status, 200);
        assert.equal(regenerated.payload.recoveryCodes.length, 10);
        sensitiveValues.push(...regenerated.payload.recoveryCodes);

        const staleRecoveryChallenge = await beginPasswordLogin(server.baseUrl, admin.username, admin.password);
        await verifyLogin(server.baseUrl, staleRecoveryChallenge, 'recovery', enrollment.recoveryCodes[3], 401);

        const disabled = await request(server.baseUrl, '/api/auth/2fa/disable', {
            method: 'POST',
            jar: recovered.jar,
            body: {
                password: admin.password,
                credentialType: 'recovery',
                credential: regenerated.payload.recoveryCodes[0]
            }
        });
        assert.equal(disabled.response.status, 200);
        const statusAfterDisable = await request(server.baseUrl, '/api/auth/2fa/status', { jar: recovered.jar });
        assert.equal(statusAfterDisable.payload.enabled, false);

        const directLogin = await request(server.baseUrl, '/api/auth/login', {
            method: 'POST',
            body: { username: admin.username, password: admin.password }
        });
        assert.equal(directLogin.response.status, 200);
        assert.equal(directLogin.payload.requiresTwoFactor, undefined);
        assert.equal(directLogin.jar.has('nodecast_auth'), true);

        const nonexistent = `missing-${crypto.randomBytes(8).toString('hex')}`;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const failed = await request(server.baseUrl, '/api/auth/login', {
                method: 'POST',
                body: { username: nonexistent, password: 'incorrect-password' }
            });
            assert.equal(failed.response.status, 401);
        }
        const limited = await request(server.baseUrl, '/api/auth/login', {
            method: 'POST',
            body: { username: nonexistent, password: 'incorrect-password' }
        });
        assert.equal(limited.response.status, 429);
        assert.ok(Number(limited.response.headers.get('retry-after')) > 0);

        await stopServer(server.child);
        const output = server.getOutput();
        for (const value of sensitiveValues) {
            assert.equal(output.includes(value), false, 'Authentication secrets and credentials must not appear in server logs.');
        }

        console.log('TOTP authentication security test passed.');
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
