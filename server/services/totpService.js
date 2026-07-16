const crypto = require('node:crypto');
const OTPAuth = require('otpauth');
const QRCode = require('qrcode');
const securityConfig = require('../config/security');

const ISSUER = 'NodeCast TV Plus';
const ALGORITHM = 'SHA1';
const DIGITS = 6;
const PERIOD = 30;
const RECOVERY_CODE_COUNT = 10;
const ENROLLMENT_TTL_MS = 10 * 60 * 1000;

function unavailableError() {
    const error = new Error('Two-factor authentication is not configured on this server.');
    error.code = 'TOTP_KEY_UNAVAILABLE';
    error.statusCode = 503;
    return error;
}

function deriveKey(info) {
    if (!securityConfig.totpEncryptionSecret) throw unavailableError();
    return Buffer.from(crypto.hkdfSync(
        'sha256',
        Buffer.from(securityConfig.totpEncryptionSecret, 'utf8'),
        Buffer.from('nodecast-tv-plus-totp-v1', 'utf8'),
        Buffer.from(info, 'utf8'),
        32
    ));
}

function associatedData(userId) {
    return Buffer.from(`nodecast-tv-plus:totp:user:${Number(userId)}:v1`, 'utf8');
}

function encryptSecret(secret, userId) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey('secret-encryption'), iv);
    cipher.setAAD(associatedData(userId));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
        version: 1,
        iv: iv.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        tag: tag.toString('base64url')
    };
}

function decryptSecret(record, userId) {
    if (!record || record.version !== 1 || !record.iv || !record.ciphertext || !record.tag) {
        throw new Error('Stored two-factor authentication data is invalid.');
    }

    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        deriveKey('secret-encryption'),
        Buffer.from(record.iv, 'base64url')
    );
    decipher.setAAD(associatedData(userId));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
    return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64url')),
        decipher.final()
    ]).toString('utf8');
}

function createTotp(secret, username) {
    return new OTPAuth.TOTP({
        issuer: ISSUER,
        label: username,
        algorithm: ALGORITHM,
        digits: DIGITS,
        period: PERIOD,
        secret: OTPAuth.Secret.fromBase32(secret)
    });
}

async function createEnrollment(user) {
    if (!isAvailable()) throw unavailableError();
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const totp = createTotp(secret, user.username);
    const uri = totp.toString();

    return {
        enrollmentId: crypto.randomBytes(24).toString('base64url'),
        encryptedSecret: encryptSecret(secret, user.id),
        expiresAt: Date.now() + ENROLLMENT_TTL_MS,
        manualSecret: secret,
        qrDataUrl: await QRCode.toDataURL(uri, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 256
        })
    };
}

function validateToken(encryptedSecret, user, token, timestamp = Date.now()) {
    if (!/^\d{6}$/.test(String(token || ''))) return null;
    const secret = decryptSecret(encryptedSecret, user.id);
    const delta = createTotp(secret, user.username).validate({
        token: String(token),
        timestamp,
        window: 1
    });
    if (delta === null) return null;

    return {
        delta,
        step: OTPAuth.TOTP.counter({ period: PERIOD, timestamp }) + delta
    };
}

function normalizeRecoveryCode(code) {
    const raw = String(code || '').trim().toUpperCase();
    if (!/^[A-F0-9\s-]+$/.test(raw)) return '';
    const compact = raw.replace(/[\s-]/g, '');
    return compact.length === 24 ? compact : '';
}

function hashRecoveryCode(code) {
    return crypto.createHmac('sha256', deriveKey('recovery-code-hashing'))
        .update(normalizeRecoveryCode(code), 'utf8')
        .digest('base64url');
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

function findRecoveryCodeHash(storedHashes, code) {
    const candidate = Buffer.from(hashRecoveryCode(code));
    return (storedHashes || []).find(stored => {
        const expected = Buffer.from(stored);
        return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
    }) || null;
}

function isAvailable() {
    return Boolean(securityConfig.totpEncryptionSecret);
}

module.exports = {
    ISSUER,
    ALGORITHM,
    DIGITS,
    PERIOD,
    ENROLLMENT_TTL_MS,
    isAvailable,
    createEnrollment,
    encryptSecret,
    decryptSecret,
    validateToken,
    generateRecoveryCodes,
    hashRecoveryCode,
    findRecoveryCodeHash,
    normalizeRecoveryCode,
    unavailableError
};
