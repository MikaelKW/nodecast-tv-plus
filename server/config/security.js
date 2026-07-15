const crypto = require('crypto');

const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_PATTERN = /(change|replace|example|placeholder|keyboard cat)/i;

function loadSecret(name) {
    const value = process.env[name]?.trim();
    const isProduction = process.env.NODE_ENV === 'production';

    if (value && value.length >= MIN_SECRET_LENGTH && !PLACEHOLDER_PATTERN.test(value)) {
        return value;
    }

    if (isProduction) {
        throw new Error(
            `${name} must be set to a unique value of at least ${MIN_SECRET_LENGTH} characters in production.`
        );
    }

    console.warn(`[Security] ${name} is not configured; using an ephemeral development-only secret.`);
    return crypto.randomBytes(48).toString('hex');
}

function loadOptionalSecret(name) {
    const value = process.env[name]?.trim();
    if (!value) return null;

    if (value.length < MIN_SECRET_LENGTH || PLACEHOLDER_PATTERN.test(value)) {
        throw new Error(
            `${name} must be a unique value of at least ${MIN_SECRET_LENGTH} characters when configured.`
        );
    }

    return value;
}

module.exports = {
    jwtSecret: loadSecret('JWT_SECRET'),
    sessionSecret: loadSecret('SESSION_SECRET'),
    totpEncryptionSecret: loadOptionalSecret('TOTP_ENCRYPTION_KEY'),
    authCookieName: 'nodecast_auth',
    authCookieMaxAgeMs: 24 * 60 * 60 * 1000
};
