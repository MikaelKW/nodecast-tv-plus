const net = require('node:net');

const RP_NAME = 'NodeCast TV Plus';

function unavailable(reason, message) {
    return { available: false, reason, message };
}

function isLocalhost(hostname) {
    return hostname === 'localhost' || hostname.endsWith('.localhost');
}

/**
 * Derive the WebAuthn relying party from APP_ORIGIN.
 *
 * The RP ID is the hostname and the expected origin is scheme, hostname and
 * port. A configured base path only affects application routes, never the
 * origin, so it is ignored here.
 */
function resolveRelyingParty(appOrigin = process.env.APP_ORIGIN) {
    const raw = String(appOrigin || '').trim();
    if (!raw) {
        return unavailable(
            'APP_ORIGIN_MISSING',
            'Passkeys require APP_ORIGIN to be set to the HTTPS address used to open NodeCast TV Plus.'
        );
    }

    let url;
    try {
        url = new URL(raw);
    } catch {
        return unavailable('APP_ORIGIN_INVALID', 'Passkeys are unavailable because APP_ORIGIN is not a valid URL.');
    }

    const hostname = url.hostname.toLowerCase();
    if (net.isIP(hostname.replace(/^\[|\]$/g, ''))) {
        return unavailable(
            'IP_ADDRESS_ORIGIN',
            'Passkeys require a host name. They cannot be used when NodeCast TV Plus is opened through an IP address.'
        );
    }

    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLocalhost(hostname));
    if (!secure) {
        return unavailable(
            'HTTPS_REQUIRED',
            'Passkeys require HTTPS. Set APP_ORIGIN to the https:// address used to open NodeCast TV Plus.'
        );
    }

    return {
        available: true,
        rpName: RP_NAME,
        rpID: hostname,
        origin: url.origin.toLowerCase()
    };
}

let cached = null;

function current() {
    if (!cached) cached = resolveRelyingParty();
    return cached;
}

module.exports = {
    RP_NAME,
    current,
    resolveRelyingParty
};
