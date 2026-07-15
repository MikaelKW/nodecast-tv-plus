const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../auth');
const totpService = require('../services/totpService');
const twoFactorAuth = require('../services/twoFactorAuth');
const {
    passwordIdentityLimiter,
    twoFactorLimiter
} = require('../services/authRateLimiter');

router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('Referrer-Policy', 'no-referrer');
    next();
});

function limiterKey(req, suffix) {
    return `${req.ip || req.socket?.remoteAddress || 'unknown'}:${suffix}`;
}

function enforceLimiter(res, limiter, key) {
    const state = limiter.check(key);
    if (state.allowed) return true;
    res.set('Retry-After', String(Math.max(1, Math.ceil(state.retryAfterMs / 1000))));
    res.status(429).json({ error: 'Too many authentication attempts. Try again later.' });
    return false;
}

function respondError(res, error, fallback) {
    const status = error.statusCode || 500;
    res.status(status).json({ error: status === 500 ? fallback : error.message });
}

async function verifyPasswordReauthentication(req, res, user) {
    const key = limiterKey(req, `reauth:${user.id}`);
    if (!enforceLimiter(res, passwordIdentityLimiter, key)) return false;
    if (!user.passwordHash || !await auth.verifyPassword(String(req.body.password || ''), user.passwordHash)) {
        passwordIdentityLimiter.recordFailure(key);
        res.status(401).json({ error: 'Password verification failed.' });
        return false;
    }
    passwordIdentityLimiter.reset(key);
    return true;
}

async function verifyExistingFactor(req, res, user) {
    if (!twoFactorAuth.hasEnabledTotp(user)) return true;
    const key = limiterKey(req, `factor:${user.id}`);
    if (!enforceLimiter(res, twoFactorLimiter, key)) return false;
    const valid = await twoFactorAuth.verifyCredential(user, {
        type: req.body.credentialType,
        credential: req.body.credential
    });
    if (!valid) {
        twoFactorLimiter.recordFailure(key);
        res.status(401).json({ error: 'Two-factor verification failed.' });
        return false;
    }
    twoFactorLimiter.reset(key);
    return true;
}

router.get('/challenge', (req, res) => {
    res.json({ required: Boolean(twoFactorAuth.getChallenge(req)) });
});

router.post('/verify', async (req, res) => {
    try {
        const challenge = twoFactorAuth.getChallenge(req);
        if (!challenge) return res.status(401).json({ error: 'The two-factor challenge has expired. Sign in again.' });

        const key = limiterKey(req, `login:${challenge.userId}`);
        if (!enforceLimiter(res, twoFactorLimiter, key)) return;

        const user = await db.users.getById(challenge.userId);
        if (!user || !twoFactorAuth.hasEnabledTotp(user)) {
            await twoFactorAuth.clearChallenge(req);
            return res.status(401).json({ error: 'The two-factor challenge is no longer valid.' });
        }

        const valid = await twoFactorAuth.verifyCredential(user, {
            type: req.body.credentialType,
            credential: req.body.credential
        });
        if (!valid) {
            const state = twoFactorLimiter.recordFailure(key);
            if (!state.allowed) await twoFactorAuth.clearChallenge(req);
            return res.status(401).json({ error: 'Invalid authentication code.' });
        }

        twoFactorLimiter.reset(key);
        await twoFactorAuth.clearChallenge(req);
        const token = auth.generateToken(user);
        auth.setAuthCookie(req, res, token);
        res.json({ user: db.users.toPublic(user) });
    } catch (error) {
        respondError(res, error, 'Two-factor verification failed.');
    }
});

router.get('/status', auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const pending = user.totpPending?.expiresAt > Date.now();
        res.json({
            enabled: twoFactorAuth.hasEnabledTotp(user),
            enrollmentPending: Boolean(pending),
            recoveryCodesRemaining: user.totp?.recoveryCodeHashes?.length || 0,
            canEnroll: Boolean(user.passwordHash && totpService.isAvailable()),
            accountType: user.passwordHash ? 'local' : 'sso'
        });
    } catch {
        res.status(500).json({ error: 'Could not load two-factor status.' });
    }
});

