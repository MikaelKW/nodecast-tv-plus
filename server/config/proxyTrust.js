'use strict';

const DEFAULT_PROXY_TRUST = 'loopback, linklocal, uniquelocal';

function configuredProxyTrust(value = process.env.TRUST_PROXY) {
    const configured = String(value ?? '').trim();
    if (!configured) return DEFAULT_PROXY_TRUST;
    if (configured.toLowerCase() === 'false') return false;
    if (configured.toLowerCase() === 'true') {
        console.warn('[Security] TRUST_PROXY=true is unrestricted; using the private-network default instead.');
        return DEFAULT_PROXY_TRUST;
    }
    if (/^\d+$/.test(configured)) {
        const hops = Number(configured);
        if (Number.isSafeInteger(hops) && hops >= 0 && hops <= 10) return hops;
        throw new Error('TRUST_PROXY hop count must be between 0 and 10.');
    }
    return configured;
}

module.exports = {
    DEFAULT_PROXY_TRUST,
    configuredProxyTrust
};
