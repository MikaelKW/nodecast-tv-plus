'use strict';

const diagnosticEvents = require('./diagnosticEvents');

const MAX_EXPORT_BYTES = 48 * 1024;
const MAX_EXPORT_EVENTS = 50;
const MAX_EXPORT_SOURCES = 20;
const MAX_EXPORT_SESSIONS = 16;
const TRACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_PATTERN = /^[0-9a-f]{40}$/i;
const VERSION_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const SESSION_STATUSES = new Set(['pending', 'starting', 'running', 'reconnecting']);
const SYNC_STATUSES = new Set(['syncing', 'success', 'error', 'unavailable']);

function nonnegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestamp(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value))
        && new Date(value).toISOString() === value ? value : null;
}

// This is a schema allowlist, not a redaction pass over arbitrary application
// state. New fields are excluded until deliberately added and tested here.
function createSnapshot(summary, generatedAt = new Date().toISOString()) {
    const safe = summary && typeof summary === 'object' ? summary : {};
    const sessions = Array.isArray(safe.playback?.managedSessions)
        ? safe.playback.managedSessions : [];
    const sources = Array.isArray(safe.synchronization?.sources)
        ? safe.synchronization.sources : [];
    const events = Array.isArray(safe.events) ? safe.events : [];

    const snapshot = {
        schemaVersion: 1,
        generatedAt: timestamp(generatedAt) || new Date().toISOString(),
        application: {
            version: typeof safe.version === 'string' && VERSION_PATTERN.test(safe.version) ? safe.version : null,
            revision: typeof safe.revision === 'string' && REVISION_PATTERN.test(safe.revision) ? safe.revision : null
        },
        resources: {
            processUptimeSeconds: nonnegativeInteger(safe.resources?.processUptimeSeconds),
            processRssBytes: nonnegativeInteger(safe.resources?.processRssBytes),
            processHeapUsedBytes: nonnegativeInteger(safe.resources?.processHeapUsedBytes)
        },
        playback: {
            managedSessions: sessions.slice(0, MAX_EXPORT_SESSIONS).flatMap(session => {
                if (!session || !TRACE_ID_PATTERN.test(session.traceId || '')) return [];
                return [{
                    traceId: session.traceId,
                    status: SESSION_STATUSES.has(session.status) ? session.status : 'unavailable',
                    ageSeconds: nonnegativeInteger(session.ageSeconds)
                }];
            })
        },
        synchronization: {
            available: safe.synchronization?.available === true,
            sources: sources.slice(0, MAX_EXPORT_SOURCES).flatMap(source => {
                if (!source || !Number.isSafeInteger(source.sourceId) || source.sourceId < 0) return [];
                return [{
                    sourceId: source.sourceId,
                    status: SYNC_STATUSES.has(source.status) ? source.status : 'unavailable',
                    at: timestamp(source.at)
                }];
            })
        },
        events: events.slice(0, MAX_EXPORT_EVENTS)
            .map(event => diagnosticEvents.toPublicEvent(event)).filter(Boolean),
        retention: {
            maxEvents: diagnosticEvents.MAX_EVENTS,
            maxAgeSeconds: diagnosticEvents.MAX_AGE_MS / 1000
        }
    };

    const exportSize = () => Buffer.byteLength(JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    while (exportSize() > MAX_EXPORT_BYTES && snapshot.events.length) {
        snapshot.events.pop();
    }
    if (exportSize() > MAX_EXPORT_BYTES) {
        throw new Error('Support snapshot exceeds its size limit');
    }
    return snapshot;
}

module.exports = { createSnapshot, MAX_EXPORT_BYTES, MAX_EXPORT_EVENTS };
