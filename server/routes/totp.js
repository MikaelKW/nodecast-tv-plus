const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../auth');
const totpService = require('../services/totpService');
const recoveryCodes = require('../services/recoveryCodes');
const passkeyService = require('../services/passkeyService');
const twoFactorAuth = require('../services/twoFactorAuth');
const { twoFactorLimiter } = require('../services/authRateLimiter');
const {
    REAUTH_PASSKEY_PURPOSE,
    enforceLimiter,
    noStore,
    respondError,
    verifyExistingFactor,
    verifyPasswordReauthentication
} = require('./securityChecks');

const SIGN_IN_PASSKEY_PURPOSE = 'sign-in-second-factor';

router.use(noStore);

async function pendingChallengeUser(req) {
    const challenge = twoFactorAuth.getChallenge(req);
    if (!challenge) return { challenge: null, user: null };
    const user = await db.users.getById(challenge.userId);
    return { challenge, user: twoFactorAuth.challengeMatchesUser(challenge, user) ? user : null };
}

router.get('/challenge', async (req, res) => {
    try {
        const { challenge, user } = await pendingChallengeUser(req);
        if (!challenge || !user) return res.json({ required: false, methods: [] });
        res.json({ required: true, methods: twoFactorAuth.availableMethods(user) });
    } catch {
        res.json({ required: false, methods: [] });
    }
});

/**
 * Passkey options for the second step of password sign-in. Only the
 * passkeys of the account that passed the password step are allowed.
 */
router.post('/passkey-options', async (req, res) => {
    try {
        const { challenge, user } = await pendingChallengeUser(req);
        if (!challenge) return res.status(401).json({ error: 'The two-factor challenge has expired. Sign in again.' });
        if (!user) {
            await twoFactorAuth.clearChallenge(req);
            return res.status(401).json({ error: 'The two-factor challenge is no longer valid.' });
        }
        if (!enforceLimiter(res, twoFactorLimiter, `login:${challenge.userId}:${challenge.challengeId}`)) return;
        if (!twoFactorAuth.availableMethods(user).includes('passkey')) {
            return res.status(400).json({ error: 'Passkeys cannot be used for this sign-in.' });
        }

        const options = await passkeyService.authenticationOptions({
            passkeys: passkeyService.userPasskeys(user),
            userVerification: 'preferred'
        });
        challenge.passkeyChallengeId = passkeyService.issueChallenge(SIGN_IN_PASSKEY_PURPOSE, options.challenge, {
            userId: user.id,
            authEpoch: challenge.authEpoch
        });
        res.json({ options });
    } catch (error) {
        respondError(res, error, 'Could not start passkey verification.');
    }
});

router.post('/verify', async (req, res) => {
    try {
        const challenge = twoFactorAuth.getChallenge(req);
        if (!challenge) return res.status(401).json({ error: 'The two-factor challenge has expired. Sign in again.' });

        const key = `login:${challenge.userId}:${challenge.challengeId}`;
        if (!enforceLimiter(res, twoFactorLimiter, key)) return;

        const user = await db.users.getById(challenge.userId);
        if (!twoFactorAuth.challengeMatchesUser(challenge, user)) {
            await twoFactorAuth.clearChallenge(req);
            return res.status(401).json({ error: 'The two-factor challenge is no longer valid.' });
        }

        const type = req.body.credentialType || 'totp';
        let valid = false;
        if (twoFactorAuth.availableMethods(user).includes(type)) {
            const challengeId = type === 'passkey' ? challenge.passkeyChallengeId : null;
            if (type === 'passkey') delete challenge.passkeyChallengeId;
            valid = await twoFactorAuth.verifyCredential(user, {
                type,
                credential: req.body.credential,
                challengeId,
                purpose: SIGN_IN_PASSKEY_PURPOSE
            });
        }
        if (!valid) {
            const state = twoFactorLimiter.recordFailure(key);
            if (!state.allowed) await twoFactorAuth.clearChallenge(req);
            return res.status(401).json({
                error: type === 'passkey' ? 'The passkey could not be verified.' : 'Invalid authentication code.'
            });
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
            secondFactorEnabled: twoFactorAuth.hasSecondFactor(user),
            passkeyCount: passkeyService.userPasskeys(user).length,
            enrollmentPending: Boolean(pending),
            recoveryCodesRemaining: twoFactorAuth.recoveryCodesRemaining(user),
            canEnroll: Boolean(user.passwordHash && totpService.isAvailable()),
            accountType: user.passwordHash ? 'local' : 'sso'
        });
    } catch {
        res.status(500).json({ error: 'Could not load two-factor status.' });
    }
});

/**
 * Passkey options used to confirm a sensitive account change. The resulting
 * assertion is submitted as credentialType "passkey" with that change.
 */
router.post('/reauth/passkey-options', auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!passkeyService.hasPasskeys(user)) return res.status(400).json({ error: 'This account has no passkeys.' });
        if (!enforceLimiter(res, twoFactorLimiter, `factor:${user.id}`)) return;

        const options = await passkeyService.authenticationOptions({
            passkeys: passkeyService.userPasskeys(user),
            userVerification: 'preferred'
        });
        req.session.passkeyReauthChallengeId = passkeyService.issueChallenge(REAUTH_PASSKEY_PURPOSE, options.challenge, {
            userId: user.id,
            authEpoch: db.userSecurity.authEpoch(user)
        });
        res.json({ options });
    } catch (error) {
        respondError(res, error, 'Could not start passkey verification.');
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

        const key = `enroll:${user.id}`;
        if (!enforceLimiter(res, twoFactorLimiter, key)) return;
        const validation = totpService.validateToken(pending.encryptedSecret, user, req.body.code);
        if (!validation) {
            twoFactorLimiter.recordFailure(key);
            return res.status(401).json({ error: 'Invalid authentication code.' });
        }

        // Recovery codes are shared by all second factors. They are issued
        // with the first factor and kept when another factor is added.
        const recovery = recoveryCodes.generateRecoveryCodes();
        const activated = await db.users.activateTotp(
            user.id,
            pending.enrollmentId,
            recovery.hashes,
            validation.step
        );
        if (!activated) return res.status(409).json({ error: 'The enrollment changed or expired. Start again.' });
        twoFactorLimiter.reset(key);
        res.json({ recoveryCodes: activated.recoveryCodesIssued ? recovery.codes : [] });
    } catch (error) {
        respondError(res, error, 'Could not enable two-factor authentication.');
    }
});

router.post('/recovery-codes', auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);
        if (!user || !twoFactorAuth.hasSecondFactor(user)) return res.status(400).json({ error: 'Two-factor authentication is not enabled.' });
        if (!await verifyPasswordReauthentication(req, res, user)) return;
        if (!await verifyExistingFactor(req, res, user)) return;
        const recovery = recoveryCodes.generateRecoveryCodes();
        if (!await db.users.replaceRecoveryCodes(user.id, recovery.hashes)) {
            return res.status(409).json({ error: 'Two-factor authentication changed. Reload and try again.' });
        }
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
        const result = await db.users.disableTotp(user.id);
        res.json({ success: true, secondFactorEnabled: Boolean(result?.secondFactorEnabled) });
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
        await db.users.resetSecondFactors(targetId);
        passkeyService.revokeUserChallenges(targetId);
        res.json({ success: true });
    } catch (error) {
        respondError(res, error, 'Could not reset two-factor authentication.');
    }
});

module.exports = router;
