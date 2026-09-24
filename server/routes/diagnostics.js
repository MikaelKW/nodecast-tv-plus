'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const auth = require('../auth');
const diagnosticEvents = require('../services/diagnosticEvents');
const transcodeSessions = require('../services/transcodeSession');
const { getDb } = require('../db/sqlite');
const packageVersion = require('../../package.json').version;

const router = express.Router();
const BROWSER_PATH_REASONS = new Set([
    'direct_hls', 'native_hls', 'direct_media', 'auto_remux', 'forced_remux', 'proxied_hls'
]);
const limitPathReports = rateLimit({
    limit: 60,
    windowMs: 60 * 1000,
    keyGenerator: req => String(req.user.id),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many playback reports. Try again shortly.' }
});
const limitReads = rateLimit({
    limit: 60,
    windowMs: 60 * 1000,
    keyGenerator: req => String(req.user.id),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many diagnostics requests. Try again shortly.' }
});

// Any signed-in browser can report a fixed path code. The server supplies the
// trace ID and never accepts provider details, account data, or raw errors.
router.post('/playback-path', auth.requireAuth, limitPathReports, (req, res) => {
    const reason = req.body?.reason;
    if (typeof reason !== 'string' || !BROWSER_PATH_REASONS.has(reason)) {
        return res.status(400).json({ error: 'Invalid playback path' });
    }
    const traceId = diagnosticEvents.createTraceId();
    if (traceId) diagnosticEvents.record({ traceId, event: 'browser_path_selected', reason });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(204).end();
});

router.use(auth.requireAuth, auth.requireAdmin);

router.get('/events', limitReads, (req, res) => {
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 100)
        : 50;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ events: diagnosticEvents.list(limit) });
});

router.get('/summary', limitReads, (req, res) => {
    const memory = process.memoryUsage();
    let synchronization = { available: false, sources: [] };
    try {
        // Never select source names, provider URLs, or raw sync error text.
        const rows = getDb().prepare(`
            SELECT source_id, last_sync, status FROM sync_status
            WHERE type = 'all' ORDER BY last_sync DESC LIMIT 20
        `).all();
        const validStatuses = new Set(['syncing', 'success', 'error']);
        synchronization = {
            available: true,
            sources: rows.map(row => ({
                sourceId: row.source_id,
                status: validStatuses.has(row.status) ? row.status : 'unavailable',
                at: Number.isSafeInteger(row.last_sync) && row.last_sync >= 0 && row.last_sync <= 8640000000000000
                    ? new Date(row.last_sync).toISOString() : null
            }))
        };
    } catch {
        // A diagnostics failure must not affect the source or playback paths.
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
        version: packageVersion,
        revision: /^[a-f0-9]{40}$/i.test(process.env.NODECAST_REVISION || '')
            ? process.env.NODECAST_REVISION : null,
        resources: {
            processUptimeSeconds: Math.floor(process.uptime()),
            processRssBytes: memory.rss,
            processHeapUsedBytes: memory.heapUsed
        },
        playback: { managedSessions: transcodeSessions.getDiagnosticSessions() },
        synchronization,
        events: diagnosticEvents.list(50),
        retention: { maxEvents: diagnosticEvents.MAX_EVENTS, maxAgeSeconds: diagnosticEvents.MAX_AGE_MS / 1000 }
    });
});

module.exports = router;
