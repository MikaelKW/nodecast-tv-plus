const MAX_DISCOVERY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;

function validateOidcUrl(value, label, { issuer = false } = {}) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`${label} must be a valid URL.`);
    }

    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
        throw new Error(`${label} must use HTTPS, except for local loopback testing.`);
    }
    if (parsed.username || parsed.password) {
        throw new Error(`${label} must not contain URL credentials.`);
    }
    if (parsed.hash) {
        throw new Error(`${label} must not contain a URL fragment.`);
    }
    if (issuer && parsed.search) {
        throw new Error(`${label} must not contain a query string.`);
    }

    return parsed.toString();
}

function canonicalIssuer(value) {
    return validateOidcUrl(value, 'OIDC issuer', { issuer: true }).replace(/\/+$/, '');
}

async function discoverOidcEndpoints(issuerUrl, {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new Error('OIDC discovery requires the Fetch API.');
    }

    const issuer = canonicalIssuer(issuerUrl);
    const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
        response = await fetchImpl(discoveryUrl, {
            headers: { Accept: 'application/json' },
            signal: controller.signal
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error(`OIDC discovery timed out after ${timeoutMs}ms.`);
        }
        throw new Error(`OIDC discovery request failed: ${error.message}`);
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        throw new Error(`OIDC discovery returned HTTP ${response.status}.`);
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DISCOVERY_BYTES) {
        throw new Error('OIDC discovery document is too large.');
    }

    const responseText = await response.text();
    if (Buffer.byteLength(responseText) > MAX_DISCOVERY_BYTES) {
        throw new Error('OIDC discovery document is too large.');
    }

    let document;
    try {
        document = JSON.parse(responseText);
    } catch {
        throw new Error('OIDC discovery did not return valid JSON.');
    }

    if (canonicalIssuer(document.issuer) !== issuer) {
        throw new Error('OIDC discovery issuer does not match OIDC_ISSUER_URL.');
    }

    return {
        authorizationURL: validateOidcUrl(document.authorization_endpoint, 'OIDC authorization endpoint'),
        tokenURL: validateOidcUrl(document.token_endpoint, 'OIDC token endpoint'),
        userInfoURL: validateOidcUrl(document.userinfo_endpoint, 'OIDC user-info endpoint')
    };
}

async function resolveOidcEndpoints({
    issuerUrl,
    authorizationUrl,
    tokenUrl,
    userInfoUrl
}, options = {}) {
    const manualEndpoints = [authorizationUrl, tokenUrl, userInfoUrl];
    const hasCompleteManualConfiguration = manualEndpoints.every(Boolean);

    if (hasCompleteManualConfiguration) {
        return {
            authorizationURL: validateOidcUrl(authorizationUrl, 'OIDC authorization endpoint'),
            tokenURL: validateOidcUrl(tokenUrl, 'OIDC token endpoint'),
            userInfoURL: validateOidcUrl(userInfoUrl, 'OIDC user-info endpoint'),
            source: 'manual'
        };
    }

    const discovered = await discoverOidcEndpoints(issuerUrl, options);
    return {
        authorizationURL: authorizationUrl
            ? validateOidcUrl(authorizationUrl, 'OIDC authorization endpoint')
            : discovered.authorizationURL,
        tokenURL: tokenUrl
            ? validateOidcUrl(tokenUrl, 'OIDC token endpoint')
            : discovered.tokenURL,
        userInfoURL: userInfoUrl
            ? validateOidcUrl(userInfoUrl, 'OIDC user-info endpoint')
            : discovered.userInfoURL,
        source: manualEndpoints.some(Boolean) ? 'discovery with overrides' : 'discovery'
    };
}

module.exports = {
    discoverOidcEndpoints,
    resolveOidcEndpoints,
    validateOidcUrl
};