router.post('/enroll', auth.requireAuth, async (req, res) => {
    try {
        if (!totpService.isAvailable()) throw totpService.unavailableError();
        const user = await db.users.getById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!user.passwordHash) return res.status(400).json({ error: 'Two-factor enrollment is available for local accounts only.' });
        if (!await verifyPasswordReauthentication(req, res, user)) return;
        if (!await verifyExistingFactor(req, res, user)) return;

        const enrollment = await totpService.createEnrollment(user);
        await db.users.setTotpPending(user.id, enrollment);
        res.json({
            qrDataUrl: enrollment.qrDataUrl,
            manualSecret: enrollment.manualSecret,
            expiresAt: enrollment.expiresAt
        });
    } catch (error) {
        respondError(res, error, 'Could not start two-factor enrollment.');
    }
});

router.post('/confirm', auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);
        const pending = user?.totpPending;
        if (!pending || pending.expiresAt <= Date.now()) {
            if (pending) await db.users.clearTotpPending(user.id, pending.enrollmentId);
            return res.status(400).json({ error: 'The enrollment has expired. Start again.' });
        }

        const key = limiterKey(req, `enroll:${user.id}`);
        if (!enforceLimiter(res, twoFactorLimiter, key)) return;
        const validation = totpService.validateToken(pending.encryptedSecret, user, req.body.code);
        if (!validation) {
            twoFactorLimiter.recordFailure(key);
            return res.status(401).json({ error: 'Invalid authentication code.' });
        }

        const recovery = totpService.generateRecoveryCodes();
        const activated = await db.users.activateTotp(
            user.id,
            pending.enrollmentId,
            recovery.hashes,
            validation.step
        );
        if (!activated) return res.status(409).json({ error: 'The enrollment changed or expired. Start again.' });
        twoFactorLimiter.reset(key);
        res.json({ recoveryCodes: recovery.codes });
    } catch (error) {
        respondError(res, error, 'Could not enable two-factor authentication.');
    }
});

router.post('/recovery-codes', auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);
        if (!user || !twoFactorAuth.hasEnabledTotp(user)) return res.status(400).json({ error: 'Two-factor authentication is not enabled.' });
        if (!await verifyPasswordReauthentication(req, res, user)) return;
        if (!await verifyExistingFactor(req, res, user)) return;
        const recovery = totpService.generateRecoveryCodes();
        await db.users.replaceRecoveryCodes(user.id, recovery.hashes);
        res.json({ recoveryCodes: recovery.codes });
    } catch (error) {
        respondError(res, error, 'Could not regenerate recovery codes.');
    }
});

router.post('/disable', auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);
        if (!user || !twoFactorAuth.hasEnabledTotp(user)) return res.status(400).json({ error: 'Two-factor authentication is not enabled.' });
        if (!await verifyPasswordReauthentication(req, res, user)) return;
        if (!await verifyExistingFactor(req, res, user)) return;
        await db.users.disableTotp(user.id);
        res.json({ success: true });
    } catch (error) {
        respondError(res, error, 'Could not disable two-factor authentication.');
    }
});

router.delete('/admin/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const targetId = Number(req.params.id);
        if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'Invalid user ID.' });
        if (targetId === req.user.id) return res.status(400).json({ error: 'Use the account security page to disable your own two-factor authentication.' });

        const admin = await db.users.getById(req.user.id);
        if (!admin || !await verifyPasswordReauthentication(req, res, admin)) return;
        if (!await verifyExistingFactor(req, res, admin)) return;

        const target = await db.users.getById(targetId);
        if (!target) return res.status(404).json({ error: 'User not found' });
        await db.users.disableTotp(targetId);
        res.json({ success: true });
    } catch (error) {
        respondError(res, error, 'Could not reset two-factor authentication.');
    }
});

module.exports = router;
