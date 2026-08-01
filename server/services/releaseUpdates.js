const packageVersion = require('../../package.json').version;
const { settings } = require('../db');

const REPOSITORY_URL = 'https://github.com/MikaelKW/nodecast-tv-plus';
const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/MikaelKW/nodecast-tv-plus/releases/latest';
const RELEASE_URL_PREFIX = '/MikaelKW/nodecast-tv-plus/releases/tag/';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 10 * 1000;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 256 * 1024;

function parseStableVersion(value) {
    const match = typeof value === 'string'
        ? value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/)
        : null;
    if (!match) return null;

    const parts = match.slice(1).map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareStableVersions(left, right) {
    const leftParts = parseStableVersion(left);
    const rightParts = parseStableVersion(right);
    if (!leftParts || !rightParts) return null;

    for (let index = 0; index < leftParts.length; index += 1) {
        if (leftParts[index] !== rightParts[index]) {
            return leftParts[index] > rightParts[index] ? 1 : -1;
        }
    }
    return 0;
}

function validateReleaseMetadata(payload) {
    if (!payload || typeof payload !== 'object' || payload.draft || payload.prerelease) {
        throw new Error('GitHub returned unsupported release metadata.');
    }

    const versionParts = parseStableVersion(payload.tag_name);
    if (!versionParts) {
        throw new Error('GitHub returned an invalid stable release version.');
    }

    let releaseUrl;
    try {
        releaseUrl = new URL(payload.html_url);
    } catch {
        throw new Error('GitHub returned an invalid release link.');
    }
    if (
        releaseUrl.protocol !== 'https:'
        || releaseUrl.hostname !== 'github.com'
        || !releaseUrl.pathname.startsWith(RELEASE_URL_PREFIX)
        || releaseUrl.username
        || releaseUrl.password
    ) {
        throw new Error('GitHub returned an unexpected release link.');
    }

    const publishedAt = new Date(payload.published_at);
    if (!Number.isFinite(publishedAt.getTime())) {
        throw new Error('GitHub returned an invalid release date.');
    }

    return {
        version: versionParts.join('.'),
        releaseUrl: releaseUrl.toString(),
        publishedAt: publishedAt.toISOString()
    };
}

class ReleaseUpdateService {
    constructor({
        fetchImpl = globalThis.fetch,
        settingsStore = settings,
        currentVersion = packageVersion,
        now = () => Date.now(),
        requestTimeoutMs = REQUEST_TIMEOUT_MS
    } = {}) {
        this.fetchImpl = fetchImpl;
        this.settingsStore = settingsStore;
        this.currentVersion = currentVersion;
        this.now = now;
        this.requestTimeoutMs = requestTimeoutMs;
        this.lastSuccessfulCheck = null;
        this.lastErrorAt = null;
        this.inFlight = null;
        this.startupTimer = null;
        this.intervalTimer = null;
    }

    async automaticChecksEnabled() {
        const currentSettings = await this.settingsStore.get();
        return currentSettings.automaticUpdateChecks !== false;
    }

    cacheIsFresh() {
        return Boolean(
            this.lastSuccessfulCheck
            && this.now() - this.lastSuccessfulCheck.checkedAtMs < CACHE_TTL_MS
        );
    }

    buildStatus({ automaticChecksEnabled, respectDisabled = true } = {}) {
        const automatic = automaticChecksEnabled !== false;
        const base = {
            currentVersion: this.currentVersion,
            repositoryUrl: REPOSITORY_URL,
            automaticChecksEnabled: automatic,
            latestVersion: this.lastSuccessfulCheck?.version || null,
            releaseUrl: this.lastSuccessfulCheck?.releaseUrl || null,
            publishedAt: this.lastSuccessfulCheck?.publishedAt || null,
            lastCheckedAt: this.lastSuccessfulCheck?.checkedAt || null,
            lastErrorAt: this.lastErrorAt
        };

        if (respectDisabled && !automatic) {
            return { ...base, state: 'disabled', updateAvailable: null };
        }
        if (!this.lastSuccessfulCheck) {
            return {
                ...base,
                state: this.lastErrorAt ? 'unavailable' : 'not-checked',
                updateAvailable: null
            };
        }

        const comparison = compareStableVersions(
            this.lastSuccessfulCheck.version,
            this.currentVersion
        );
        const updateAvailable = comparison === 1;
        return {
            ...base,
            state: updateAvailable ? 'update-available' : 'up-to-date',
            updateAvailable
        };
    }

