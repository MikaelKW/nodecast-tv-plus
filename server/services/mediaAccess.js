'use strict';

const crypto = require('node:crypto');
const { sources } = require('../db');
const { getDb } = require('../db/sqlite');
const securityConfig = require('../config/security');
const { assertSafeOutboundUrl } = require('./outboundSecurity');
const { validateHttpUrl } = require('./urlSecurity');

const SIGNATURE_TTL_MS = 24 * 60 * 60 * 1000;

function accessError() {
    const error = new Error('Media target is not authorized');
    error.statusCode = 403;
    return error;
}

function signaturePayload(url, expiresAt) {
    return `${expiresAt}\n${url}`;
}

function signMediaUrl(value, now = Date.now()) {
    const url = validateHttpUrl(value);
    const expiresAt = now + SIGNATURE_TTL_MS;
    const token = crypto
        .createHmac('sha256', securityConfig.jwtSecret)
        .update(signaturePayload(url, expiresAt))
        .digest('base64url');
    return { token, expiresAt };
}

function verifyMediaSignature(value, token, expiresAt, now = Date.now()) {
    if (typeof token !== 'string' || !/^\d{10,16}$/.test(String(expiresAt || ''))) return false;
    const expiry = Number(expiresAt);
    if (!Number.isSafeInteger(expiry) || expiry < now || expiry > now + SIGNATURE_TTL_MS + 60000) return false;

    const url = validateHttpUrl(value);
    const expected = crypto
        .createHmac('sha256', securityConfig.jwtSecret)
        .update(signaturePayload(url, expiry))
        .digest();
    let provided;
    try {
        provided = Buffer.from(token, 'base64url');
    } catch {
        return false;
    }
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function sameOrigin(left, right) {
    try {
        return new URL(left).origin.toLowerCase() === new URL(right).origin.toLowerCase();
    } catch {
        return false;
    }
}

async function configuredSourceUrls() {
    const configured = await sources.getAll();
    return configured
        .map(source => source.url)
        .filter(value => typeof value === 'string' && value.trim());
}

function isStoredMediaUrl(url) {
    try {
        const row = getDb().prepare(`
            SELECT 1
            FROM playlist_items
            WHERE stream_url = ? OR stream_icon = ?
            LIMIT 1
        `).get(url, url);
        return Boolean(row);
    } catch {
        return false;
    }
}

async function isConfiguredMediaUrl(url, sourceUrls = null) {
    if (isStoredMediaUrl(url)) return true;
    const configured = sourceUrls || await configuredSourceUrls();
    return configured.some(sourceUrl => sourceUrl === url || sameOrigin(sourceUrl, url));
}

async function authorizeMediaUrl(value, {
    token,
    expiresAt,
    fieldName = 'Media URL'
} = {}) {
    const url = validateHttpUrl(value, fieldName);
    const sourceUrls = await configuredSourceUrls();
    const signed = verifyMediaSignature(url, token, expiresAt);
    if (!signed && !await isConfiguredMediaUrl(url, sourceUrls)) throw accessError();
    return assertSafeOutboundUrl(url, { fieldName, allowPrivateHosts: sourceUrls });
}

module.exports = {
    authorizeMediaUrl,
    configuredSourceUrls,
    isConfiguredMediaUrl,
    signMediaUrl,
    verifyMediaSignature
};
