const crypto = require('node:crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const router = express.Router();
const db = require('../db');
const auth = require('../auth');
const authenticationConfig = require('../config/authentication');
const recoveryCodes = require('../services/recoveryCodes');
const passkeyService = require('../services/passkeyService');
const twoFactorAuth = require('../services/twoFactorAuth');
const { passwordIpLimiter } = require('../services/authRateLimiter');
const {
    createSecurityRequestLimiter,
    enforceLimiter,
    noStore,
    respondError,
    verifyExistingFactor,
    verifyPasswordReauthentication
} = require('./securityChecks');

const REGISTRATION_PURPOSE = 'registration';
const SIGN_IN_PURPOSE = 'passwordless-sign-in';

const limitCeremonyStarts = rateLimit({
    limit: 60,
    windowMs: 15 * 60 * 1000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many passkey requests. Try again shortly.' }
});

const limitSecurityRequests = createSecurityRequestLimiter();

router.use(noStore);

function requireLocalAccount(user, res) {
    if (!user) {
        res.status(404).json({ error: 'User not found' });
        return false;
    }
    if (!user.passwordHash) {
        res.status(400).json({ error: 'Passkeys are available for local accounts only.' });
        return false;
    }
    return true;
}

function signInIpKey(req) {
    return `passkey:${req.socket?.remoteAddress || 'unknown'}`;
}

/** Public: whether the login page should offer passkey sign-in. */
router.get('/availability', limitSecurityRequests, (req, res) => {
    const availability = passkeyService.publicAvailability();
    res.json({
        ...availability,
        available: availability.available && authenticationConfig.localAuthEnabled
    });
});

router.get('/', limitSecurityRequests, auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({
            ...passkeyService.publicAvailability(),
            accountType: user.passwordHash ? 'local' : 'sso',
            maxPasskeys: passkeyService.MAX_PASSKEYS_PER_USER,
            passkeys: passkeyService.userPasskeys(user).map(passkeyService.toPublicPasskey)
        });
    } catch {
        res.status(500).json({ error: 'Could not load passkeys.' });
    }
});

/**
 * Start adding a passkey. Requires the current password and, when the
 * account already has a second factor, one of those factors.
 */
router.post('/registration/options', limitSecurityRequests, auth.requireAuth, async (req, res) => {
    try {
        if (!passkeyService.isAvailable()) throw passkeyService.unavailableError();
        const user = await db.users.getById(req.user.id);
        if (!requireLocalAccount(user, res)) return;
        if (passkeyService.userPasskeys(user).length >= passkeyService.MAX_PASSKEYS_PER_USER) {
            return res.status(400).json({ error: `An account can have at most ${passkeyService.MAX_PASSKEYS_PER_USER} passkeys.` });
        }
        // The challenge is bound to the security state that was verified
        // below. If a factor is removed or reset meanwhile, the epoch changes
        // and the registration is refused instead of adopting the new state.
        const verifiedAuthEpoch = db.userSecurity.authEpoch(user);
        if (!await verifyPasswordReauthentication(req, res, user)) return;
        if (!await verifyExistingFactor(req, res, user)) return;

        const webauthnUserId = await db.users.ensureWebauthnUserId(
            user.id,
            () => crypto.randomBytes(32).toString('base64url')
        );
        const current = await db.users.getById(user.id);
        if (!current || db.userSecurity.authEpoch(current) !== verifiedAuthEpoch) {
            return res.status(409).json({ error: 'Account security changed. Start again.' });
        }
        const options = await passkeyService.registrationOptions(current, webauthnUserId);
        req.session.passkeyRegistrationChallengeId = passkeyService.issueChallenge(REGISTRATION_PURPOSE, options.challenge, {
            userId: current.id,
            authEpoch: verifiedAuthEpoch,
            webauthnUserId
        });
        res.json({
            options,
            firstSecondFactor: !twoFactorAuth.hasSecondFactor(current)
        });
    } catch (error) {
        respondError(res, error, 'Could not start adding a passkey.');
    }
});

router.post('/registration/verify', limitSecurityRequests, auth.requireAuth, async (req, res) => {
    try {
        const challengeId = req.session?.passkeyRegistrationChallengeId;
        if (req.session) delete req.session.passkeyRegistrationChallengeId;
        const pending = passkeyService.consumeChallenge(challengeId, REGISTRATION_PURPOSE);
        if (!pending || pending.userId !== req.user.id) {
            return res.status(400).json({ error: 'The passkey request expired. Start again.' });
        }

        const response = passkeyService.parseCredentialResponse(req.body.response, 'registration');
        const verified = response ? await passkeyService.verifyRegistration(response, pending.challenge) : null;
        if (!verified) return res.status(400).json({ error: 'The passkey could not be verified.' });

        const recovery = recoveryCodes.generateRecoveryCodes();
        const added = await db.users.addPasskey(req.user.id, {
            ...verified,
            name: passkeyService.normalizeName(req.body.name)
        }, {
            expectedAuthEpoch: pending.authEpoch,
            webauthnUserId: pending.webauthnUserId,
            recoveryCodeHashes: recovery.hashes,
            maxPasskeys: passkeyService.MAX_PASSKEYS_PER_USER
        });
        if (!added) return res.status(409).json({ error: 'Account security changed while adding the passkey. Start again.' });

        res.status(201).json({
            passkey: passkeyService.toPublicPasskey(added.passkey),
            recoveryCodes: added.recoveryCodesIssued ? recovery.codes : []
        });
    } catch (error) {
        if (error.code === 'PASSKEY_EXISTS') return res.status(409).json({ error: error.message });
        respondError(res, error, 'Could not add the passkey.');
    }
});

