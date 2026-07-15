const db = require('../db');
const totpService = require('./totpService');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function hasEnabledTotp(user) {
    return Boolean(user?.totp?.enabled && user.totp.encryptedSecret);
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
        userId: user.id,
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

async function clearChallenge(req) {
    await regenerateSession(req);
}

async function verifyCredential(user, { type = 'totp', credential } = {}) {
    if (!hasEnabledTotp(user)) return false;

    if (type === 'recovery') {
        const matchingHash = totpService.findRecoveryCodeHash(user.totp.recoveryCodeHashes, credential);
        return matchingHash ? db.users.consumeRecoveryCode(user.id, matchingHash) : false;
    }

    const validation = totpService.validateToken(user.totp.encryptedSecret, user, credential);
    return validation ? db.users.consumeTotpStep(user.id, validation.step) : false;
}

module.exports = {
    CHALLENGE_TTL_MS,
    hasEnabledTotp,
    beginChallenge,
    getChallenge,
    clearChallenge,
    verifyCredential
};
