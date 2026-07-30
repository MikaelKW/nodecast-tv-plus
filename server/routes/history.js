const express = require('express');
const { rateLimit } = require('express-rate-limit');
const router = express.Router();
const { getDb } = require('../db/sqlite');
const { requireAuth } = require('../auth');
const { parseBoundedInteger } = require('../services/requestControls');
const {
    normalizeHistoryPayload,
    pruneHistory
} = require('../services/historyPolicy');

// Middleware to ensure authentication
router.use(requireAuth);

const limitHistoryWrites = rateLimit({
    limit: 120,
    windowMs: 60 * 1000,
    keyGenerator: req => String(req.user.id),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many watch-history updates. Try again shortly.' }
});
const limitHistoryReads = rateLimit({
    limit: 120,
    windowMs: 60 * 1000,
    keyGenerator: req => String(req.user.id),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many watch-history requests. Try again shortly.' }
});

/**
 * GET /api/history
 * Returns the watch history for the authenticated user
 */
router.get('/', limitHistoryReads, (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const limit = parseBoundedInteger(req.query.limit, {
            name: 'limit',
            defaultValue: 20,
            min: 1,
            max: 100
        });

        const rows = db.prepare(`
            SELECT * FROM watch_history 
            WHERE user_id = ? 
            ORDER BY updated_at DESC 
            LIMIT ?
        `).all(userId, limit);

        const history = rows.map(row => ({
            ...row,
            data: JSON.parse(row.data || '{}')
        }));

        res.json(history);
    } catch (err) {
        if (err.statusCode === 400) {
            return res.status(400).json({ error: err.message });
        }
        console.error('[History] Error fetching history:', err);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

/**
 * POST /api/history
 * Saves/updates watch progress for an item
 */
router.post('/', limitHistoryWrites, (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const {
            itemId,
            itemType,
            parentId,
            progress,
            duration,
            serializedData,
            sourceId
        } = normalizeHistoryPayload(req.body);

        const compositeId = `${userId}:${itemId}`;
        const timestamp = Date.now();

        const saveHistory = db.transaction(() => {
            db.prepare(`
                INSERT INTO watch_history (id, user_id, source_id, item_type, item_id, parent_id, progress, duration, updated_at, data)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    source_id = excluded.source_id,
                    progress = excluded.progress,
                    duration = excluded.duration,
                    updated_at = excluded.updated_at,
                    data = excluded.data
            `).run(
                compositeId,
                userId,
                sourceId,
                itemType,
                itemId,
                parentId,
                progress,
                duration,
                timestamp,
                serializedData
            );

            pruneHistory(db, userId);
        });
        saveHistory();

        res.json({ success: true, timestamp });
    } catch (err) {
        if (err.statusCode === 400) {
            return res.status(400).json({ error: err.message });
        }
        console.error('[History] Error saving progress:', err);
        res.status(500).json({ error: 'Failed to save progress' });
    }
});

/**
 * DELETE /api/history/:itemId
 * Removes an item from the user's watch history
 */
router.delete('/:itemId', limitHistoryWrites, (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const itemId = req.params.itemId;

        const compositeId = `${userId}:${itemId}`;

        const stmt = db.prepare('DELETE FROM watch_history WHERE id = ? AND user_id = ?');
        const result = stmt.run(compositeId, userId);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Item not found in history' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[History] Error deleting history item:', err);
        res.status(500).json({ error: 'Failed to delete history item' });
    }
});

module.exports = router;
