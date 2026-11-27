const crypto = require('node:crypto');
const {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse
} = require('@simplewebauthn/server');
const webauthnConfig = require('../config/webauthn');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_PENDING_CHALLENGES = 10000;
const MAX_PASSKEYS_PER_USER = 20;
const MAX_NAME_LENGTH = 64;
const MAX_RESPONSE_BYTES = 64 * 1024;
const KNOWN_TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);
// EdDSA, ES256 and RS256 cover current platform authenticators, password
// managers and security keys. An explicit list also keeps the library from
// probing experimental post-quantum Web Crypto support at runtime.
const SUPPORTED_ALGORITHM_IDS = Object.freeze([-8, -7, -257]);

// Only an opaque identifier is stored in the session. Consuming a challenge
// removes it synchronously, so parallel requests that share a session cannot
// both use the same challenge.
const pendingChallenges = new Map();

function unavailableError() {
    const error = new Error(webauthnConfig.current().message || 'Passkeys are not available on this server.');
    error.code = 'PASSKEYS_UNAVAILABLE';
    error.statusCode = 503;
    return error;
}

function relyingParty() {
    const rp = webauthnConfig.current();
    if (!rp.available) throw unavailableError();
    return rp;
}

function isAvailable() {
    return webauthnConfig.current().available;
}

function publicAvailability() {
    const rp = webauthnConfig.current();
    if (!rp.available) return { available: false, reason: rp.reason, message: rp.message };
    return { available: true, origin: rp.origin, rpID: rp.rpID };
}

function prune(now = Date.now()) {
    for (const [id, entry] of pendingChallenges) {
        if (entry.expiresAt <= now) pendingChallenges.delete(id);
    }
    while (pendingChallenges.size >= MAX_PENDING_CHALLENGES) {
        pendingChallenges.delete(pendingChallenges.keys().next().value);
    }
}

function issueChallenge(purpose, challenge, data = {}) {
    prune();
    const id = crypto.randomBytes(24).toString('base64url');
    pendingChallenges.set(id, {
        ...data,
        purpose,
        challenge,
        expiresAt: Date.now() + CHALLENGE_TTL_MS
    });
    return id;
}

function consumeChallenge(id, purpose) {
    if (typeof id !== 'string' || !id) return null;
    const entry = pendingChallenges.get(id);
    pendingChallenges.delete(id);
    if (!entry || entry.purpose !== purpose || entry.expiresAt <= Date.now()) return null;
    return entry;
}

function revokeUserChallenges(userId) {
    for (const [id, entry] of pendingChallenges) {
        if (entry.userId === userId) pendingChallenges.delete(id);
    }
}

function userPasskeys(user) {
    return Array.isArray(user?.passkeys) ? user.passkeys : [];
}

function hasPasskeys(user) {
    return userPasskeys(user).length > 0;
}

function sanitizeTransports(transports) {
    if (!Array.isArray(transports)) return [];
    return [...new Set(transports.filter(transport => KNOWN_TRANSPORTS.has(transport)))];
}

function descriptor(passkey) {
    const transports = sanitizeTransports(passkey.transports);
    return transports.length > 0 ? { id: passkey.id, transports } : { id: passkey.id };
}

function normalizeName(name, fallback = 'Passkey') {
    const cleaned = String(name ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_NAME_LENGTH)
        .trim();
    return cleaned || fallback;
}

function toPublicPasskey(passkey) {
    return {
        id: passkey.id,
        name: passkey.name,
        createdAt: passkey.createdAt,
        lastUsedAt: passkey.lastUsedAt || null,
        backedUp: Boolean(passkey.backedUp),
        deviceType: passkey.deviceType === 'multiDevice' ? 'multiDevice' : 'singleDevice'
    };
}

/**
 * Accept only the JSON shape produced by navigator.credentials and reject
 * oversized payloads before they reach CBOR parsing.
 */
