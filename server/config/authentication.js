function enabled(name) {
    return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

const localAuthEnabled = !enabled('DISABLE_LOCAL_AUTH');
const oidcAutoRedirectRequested = enabled('OIDC_AUTO_REDIRECT');

function publicLoginOptions(oidcEnabled) {
    const enabled = Boolean(oidcEnabled);
    return {
        enabled,
        localAuthEnabled,
        autoRedirect: enabled && oidcAutoRedirectRequested
    };
}

module.exports = {
    localAuthEnabled,
    oidcAutoRedirectRequested,
    publicLoginOptions
};
