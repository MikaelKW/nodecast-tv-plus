const db = require('../db');
const totpService = require('./totpService');
const recoveryCodes = require('./recoveryCodes');
const passkeyService = require('./passkeyService');
const crypto = require('node:crypto');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const { authEpoch, hasSecondFactor, hasTotpFactor: hasEnabledTotp, recoveryCodeHashes } = db.userSecurity;

function recoveryCodesRemaining(user) {
    return recoveryCodeHashes(user).length;
}

/**
 * The second-factor methods that can currently be used by this account.
 * A method disappears when its server configuration is missing, for example
 * TOTP without TOTP_ENCRYPTION_KEY or passkeys without a usable APP_ORIGIN.
 */
function availableMethods(user) {
    const methods = [];
    if (passkeyService.hasPasskeys(user) && passkeyService.isAvailable()) methods.push('passkey');
    if (hasEnabledTotp(user) && totpService.isAvailable()) methods.push('totp');
    if (hasSecondFactor(user) && recoveryCodes.canVerify(recoveryCodeHashes(user))) methods.push('recovery');
    return methods;
}

function regenerateSession(req) {
    return new Promise((resolve, reject) => {
        req.session.regenerate(error => error ? reject(error) : resolve());
    });
}

function saveSession(req) {
    return new Promise((resolve, reject) => {
        req.session.save(error => error ? reject(error) : resolve());
    });
}

async function beginChallenge(req, user) {
    await regenerateSession(req);
    req.session.twoFactorChallenge = {
        challengeId: crypto.randomBytes(24).toString('base64url'),
        userId: user.id,
        authEpoch: authEpoch(user),
        expiresAt: Date.now() + CHALLENGE_TTL_MS
    };
    await saveSession(req);
}

function getChallenge(req) {
    const challenge = req.session?.twoFactorChallenge;
    if (!challenge) return null;
    if (challenge.expiresAt <= Date.now()) {
        delete req.session.twoFactorChallenge;
        return null;
    }
    return challenge;
}

/** A challenge is void once the account's second factors were reset or removed. */
function challengeMatchesUser(challenge, user) {
    return Boolean(user && hasSecondFactor(user) && authEpoch(user) === (Number(challenge?.authEpoch) || 0));
}

// Regenerating replaces the session and everything stored in it, including
// a pending two-factor challenge.
async function clearChallenge(req) {
    await regenerateSession(req);
}

async function verifyPasskeyCredential(user, credential, challengeId, purpose) {
    const response = passkeyService.parseCredentialResponse(credential, 'authentication');
    const pending = passkeyService.consumeChallenge(challengeId, purpose);
    if (!response || !pending || pending.userId !== user.id || pending.authEpoch !== authEpoch(user)) return false;
    if (!passkeyService.isAvailable()) return false;

    return db.users.usePasskey(
        user.id,
        response.id,
        passkey => passkeyService.verifyAssertion(response, pending.challenge, passkey, { requireUserVerification: false }),
        { expectedAuthEpoch: pending.authEpoch }
    );
}

/**
 * Verify one second-factor credential. Passkey assertions are bound to a
 * single-use challenge that was issued for this user and purpose.
 */
async function verifyCredential(user, { type = 'totp', credential, challengeId = null, purpose = null } = {}) {
    if (!hasSecondFactor(user)) return false;

    if (type === 'recovery') {
        const matchingHash = recoveryCodes.findRecoveryCodeHash(recoveryCodeHashes(user), credential);
        return matchingHash ? db.users.consumeRecoveryCode(user.id, matchingHash) : false;
    }

    if (type === 'passkey') {
        return verifyPasskeyCredential(user, credential, challengeId, purpose);
    }

    if (type !== 'totp' || !hasEnabledTotp(user)) return false;
    const validation = totpService.validateToken(user.totp.encryptedSecret, user, credential);
    return validation ? db.users.consumeTotpStep(user.id, validation.step) : false;
}

module.exports = {
    CHALLENGE_TTL_MS,
    availableMethods,
    beginChallenge,
    challengeMatchesUser,
    clearChallenge,
    getChallenge,
    hasEnabledTotp,
    hasSecondFactor,
    recoveryCodesRemaining,
    verifyCredential
};
