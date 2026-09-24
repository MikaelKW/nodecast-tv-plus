'use strict';

const diagnosticEvents = require('./diagnosticEvents');

const MAX_TRACES = 128;
const MAX_AGE_MS = 60 * 60 * 1000;
const PATH_REASONS = new Set(['direct_hls', 'native_hls', 'direct_media', 'auto_remux', 'forced_remux', 'proxied_hls']);
const LIFECYCLE_REASONS = Object.freeze({
    browser_playback_started: new Set(['media_playing']),
    browser_proxy_retry: new Set(['proxy_retry']),
    browser_playback_failed: new Set(['start_blocked', 'start_failed', 'hls_failed']),
    browser_playback_stopped: new Set(['browser_replaced', 'browser_stopped', 'page_closed'])
});

function createStore({ now = Date.now, events = diagnosticEvents, maxTraces = MAX_TRACES, maxAgeMs = MAX_AGE_MS } = {}) {
    const traces = new Map();

    function prune() {
        const cutoff = now() - maxAgeMs;
        for (const [traceId, trace] of traces) {
            if (trace.createdAt < cutoff) traces.delete(traceId);
        }
        while (traces.size > maxTraces) traces.delete(traces.keys().next().value);
    }

    function start(ownerId, reason) {
        if (!Number.isSafeInteger(ownerId) || !PATH_REASONS.has(reason)) return null;
        prune();
        const traceId = events.createTraceId();
        if (!traceId || !events.record({ traceId, event: 'browser_path_selected', reason })) return null;
        traces.set(traceId, { ownerId, createdAt: now() });
        prune();
        return traceId;
    }

    function record(ownerId, traceId, event, reason) {
        prune();
        const trace = typeof traceId === 'string' ? traces.get(traceId) : null;
        if (!trace || trace.ownerId !== ownerId) return false;
        if (event === 'browser_path_selected') {
            if (reason !== 'proxied_hls') return false;
        } else if (!Object.hasOwn(LIFECYCLE_REASONS, event) || !LIFECYCLE_REASONS[event].has(reason)) {
            return false;
        }
        if (!events.record({ traceId, event, reason })) return false;
        if (event === 'browser_playback_stopped') traces.delete(traceId);
        return true;
    }

    return Object.freeze({ start, record });
}

const store = createStore();
module.exports = { createStore, start: store.start, record: store.record, MAX_TRACES, MAX_AGE_MS };
