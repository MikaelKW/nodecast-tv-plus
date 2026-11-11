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

    function isAppleMobile(userAgent, platform, maxTouchPoints) {
        if (/\biP(?:hone|ad|od)\b/.test(userAgent)) return true;
        // iPadOS requests desktop sites by default and reports a Mac user agent.
        return platform === 'MacIntel' && Number(maxTouchPoints) > 1;
    }

    // Use the copy-mode HLS session instead of the progressive fragmented-MP4
    // remux pipe. Firefox drops the remuxed AAC audio, and iOS/iPadOS WebKit
    // cannot play the open-ended pipe at all, which leaves Live TV black.
    function prefersHlsRemuxFallback(
        userAgent = window.navigator?.userAgent || '',
        platform = window.navigator?.platform || '',
        maxTouchPoints = window.navigator?.maxTouchPoints || 0
    ) {
        const agent = String(userAgent);
        return /\bFirefox\//i.test(agent) || isAppleMobile(agent, platform, maxTouchPoints);
    }

    window.NodeCastUrl = Object.freeze({
        basePath,
        resolve,
        absolute,
        isApi,
        remux,
        prefersHlsRemuxFallback
    });
})();
