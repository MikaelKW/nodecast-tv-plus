/**
 * Resolve NodeCast-owned URLs when the app is published below a reverse-proxy
 * path such as /nodecast/. External provider URLs are intentionally unchanged.
 */
(function initializeBasePath() {
    const scriptUrl = new URL(document.currentScript.src, window.location.href);
    const scriptSuffix = '/js/basePath.js';
    const pathname = scriptUrl.pathname.endsWith(scriptSuffix)
        ? scriptUrl.pathname.slice(0, -scriptSuffix.length)
        : '';
    const basePath = pathname === '/' ? '' : pathname.replace(/\/$/, '');

    function isExternal(value) {
        return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value);
    }

    function resolve(value) {
        if (typeof value !== 'string' || !value || isExternal(value)) return value;
        if (!value.startsWith('/')) return value;
        if (!basePath || value === basePath || value.startsWith(`${basePath}/`)) return value;
        return `${basePath}${value}`;
    }

    function absolute(value) {
        return new URL(resolve(value), window.location.origin).href;
    }

    function isApi(value) {
        if (typeof value !== 'string' || !value) return false;
        try {
            const pathnameValue = new URL(value, window.location.origin).pathname;
            return pathnameValue === `${basePath}/api` || pathnameValue.startsWith(`${basePath}/api/`);
        } catch {
            return false;
        }
    }

    function remux(value, streamInfo = null) {
        const params = new URLSearchParams({ url: value });
        const trackCodecs = Array.isArray(streamInfo?.audioTracks)
            ? streamInfo.audioTracks.map(track => track?.codec).filter(Boolean)
            : [];
        const audioCodecs = trackCodecs.length > 0
            ? trackCodecs
            : (streamInfo?.audio ? [streamInfo.audio] : []);

        if (audioCodecs.length > 0) {
            params.set('audioCodecs', audioCodecs.join(','));
        }

        return resolve(`/api/remux?${params.toString()}`);
    }

    window.NodeCastUrl = Object.freeze({ basePath, resolve, absolute, isApi, remux });
})();
