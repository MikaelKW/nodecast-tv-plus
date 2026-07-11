'use strict';

const ALLOWED_MEDIA_PROTOCOLS = new Set(['http:', 'https:']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const FFMPEG_PROTOCOL_WHITELIST = 'http,https,tcp,tls,crypto,hls';

function validationError(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function isSensitiveHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const allowLoopback = process.env.ALLOW_LOCAL_MEDIA_URLS === 'true';

    if (host === 'metadata.google.internal') return true;
    if (host === '169.254.169.254' || host.startsWith('169.254.')) return true;
    if (host === '::1' || host.startsWith('fe80:')) return true;
    if (!allowLoopback && (host === 'localhost' || host.endsWith('.localhost'))) return true;
    if (!allowLoopback && (/^127\./.test(host) || host === '0.0.0.0')) return true;
    return false;
}

function validateHttpUrl(value, fieldName = 'URL') {
    if (typeof value !== 'string' || !value.trim()) {
        throw validationError(`${fieldName} is required`);
    }

    const candidate = value.trim();
    if (CONTROL_CHARACTERS.test(candidate)) {
        throw validationError(`${fieldName} contains invalid characters`);
    }

    let parsed;
    try {
        parsed = new URL(candidate);
    } catch {
        throw validationError(`${fieldName} must be a valid HTTP or HTTPS URL`);
    }

    if (!ALLOWED_MEDIA_PROTOCOLS.has(parsed.protocol)) {
        throw validationError(`${fieldName} must use HTTP or HTTPS`);
    }

    if (!parsed.hostname) {
        throw validationError(`${fieldName} must include a host`);
    }

    if (isSensitiveHost(parsed.hostname)) {
        throw validationError(`${fieldName} points to a protected local or metadata address`);
    }

    return candidate;
}

function redactUrl(value) {
    try {
        const parsed = new URL(value);
        if (!ALLOWED_MEDIA_PROTOCOLS.has(parsed.protocol)) return '[unsupported URL]';
        return `${parsed.protocol}//${parsed.host}/…`;
    } catch {
        return '[invalid URL]';
    }
}

function redactText(value) {
    return String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]');
}

module.exports = {
    FFMPEG_PROTOCOL_WHITELIST,
    redactText,
    redactUrl,
    validateHttpUrl
};
