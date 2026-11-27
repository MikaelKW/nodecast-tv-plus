const crypto = require('node:crypto');
const securityConfig = require('../config/security');

const RECOVERY_CODE_COUNT = 10;
// Codes contain 96 random bits, so an unkeyed digest is already infeasible to
// reverse. The prefix distinguishes these digests from the original keyed
// format, which stays valid for codes issued before passkeys were added.
const DIGEST_PREFIX = 'sha256:';
const DIGEST_CONTEXT = 'nodecast-tv-plus:recovery-code:v2:';

function normalizeRecoveryCode(code) {
    const raw = String(code || '').trim().toUpperCase();
    if (!/^[A-F0-9\s-]+$/.test(raw)) return '';
    const compact = raw.replace(/[\s-]/g, '');
    return compact.length === 24 ? compact : '';
}

function hasKeyedHashing() {
    return Boolean(securityConfig.totpEncryptionSecret);
}

function keyedHash(normalized) {
    // Matches the hashes created by the original TOTP implementation.
    const key = Buffer.from(crypto.hkdfSync(
        'sha256',
        Buffer.from(securityConfig.totpEncryptionSecret, 'utf8'),
        Buffer.from('nodecast-tv-plus-totp-v1', 'utf8'),
        Buffer.from('recovery-code-hashing', 'utf8'),
        32
    ));
    return crypto.createHmac('sha256', key).update(normalized, 'utf8').digest('base64url');
}

function digestHash(normalized) {
    return DIGEST_PREFIX + crypto.createHash('sha256')
        .update(DIGEST_CONTEXT + normalized, 'utf8')
        .digest('base64url');
}

// New codes never depend on TOTP_ENCRYPTION_KEY, so they keep working for
// passkey-only accounts and when authenticator-app MFA is not configured.
function hashRecoveryCode(code) {
    return digestHash(normalizeRecoveryCode(code));
}

function isDigestHash(stored) {
    return typeof stored === 'string' && stored.startsWith(DIGEST_PREFIX);
}

function canVerify(storedHashes) {
    return (storedHashes || []).some(stored => isDigestHash(stored) || hasKeyedHashing());
}

function safeEqual(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function findRecoveryCodeHash(storedHashes, code) {
    const normalized = normalizeRecoveryCode(code);
    if (!normalized) return null;
    const digest = digestHash(normalized);
    const keyed = hasKeyedHashing() ? keyedHash(normalized) : null;

    return (storedHashes || []).find(stored => {
        if (typeof stored !== 'string') return false;
        if (isDigestHash(stored)) return safeEqual(digest, stored);
        return keyed !== null && safeEqual(keyed, stored);
    }) || null;
}

function generateRecoveryCodes() {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
        const compact = crypto.randomBytes(12).toString('hex').toUpperCase();
        return compact.match(/.{1,6}/g).join('-');
    });

    return {
        codes,
        hashes: codes.map(hashRecoveryCode)
    };
}

module.exports = {
    RECOVERY_CODE_COUNT,
    canVerify,
    findRecoveryCodeHash,
    generateRecoveryCodes,
    hashRecoveryCode,
    normalizeRecoveryCode
};
