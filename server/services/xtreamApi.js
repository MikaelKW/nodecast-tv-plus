/**
 * Xtream Codes API v2 Client
 * Handles authentication and API calls to Xtream servers
 */
const { fetchWithPolicy } = require('./outboundSecurity');

const XTREAM_API_HEADERS = Object.freeze({
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
});

class XtreamApi {
    constructor(baseUrl, username, password) {
        // Clean up base URL
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.username = username;
        this.password = password;
    }

    /**
     * Build API URL with authentication
     */
    buildApiUrl(action, params = {}) {
        const url = new URL(`${this.baseUrl}/player_api.php`);
        url.searchParams.set('username', this.username);
        url.searchParams.set('password', this.password);
        if (action) {
            url.searchParams.set('action', action);
        }
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, value);
            }
        }
        return url.toString();
    }

    /**
     * Make API request
     */
    async request(action, params = {}) {
        const url = this.buildApiUrl(action, params);
        const response = await fetchWithPolicy(
            url,
            { headers: XTREAM_API_HEADERS },
            { allowPrivateHosts: [this.baseUrl] }
        );
        if (!response.ok) {
            throw new Error(`Xtream API error: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }

    /**
     * Authenticate and get server/user info
     */
    async authenticate() {
        const data = await this.request(null);
        if (!data.user_info) {
            throw new Error('Invalid credentials or server response');
        }
        return data;
    }

    /**
     * Get live channel categories
     */
    async getLiveCategories() {
        return this.request('get_live_categories');
    }

    /**
     * Get live streams, optionally filtered by category
     */
    async getLiveStreams(categoryId = null) {
        return this.request('get_live_streams', { category_id: categoryId });
    }

    /**
     * Get VOD categories
     */
    async getVodCategories() {
        return this.request('get_vod_categories');
    }

    /**
     * Get VOD streams, optionally filtered by category
     */
    async getVodStreams(categoryId = null) {
        return this.request('get_vod_streams', { category_id: categoryId });
    }

    /**
     * Get VOD info
     */
    async getVodInfo(vodId) {
        return this.request('get_vod_info', { vod_id: vodId });
    }

    /**
     * Get series categories
     */
    async getSeriesCategories() {
        return this.request('get_series_categories');
    }

    /**
     * Get series, optionally filtered by category
     */
    async getSeries(categoryId = null) {
        return this.request('get_series', { category_id: categoryId });
    }

    /**
     * Get series info
     */
    async getSeriesInfo(seriesId) {
        return this.request('get_series_info', { series_id: seriesId });
    }

    /**
     * Get short EPG for a stream
     */
    async getShortEpg(streamId, limit = 10) {
        return this.request('get_short_epg', { stream_id: streamId, limit });
    }

    /**
     * Get full EPG for a stream
     */
    async getSimpleDateTable(streamId) {
        return this.request('get_simple_data_table', { stream_id: streamId });
    }

    /**
     * Build stream URL for playback
     */
    buildStreamUrl(streamId, type = 'live', container = 'ts') {
        const typeMap = {
            live: 'live',
            vod: 'movie',
            series: 'series'
        };
        const streamType = typeMap[type] || 'live';
        return `${this.baseUrl}/${streamType}/${this.username}/${this.password}/${streamId}.${container}`;
    }

    /**
     * Get XMLTV EPG URL
     */
    getXmltvUrl() {
        return `${this.baseUrl}/xmltv.php?username=${this.username}&password=${this.password}`;
    }
}

const ACCOUNT_STATUS_MAX_LENGTH = 32;

function toCount(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function toIsoFromUnixSeconds(value) {
    const seconds = toCount(value);
    // Providers send 0, null or an empty string for accounts without an end date.
    if (!seconds) return null;
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Reduce the provider's user_info to the account fields shown to
 * administrators. Credentials and other provider fields are left out.
 */
function normalizeAccountInfo(data, now = Date.now()) {
    const info = data && typeof data.user_info === 'object' && data.user_info !== null
        ? data.user_info
        : null;
    if (!info) return null;

    const status = typeof info.status === 'string'
        ? info.status.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, ACCOUNT_STATUS_MAX_LENGTH)
        : '';
    const authorized = Number(info.auth) === 1;
    const expiresAt = toIsoFromUnixSeconds(info.exp_date);
    const expired = expiresAt !== null && Date.parse(expiresAt) <= now;

    return {
        authorized,
        status: status || null,
        active: authorized && !expired && status.toLowerCase() === 'active',
        expiresAt,
        expired,
        isTrial: Number(info.is_trial) === 1,
        maxConnections: toCount(info.max_connections),
        activeConnections: toCount(info.active_cons),
        createdAt: toIsoFromUnixSeconds(info.created_at)
    };
}

/**
 * Factory function to create API instance from source
 */
function createFromSource(source) {
    return new XtreamApi(source.url, source.username, source.password);
}

/**
 * Static authenticate for testing
 */
async function authenticate(url, username, password) {
    const api = new XtreamApi(url, username, password);
    return api.authenticate();
}

module.exports = { XtreamApi, createFromSource, authenticate, normalizeAccountInfo };