router.patch('/:credentialId', limitSecurityRequests, auth.requireAuth, async (req, res) => {
    try {
        const name = passkeyService.normalizeName(req.body.name, '');
        if (!name) return res.status(400).json({ error: 'Enter a name for the passkey.' });
        const renamed = await db.users.renamePasskey(req.user.id, req.params.credentialId, name);
        if (!renamed) return res.status(404).json({ error: 'Passkey not found.' });
        res.json({ passkey: passkeyService.toPublicPasskey(renamed) });
    } catch (error) {
        respondError(res, error, 'Could not rename the passkey.');
    }
});

router.delete('/:credentialId', limitSecurityRequests, auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);
        if (!requireLocalAccount(user, res)) return;
        if (!passkeyService.userPasskeys(user).some(passkey => passkey.id === req.params.credentialId)) {
            return res.status(404).json({ error: 'Passkey not found.' });
        }
        const verifiedAuthEpoch = db.userSecurity.authEpoch(user);
        if (!await verifyPasswordReauthentication(req, res, user)) return;
        if (!await verifyExistingFactor(req, res, user)) return;

        const removed = await db.users.removePasskey(user.id, req.params.credentialId, {
            expectedAuthEpoch: verifiedAuthEpoch
        });
        if (!removed) return res.status(404).json({ error: 'Passkey not found.' });
        passkeyService.revokeUserChallenges(user.id);
        res.json(removed);
    } catch (error) {
        respondError(res, error, 'Could not remove the passkey.');
    }
});

/**
 * Passwordless sign-in. Discoverable credentials with user verification
 * complete the sign-in on their own, without a password or other factor.
 */
router.post('/login/options', limitSecurityRequests, limitCeremonyStarts, async (req, res) => {
    try {
        if (!authenticationConfig.localAuthEnabled) {
            return res.status(403).json({ error: 'Local sign-in is disabled. Use single sign-on.' });
        }
        if (!enforceLimiter(res, passwordIpLimiter, signInIpKey(req))) return;
        const options = await passkeyService.authenticationOptions({ userVerification: 'required' });
        // Each sign-in attempt starts in a fresh session; an identifier that
        // existed before the attempt never carries the challenge.
        await new Promise((resolve, fail) => {
            req.session.regenerate(error => error ? fail(error) : resolve());
        });
        req.session.passkeySignInChallengeId = passkeyService.issueChallenge(SIGN_IN_PURPOSE, options.challenge);
        res.json({ options });
    } catch (error) {
        respondError(res, error, 'Could not start passkey sign-in.');
    }
});

router.post('/login/verify', limitSecurityRequests, async (req, res) => {
    const ipKey = signInIpKey(req);
    const reject = () => {
        passwordIpLimiter.recordFailure(ipKey);
        res.status(401).json({ error: 'The passkey could not be verified.' });
    };

    try {
        if (!authenticationConfig.localAuthEnabled) {
            return res.status(403).json({ error: 'Local sign-in is disabled. Use single sign-on.' });
        }
        if (!enforceLimiter(res, passwordIpLimiter, ipKey)) return;

        const challengeId = req.session?.passkeySignInChallengeId;
        if (req.session) delete req.session.passkeySignInChallengeId;
        const pending = passkeyService.consumeChallenge(challengeId, SIGN_IN_PURPOSE);
        if (!pending) return res.status(400).json({ error: 'The passkey request expired. Try again.' });

        const response = passkeyService.parseCredentialResponse(req.body.response, 'authentication');
        if (!response) return reject();
        const user = await db.users.getByPasskeyCredentialId(response.id);
        // The user handle returned by a discoverable credential must name the
        // same account that owns the credential.
        if (!user?.passwordHash || !user.webauthnUserId || response.response.userHandle !== user.webauthnUserId) {
            return reject();
        }

        const valid = await db.users.usePasskey(
            user.id,
            response.id,
            passkey => passkeyService.verifyAssertion(response, pending.challenge, passkey, { requireUserVerification: true })
        );
        if (!valid) return reject();

        passwordIpLimiter.reset(ipKey);
        // Start a fresh session after sign-in, as the two-factor flow does,
        // so a session identifier set before sign-in cannot be reused. This
        // also drops any pending two-factor challenge.
        await new Promise((resolve, fail) => {
            req.session.regenerate(error => error ? fail(error) : resolve());
        });
        const token = auth.generateToken(user);
        auth.setAuthCookie(req, res, token);
        res.json({ user: db.users.toPublic(user) });
    } catch (error) {
        respondError(res, error, 'Passkey sign-in failed.');
    }
});

module.exports = router;
