const auth = require('../auth');
const twoFactorAuth = require('../services/twoFactorAuth');
const {
    passwordIdentityLimiter,
    twoFactorLimiter
} = require('../services/authRateLimiter');

const REAUTH_PASSKEY_PURPOSE = 'reauthentication';

function noStore(req, res, next) {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('Referrer-Policy', 'no-referrer');
    next();
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
    const key = `reauth:${user.id}`;
    if (!enforceLimiter(res, passwordIdentityLimiter, key)) return false;
    if (!user.passwordHash || !await auth.verifyPassword(String(req.body.password || ''), user.passwordHash)) {
        passwordIdentityLimiter.recordFailure(key);
        res.status(401).json({ error: 'Password verification failed.' });
        return false;
    }
    passwordIdentityLimiter.reset(key);
    return true;
}

/**
 * Sensitive account changes require one of the account's current second
 * factors in addition to the password, whenever any second factor exists.
 * A passkey assertion must answer the challenge from /2fa/reauth/passkey-options.
 */
async function verifyExistingFactor(req, res, user) {
    if (!twoFactorAuth.hasSecondFactor(user)) return true;
    const key = `factor:${user.id}`;
    if (!enforceLimiter(res, twoFactorLimiter, key)) return false;

    let challengeId = null;
    if (req.body.credentialType === 'passkey' && req.session) {
        challengeId = req.session.passkeyReauthChallengeId || null;
        delete req.session.passkeyReauthChallengeId;
    }
    const valid = await twoFactorAuth.verifyCredential(user, {
        type: req.body.credentialType,
        credential: req.body.credential,
        challengeId,
        purpose: REAUTH_PASSKEY_PURPOSE
    });
    if (!valid) {
        twoFactorLimiter.recordFailure(key);
        res.status(401).json({ error: 'Two-factor verification failed.' });
        return false;
    }
    twoFactorLimiter.reset(key);
    return true;
}

module.exports = {
    REAUTH_PASSKEY_PURPOSE,
    enforceLimiter,
    noStore,
    respondError,
    verifyExistingFactor,
    verifyPasswordReauthentication
};