    async getStatus({ refreshIfDue = true } = {}) {
        const automaticChecksEnabled = await this.automaticChecksEnabled();
        if (automaticChecksEnabled && refreshIfDue && !this.cacheIsFresh()) {
            await this.checkNow({ force: false });
        }
        return this.buildStatus({ automaticChecksEnabled });
    }

    async checkNow({ force = true } = {}) {
        const automaticChecksEnabled = await this.automaticChecksEnabled();
        if (!force && this.cacheIsFresh()) {
            return this.buildStatus({ automaticChecksEnabled });
        }
        if (this.inFlight) {
            await this.inFlight;
            return this.buildStatus({ automaticChecksEnabled, respectDisabled: false });
        }

        this.inFlight = this.fetchLatestRelease()
            .then(release => {
                const checkedAtMs = this.now();
                this.lastSuccessfulCheck = {
                    ...release,
                    checkedAtMs,
                    checkedAt: new Date(checkedAtMs).toISOString()
                };
                this.lastErrorAt = null;
            })
            .catch(() => {
                this.lastErrorAt = new Date(this.now()).toISOString();
            })
            .finally(() => {
                this.inFlight = null;
            });

        await this.inFlight;
        return this.buildStatus({ automaticChecksEnabled, respectDisabled: false });
    }

    async fetchLatestRelease() {
        if (typeof this.fetchImpl !== 'function') {
            throw new Error('Release checks are not supported by this runtime.');
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        timeout.unref?.();

        try {
            const response = await this.fetchImpl(LATEST_RELEASE_API_URL, {
                method: 'GET',
                redirect: 'error',
                signal: controller.signal,
                headers: {
                    Accept: 'application/vnd.github+json',
                    'User-Agent': `NodeCast-TV-Plus/${this.currentVersion}`,
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });
            if (!response.ok) {
                throw new Error(`GitHub release check returned HTTP ${response.status}.`);
            }

            const body = await response.text();
            if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
                throw new Error('GitHub release response exceeded the size limit.');
            }

            let payload;
            try {
                payload = JSON.parse(body);
            } catch {
                throw new Error('GitHub returned invalid JSON.');
            }
            return validateReleaseMetadata(payload);
        } finally {
            clearTimeout(timeout);
        }
    }

    async checkIfDue() {
        if (!await this.automaticChecksEnabled() || this.cacheIsFresh()) return;
        await this.checkNow({ force: false });
    }

    start() {
        if (this.startupTimer || this.intervalTimer) return;
        const check = () => this.checkIfDue().catch(() => {});
        this.startupTimer = setTimeout(() => {
            this.startupTimer = null;
            check();
        }, STARTUP_DELAY_MS);
        this.startupTimer.unref?.();
        this.intervalTimer = setInterval(check, SCHEDULER_INTERVAL_MS);
        this.intervalTimer.unref?.();
    }

    stop() {
        if (this.startupTimer) clearTimeout(this.startupTimer);
        if (this.intervalTimer) clearInterval(this.intervalTimer);
        this.startupTimer = null;
        this.intervalTimer = null;
    }
}

const releaseUpdateService = new ReleaseUpdateService();

module.exports = releaseUpdateService;
module.exports.ReleaseUpdateService = ReleaseUpdateService;
module.exports.parseStableVersion = parseStableVersion;
module.exports.compareStableVersions = compareStableVersions;
module.exports.validateReleaseMetadata = validateReleaseMetadata;
module.exports.constants = {
    REPOSITORY_URL,
    LATEST_RELEASE_API_URL,
    CACHE_TTL_MS,
    MAX_RESPONSE_BYTES
};
