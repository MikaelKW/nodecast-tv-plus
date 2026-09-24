'use strict';

const { randomUUID } = require('node:crypto');

// This is an in-memory, best-effort view, not a log or a support export.
// Only fixed codes and generated identifiers are accepted. In particular, no
// URL, error, header, command argument, account, or source name can enter it.
const MAX_EVENTS = 128;
const MAX_AGE_MS = 60 * 60 * 1000;
const TRACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EVENT_DOMAIN = Object.freeze({
    session_start: 'playback',
    path_selected: 'playback',
    browser_path_selected: 'playback',
    browser_playback_started: 'playback',
    browser_proxy_retry: 'playback',
    browser_playback_failed: 'playback',
    browser_playback_stopped: 'playback',
    playback_ready: 'playback',
    connection_retry: 'playback',
    playback_reconnecting: 'playback',
    playback_failed: 'playback',
    playback_completed: 'playback',
    session_cleanup: 'playback',
    sync_start: 'sync',
    sync_completed: 'sync',
    sync_failed: 'sync',
    sync_skipped: 'sync'
});

const EVENT_REASONS = Object.freeze({
    session_start: new Set(['requested', 'retrying']),
    path_selected: new Set(['video_audio_copy', 'video_copy_audio_encode', 'video_encode_audio_copy', 'video_audio_encode']),
    browser_path_selected: new Set(['direct_hls', 'native_hls', 'direct_media', 'auto_remux', 'forced_remux', 'proxied_hls']),
    browser_playback_started: new Set(['media_playing']),
    browser_proxy_retry: new Set(['proxy_retry']),
    browser_playback_failed: new Set(['start_blocked', 'start_failed', 'hls_failed']),
    browser_playback_stopped: new Set(['browser_replaced', 'browser_stopped', 'page_closed']),
    playback_ready: new Set(['playlist_ready']),
    connection_retry: new Set(['retrying']),
    playback_reconnecting: new Set(['input_reconnect']),
    playback_failed: new Set(['playlist_not_ready', 'startup_error', 'process_error', 'process_exit', 'retry_limit']),
    playback_completed: new Set(['completed']),
    session_cleanup: new Set(['replaced', 'lease_released', 'stale', 'client_disconnected', 'client_request', 'startup_failed', 'cleanup_requested']),
    sync_start: new Set(['sync_requested']),
    sync_completed: new Set(['sync_completed']),
    sync_failed: new Set(['sync_error', 'source_not_found']),
    sync_skipped: new Set(['source_disabled', 'already_syncing'])
});

const REASONS = Object.freeze({
    requested: 'Playback was requested.',
    playlist_ready: 'A playable playlist is ready.',
    retrying: 'The first connection failed; retrying once.',
    video_audio_copy: 'Video and audio are copied into an HLS stream.',
    video_copy_audio_encode: 'Video is copied and audio is converted for compatibility.',
    video_encode_audio_copy: 'Video is converted while audio is copied.',
    video_audio_encode: 'Video and audio are converted.',
    direct_hls: 'HLS playback without conversion was selected.',
    native_hls: 'Native browser HLS playback was selected.',
    direct_media: 'Direct media playback was selected.',
    auto_remux: 'Automatic stream repackaging was selected.',
    forced_remux: 'Force Remux stream repackaging was selected.',
    proxied_hls: 'HLS playback through the application proxy was selected.',
    media_playing: 'The browser started playback.',
    proxy_retry: 'The browser is retrying HLS through the application proxy.',
    start_blocked: 'The browser blocked playback from starting.',
    start_failed: 'The browser could not start playback.',
    hls_failed: 'HLS playback failed.',
    browser_replaced: 'Playback was replaced by another request.',
    browser_stopped: 'The browser stopped playback.',
    page_closed: 'The browser page was closed.',
    playlist_not_ready: 'The playback playlist did not become ready.',
    startup_error: 'Playback could not start.',
    process_error: 'The playback process failed.',
    process_exit: 'The playback process stopped unexpectedly.',
    input_reconnect: 'The live input disconnected; reconnecting.',
    retry_limit: 'The live input repeatedly disconnected.',
    completed: 'Playback completed normally.',
    replaced: 'The session was replaced by a newer playback request.',
    lease_released: 'The browser released the playback session.',
    stale: 'The inactive playback session was cleaned up.',
    client_disconnected: 'The browser disconnected during startup.',
    client_request: 'The browser stopped playback.',
    startup_failed: 'The failed startup session was cleaned up.',
    cleanup_requested: 'The playback session was cleaned up.',
    sync_requested: 'Source synchronization started.',
    sync_completed: 'Source synchronization completed.',
    source_disabled: 'The source is disabled.',
    already_syncing: 'A synchronization is already running for this source.',
    sync_error: 'Source synchronization failed.',
    source_not_found: 'The source is no longer available.'
});

function createTraceId() {
    try {
        return randomUUID();
    } catch {
        // Observability is optional; an ID failure must not stop playback.
        return null;
    }
}

function createStore({ now = Date.now, maxEvents = MAX_EVENTS, maxAgeMs = MAX_AGE_MS } = {}) {
    const events = [];

    function prune(currentTime) {
        while (events.length && currentTime - events[0].timestamp > maxAgeMs) {
            events.shift();
        }
    }

    function record(input) {
        try {
            if (!input || typeof input !== 'object') return false;
            const { traceId, event, reason, sourceId } = input;
            if (typeof traceId !== 'string' || !TRACE_ID_PATTERN.test(traceId)) return false;
            const domain = Object.hasOwn(EVENT_DOMAIN, event) ? EVENT_DOMAIN[event] : null;
            if (!domain || !EVENT_REASONS[event].has(reason)) return false;
            if (sourceId !== undefined && (domain !== 'sync' || !Number.isSafeInteger(sourceId) || sourceId < 0)) {
                return false;
            }
            if (domain === 'sync' && sourceId === undefined) return false;

            const timestamp = now();
            const entry = Object.freeze({
                timestamp,
                at: new Date(timestamp).toISOString(),
                traceId,
                domain,
                event,
                reason,
                reasonText: REASONS[reason],
                ...(domain === 'sync' ? { sourceId } : {})
            });
            prune(timestamp);
            events.push(entry);
            while (events.length > maxEvents) events.shift();
            return true;
        } catch {
            // Diagnostics must never interrupt playback or synchronization.
            return false;
        }
    }

    function list(limit = 50) {
        const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, maxEvents)) : 50;
        prune(now());
        return events.slice(-count).reverse().map(({ timestamp, ...entry }) => ({ ...entry }));
    }

    return Object.freeze({ record, list });
}

const store = createStore();

module.exports = { createTraceId, createStore, record: store.record, list: store.list, MAX_EVENTS, MAX_AGE_MS };
