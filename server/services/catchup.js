/**
 * Provider catch-up (Xtream "TV archive").
 *
 * Xtream providers mark archive-enabled channels with `tv_archive` and the
 * number of days kept with `tv_archive_duration`. A past programme is played
 * from the provider's timeshift URL, which takes the start time in the
 * provider's own time zone and the length in minutes.
 */

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// The longest single request. A programme longer than this still plays; the
// browser asks for the remainder when it seeks past the end.
const MAX_DURATION_MINUTES = 12 * 60;
// Providers do not keep archives longer than a few weeks; ignore nonsense.
const MAX_ARCHIVE_DAYS = 31;
// Clock differences between this server and the provider.
const CLOCK_TOLERANCE_MS = 5 * MINUTE_MS;

function invalid(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

/** Catch-up window of a channel record, or null when it has none. */
function archiveWindow(channel) {
    if (!channel || typeof channel !== 'object') return null;
    const flag = channel.tv_archive;
    const enabled = flag === true || Number(flag) === 1;
    const days = Math.floor(Number(channel.tv_archive_duration));
    if (!enabled || !Number.isFinite(days) || days < 1) return null;
    return { days: Math.min(days, MAX_ARCHIVE_DAYS) };
}

/** Valid IANA time zone name, or null. */
function normalizeTimeZone(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 64) return null;
    try {
        return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone;
    } catch {
        return null;
    }
}

/** Format a date as YYYY-MM-DD:HH-MM in the given time zone (UTC by default). */
function formatProviderTime(date, timeZone = null) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: normalizeTimeZone(timeZone) || 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}:${parts.hour}-${parts.minute}`;
}

function parseInstant(value, name) {
    if (typeof value !== 'string' || value.length > 64) throw invalid(`Valid ${name} time required`);
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw invalid(`Valid ${name} time required`);
    return time;
}

/**
 * Validate a catch-up request against the channel's archive window.
 * Returns the start (floored to the minute, as providers address whole
 * minutes), the requested length in minutes, and the playable seconds.
 */
function resolveRequest({ start, end, window, now = Date.now() }) {
    if (!window) {
        const error = new Error('Catch-up is not available for this channel');
        error.statusCode = 404;
        throw error;
    }
    const startMs = parseInstant(start, 'start');
    const endMs = parseInstant(end, 'end');
    if (endMs <= startMs) throw invalid('The end time must be after the start time');
    if (startMs >= now) throw invalid('The programme has not started yet');
    if (startMs < now - window.days * DAY_MS - CLOCK_TOLERANCE_MS) {
        throw invalid('The programme is no longer in the provider archive');
    }

    const providerStart = Math.floor(startMs / MINUTE_MS) * MINUTE_MS;
    // Whole minutes from the floored start, so the requested range still
    // covers the end of the programme.
    const minutes = Math.min(
        MAX_DURATION_MINUTES,
        Math.max(1, Math.ceil((endMs - providerStart) / MINUTE_MS))
    );
    return {
        providerStart,
        minutes,
        // Seconds of the requested programme time that precede startMs.
        leadInSeconds: (startMs - providerStart) / 1000
    };
}

function buildTimeshiftUrl(source, streamId, providerStart, minutes, timeZone, container = 'ts') {
    const baseUrl = String(source.url || '').replace(/\/+$/, '');
    const segments = [
        'timeshift',
        source.username,
        source.password,
        String(minutes),
        formatProviderTime(new Date(providerStart), timeZone),
        `${streamId}.${container}`
    ].map(segment => encodeURIComponent(String(segment)).replace(/%3A/gi, ':'));
    return `${baseUrl}/${segments.join('/')}`;
}

const PROBE_TIMEOUT_MS = 10 * 1000;

/**
 * Ask the provider whether it serves the recording, reading at most its
 * first byte. A provider that advertises an archive may still refuse a
 * particular programme; finding out here keeps the browser's current
 * playback running and lets the guide show the refusal.
 */
async function confirmAvailable(url, fetchImpl, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    let response;
    try {
        response = await fetchImpl(url, {
            headers: { Range: 'bytes=0-0' },
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch {
        const error = new Error('The provider archive did not respond. Try again later.');
        error.statusCode = 502;
        throw error;
    }
    await response.body?.cancel().catch(() => {});
    if (response.ok) return;
    const error = new Error(response.status >= 500
        ? 'The provider archive is unavailable. Try again later.'
        : 'The provider archive does not have this programme.');
    error.statusCode = response.status >= 500 ? 502 : 404;
    throw error;
}

module.exports = {
    MAX_ARCHIVE_DAYS,
    MAX_DURATION_MINUTES,
    archiveWindow,
    buildTimeshiftUrl,
    confirmAvailable,
    formatProviderTime,
    normalizeTimeZone,
    resolveRequest
};