function parseCredentialResponse(value, kind) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.id !== 'string' || typeof value.rawId !== 'string' || value.type !== 'public-key') return null;
    if (!value.response || typeof value.response !== 'object') return null;
    if (typeof value.response.clientDataJSON !== 'string') return null;
    if (kind === 'registration' && typeof value.response.attestationObject !== 'string') return null;
    if (kind === 'authentication' && (
        typeof value.response.authenticatorData !== 'string' || typeof value.response.signature !== 'string'
    )) return null;
    try {
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RESPONSE_BYTES) return null;
    } catch {
        return null;
    }
    return {
        ...value,
        clientExtensionResults: value.clientExtensionResults && typeof value.clientExtensionResults === 'object'
            ? value.clientExtensionResults
            : {}
    };
}

async function registrationOptions(user, webauthnUserId) {
    const rp = relyingParty();
    return generateRegistrationOptions({
        rpName: rp.rpName,
        rpID: rp.rpID,
        userName: user.username,
        userDisplayName: user.username,
        userID: new Uint8Array(Buffer.from(webauthnUserId, 'base64url')),
        attestationType: 'none',
        supportedAlgorithmIDs: [...SUPPORTED_ALGORITHM_IDS],
        excludeCredentials: userPasskeys(user).map(descriptor),
        authenticatorSelection: {
            residentKey: 'required',
            userVerification: 'required'
        },
        timeout: CEREMONY_TIMEOUT_MS
    });
}

async function verifyRegistration(response, expectedChallenge) {
    const rp = relyingParty();
    try {
        const verification = await verifyRegistrationResponse({
            response,
            expectedChallenge,
            expectedOrigin: rp.origin,
            expectedRPID: rp.rpID,
            requireUserVerification: true,
            supportedAlgorithmIDs: [...SUPPORTED_ALGORITHM_IDS]
        });
        if (!verification.verified) return null;
        const info = verification.registrationInfo;
        return {
            id: info.credential.id,
            publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
            counter: info.credential.counter,
            transports: sanitizeTransports(info.credential.transports || response.response?.transports),
            deviceType: info.credentialDeviceType,
            backedUp: Boolean(info.credentialBackedUp)
        };
    } catch {
        return null;
    }
}

async function authenticationOptions({ passkeys = null, userVerification }) {
    const rp = relyingParty();
    return generateAuthenticationOptions({
        rpID: rp.rpID,
        allowCredentials: passkeys ? passkeys.map(descriptor) : undefined,
        userVerification,
        timeout: CEREMONY_TIMEOUT_MS
    });
}

/**
 * Verify an assertion against one stored passkey. The library rejects
 * signature counter regressions for authenticators that report a counter and
 * accepts synced passkeys that always report zero.
 */
async function verifyAssertion(response, expectedChallenge, passkey, { requireUserVerification }) {
    const rp = relyingParty();
    try {
        const verification = await verifyAuthenticationResponse({
            response,
            expectedChallenge,
            expectedOrigin: rp.origin,
            expectedRPID: rp.rpID,
            requireUserVerification,
            credential: {
                id: passkey.id,
                publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
                counter: Number(passkey.counter) || 0,
                transports: sanitizeTransports(passkey.transports)
            }
        });
        if (!verification.verified) return null;
        if (requireUserVerification && !verification.authenticationInfo.userVerified) return null;
        return verification.authenticationInfo;
    } catch {
        return null;
    }
}

module.exports = {
    CHALLENGE_TTL_MS,
    MAX_NAME_LENGTH,
    MAX_PASSKEYS_PER_USER,
    authenticationOptions,
    consumeChallenge,
    hasPasskeys,
    isAvailable,
    issueChallenge,
    normalizeName,
    parseCredentialResponse,
    publicAvailability,
    registrationOptions,
    revokeUserChallenges,
    toPublicPasskey,
    unavailableError,
    userPasskeys,
    verifyAssertion,
    verifyRegistration
};
