function normalizeBasePath(value = '') {
    const trimmed = String(value).trim();
    if (!trimmed || trimmed === '/') return '';

    const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    const normalized = withLeadingSlash.replace(/\/+$/, '');
    if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(normalized)) return '';
    const segments = normalized.slice(1).split('/');
    return segments.some(segment => segment === '.' || segment === '..') ? '' : normalized;
}

const configuredBasePath = normalizeBasePath(process.env.NODECAST_BASE_PATH);

function withBasePath(pathname, basePath = configuredBasePath) {
    const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return basePath ? `${basePath}${normalizedPath}` : normalizedPath;
}

function requestBasePath(req) {
    const forwardedPrefix = req.get?.('x-forwarded-prefix');
    return normalizeBasePath(forwardedPrefix || req.nodecastBasePath || configuredBasePath);
}

function installBasePathMiddleware(app) {
    app.use((req, res, next) => {
        if (!configuredBasePath) return next();

        if (req.url === configuredBasePath) {
            return res.redirect(308, `${configuredBasePath}/`);
        }

        if (req.url.startsWith(`${configuredBasePath}/`)) {
            req.nodecastBasePath = configuredBasePath;
            req.url = req.url.slice(configuredBasePath.length) || '/';
        }

        next();
    });
}

module.exports = {
    configuredBasePath,
    installBasePathMiddleware,
    normalizeBasePath,
    requestBasePath,
    withBasePath
};
