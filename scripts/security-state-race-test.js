const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const OTPAuth = require('otpauth');
const { SoftwareAuthenticator } = require('../tests/fixtures/software-authenticator');

// Protected account changes verify the password and an existing factor, then
// save. A security change that lands between those two steps must void the
// request. These tests run the routes in-process so the competing change can
// be placed exactly in that window: just before the protected database write.

const ORIGIN = 'http://localhost:3999';

function configureEnvironment(dataDirectory) {
    Object.assign(process.env, {
        NODE_ENV: 'test',
        NODECAST_DATA_DIR: dataDirectory,
        NODECAST_DISABLE_BACKGROUND_JOBS: 'true',
        APP_ORIGIN: ORIGIN,
        JWT_SECRET: crypto.randomBytes(48).toString('hex'),
        SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
        TOTP_ENCRYPTION_KEY: crypto.randomBytes(48).toString('hex')
    });
}

function totp(secret, timestamp = Date.now()) {
    return new OTPAuth.TOTP({
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret)
    }).generate({ timestamp });
}

async function run() {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-security-state-'));
    configureEnvironment(dataDirectory);

    const express = require('express');
    const db = require('../server/db');
    const auth = require('../server/auth');

    // Signed-in user from a test header; the session lives in a plain map.
    auth.requireAuth = async (req, res, next) => {
        const user = await db.users.getById(Number(req.headers['x-test-user']));
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        req.user = user;
        next();
    };
    const sessions = new Map();
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        const id = req.headers['x-test-session'] || 'anonymous';
        if (!sessions.has(id)) sessions.set(id, {});
        req.session = sessions.get(id);
        req.session.regenerate = callback => {
            sessions.set(id, {});
            req.session = sessions.get(id);
            callback();
        };
        next();
    });
    app.use('/api/auth/2fa', require('../server/routes/totp'));
    app.use('/api/auth/passkeys', require('../server/routes/passkeys'));

    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    async function request(user, route, { method = 'POST', body = {} } = {}) {
        const response = await fetch(`${baseUrl}${route}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'x-test-user': String(user.id),
                'x-test-session': `session-${user.id}`
            },
            body: method === 'GET' ? undefined : JSON.stringify(body)
        });
        const text = await response.text();
        return { status: response.status, payload: text ? JSON.parse(text) : null };
    }

    // Run a competing change immediately before the next call of a protected
    // database write, after the route has finished verifying the request.
    function beforeNextWrite(name, change) {
        const original = db.users[name];
        db.users[name] = async (...args) => {
            db.users[name] = original;
            await change();
            return original.apply(db.users, args);
        };
    }

    async function current(user) {
        return db.users.getById(user.id);
    }

    async function createLocalUser(username, role) {
        const password = crypto.randomBytes(24).toString('base64url');
        const created = await db.users.create({ username, role, passwordHash: await auth.hashPassword(password) });
        return { ...created, password };
    }

    async function passkeyFactor(user, authenticator) {
        const options = await request(user, '/api/auth/2fa/reauth/passkey-options');
        assert.equal(options.status, 200, JSON.stringify(options.payload));
        return { credentialType: 'passkey', credential: authenticator.assert(options.payload.options) };
    }

    async function addPasskey(user, factor) {
        const authenticator = new SoftwareAuthenticator({ rpId: 'localhost', origin: ORIGIN, synced: true });
        const options = await request(user, '/api/auth/passkeys/registration/options', {
            body: { password: user.password, ...factor }
        });
        assert.equal(options.status, 200, JSON.stringify(options.payload));
        const verified = await request(user, '/api/auth/passkeys/registration/verify', {
            body: { response: authenticator.register(options.payload.options), name: 'Test' }
        });
        assert.equal(verified.status, 201, JSON.stringify(verified.payload));
        return authenticator;
    }

    // A second session removes a passkey, using the state it verified itself.
    async function removePasskeyElsewhere(user, authenticator) {
        const before = await current(user);
        await db.users.removePasskey(user.id, authenticator.id, {
            expectedAuthEpoch: db.userSecurity.authEpoch(before)
        });
    }

    try {
        const owner = await createLocalUser('Owner', 'admin');
        const passkeyA = await addPasskey(owner);
        const passkeyB = await addPasskey(owner, await passkeyFactor(owner, passkeyA));
        const passkeyC = await addPasskey(owner, await passkeyFactor(owner, passkeyB));

        // Authenticator-app enrollment authorized with passkey A. Passkey A is
        // removed before the enrollment is saved, while B and C stay enabled
        // and were never verified by this request.
        let factor = await passkeyFactor(owner, passkeyA);
        beforeNextWrite('setTotpPending', () => removePasskeyElsewhere(owner, passkeyA));
        const staleEnrollment = await request(owner, '/api/auth/2fa/enroll', { body: { password: owner.password, ...factor } });
        assert.equal(staleEnrollment.status, 409, 'Enrollment must not complete after the verified factor was removed.');
        assert.equal((await current(owner)).totpPending, undefined, 'No enrollment may be stored.');
        assert.equal(db.userSecurity.userPasskeys(await current(owner)).length, 2);

        // A pending enrollment cannot be confirmed after the security state
        // that authorized it has changed.
        const enrollment = await request(owner, '/api/auth/2fa/enroll', {
            body: { password: owner.password, ...await passkeyFactor(owner, passkeyB) }
        });
        assert.equal(enrollment.status, 200, JSON.stringify(enrollment.payload));
        await removePasskeyElsewhere(owner, passkeyC);
        const staleConfirmation = await request(owner, '/api/auth/2fa/confirm', {
            body: { code: totp(enrollment.payload.manualSecret) }
        });
        assert.equal(staleConfirmation.status, 409, 'Confirmation must not complete after the security state changed.');
        assert.equal(db.userSecurity.hasTotpFactor(await current(owner)), false);
        assert.equal((await current(owner)).totpPending, undefined, 'The voided enrollment is discarded.');

        // Re-adding a third passkey also changes the state that was verified.
        const passkeyD = await addPasskey(owner, await passkeyFactor(owner, passkeyB));
        factor = await passkeyFactor(owner, passkeyB);
        const authorizedEnrollment = await request(owner, '/api/auth/2fa/enroll', { body: { password: owner.password, ...factor } });
        assert.equal(authorizedEnrollment.status, 200);
        const confirmed = await request(owner, '/api/auth/2fa/confirm', {
            body: { code: totp(authorizedEnrollment.payload.manualSecret) }
        });
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.payload));
        assert.equal(db.userSecurity.hasTotpFactor(await current(owner)), true);

        // Regenerating recovery codes.
        const codesBefore = db.userSecurity.recoveryCodeHashes(await current(owner));
        factor = await passkeyFactor(owner, passkeyD);
        beforeNextWrite('replaceRecoveryCodes', () => removePasskeyElsewhere(owner, passkeyD));
        const staleCodes = await request(owner, '/api/auth/2fa/recovery-codes', { body: { password: owner.password, ...factor } });
        assert.equal(staleCodes.status, 409);
        assert.deepEqual(db.userSecurity.recoveryCodeHashes(await current(owner)), codesBefore, 'Recovery codes must be unchanged.');

        // Removing the authenticator app.
        const passkeyE = await addPasskey(owner, await passkeyFactor(owner, passkeyB));
        factor = await passkeyFactor(owner, passkeyE);
        beforeNextWrite('disableTotp', () => removePasskeyElsewhere(owner, passkeyE));
        const staleDisable = await request(owner, '/api/auth/2fa/disable', { body: { password: owner.password, ...factor } });
        assert.equal(staleDisable.status, 409);
        assert.equal(db.userSecurity.hasTotpFactor(await current(owner)), true, 'The authenticator app must stay enabled.');

        // Removing a passkey.
        const passkeyF = await addPasskey(owner, await passkeyFactor(owner, passkeyB));
        const passkeyG = await addPasskey(owner, await passkeyFactor(owner, passkeyB));
        factor = await passkeyFactor(owner, passkeyF);
        beforeNextWrite('removePasskey', () => removePasskeyElsewhere(owner, passkeyF));
        const staleRemoval = await request(owner, `/api/auth/passkeys/${passkeyG.id}`, {
            method: 'DELETE', body: { password: owner.password, ...factor }
        });
        assert.equal(staleRemoval.status, 409);
        assert.ok(db.userSecurity.userPasskeys(await current(owner)).some(passkey => passkey.id === passkeyG.id));

        // Adding a passkey: the registration is bound to the verified state.
        const passkeyH = new SoftwareAuthenticator({ rpId: 'localhost', origin: ORIGIN, synced: true });
        const registrationOptions = await request(owner, '/api/auth/passkeys/registration/options', {
            body: { password: owner.password, ...await passkeyFactor(owner, passkeyG) }
        });
        assert.equal(registrationOptions.status, 200);
        beforeNextWrite('addPasskey', () => removePasskeyElsewhere(owner, passkeyG));
        const staleRegistration = await request(owner, '/api/auth/passkeys/registration/verify', {
            body: { response: passkeyH.register(registrationOptions.payload.options), name: 'Late' }
        });
        assert.equal(staleRegistration.status, 409);
        assert.equal(db.userSecurity.userPasskeys(await current(owner)).some(passkey => passkey.id === passkeyH.id), false);

        // Administrator reset: the administrator's own verified state counts.
        const viewer = await createLocalUser('Viewer', 'viewer');
        await addPasskey(viewer);
        const passkeyI = await addPasskey(owner, await passkeyFactor(owner, passkeyB));
        factor = await passkeyFactor(owner, passkeyI);
        beforeNextWrite('resetSecondFactors', () => removePasskeyElsewhere(owner, passkeyI));
        const staleReset = await request(owner, `/api/auth/2fa/admin/${viewer.id}`, {
            method: 'DELETE', body: { password: owner.password, ...factor }
        });
        assert.equal(staleReset.status, 409);
        assert.equal(db.userSecurity.userPasskeys(await current(viewer)).length, 1, 'The viewer keeps their passkey.');

        const reset = await request(owner, `/api/auth/2fa/admin/${viewer.id}`, {
            method: 'DELETE', body: { password: owner.password, ...await passkeyFactor(owner, passkeyB) }
        });
        assert.equal(reset.status, 200, JSON.stringify(reset.payload));
        assert.equal(db.userSecurity.hasSecondFactor(await current(viewer)), false);

        // Every protected write refuses a call without a verified state.
        await assert.rejects(db.users.disableTotp(owner.id), TypeError);
        await assert.rejects(db.users.removePasskey(owner.id, passkeyB.id), TypeError);

        console.log('Security state race test passed.');
    } finally {
        await new Promise(resolve => server.close(resolve));
        await fs.rm(dataDirectory, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
