const express = require('express');
const router = express.Router();
const { favorites } = require('../db/sqlite');
const { sources } = require('../db');
const { requireAuth } = require('../auth');

// All favorites routes require authentication
router.use(requireAuth);

function parseChannelData(value) {
    try {
        return JSON.parse(value || '{}');
    } catch {
        return {};
    }
}

// Return the small, resolved channel records needed by the Home dashboard.
// This avoids loading every live channel merely to display a user's favorites.
router.get('/channels', async (req, res) => {
    try {
        const requestedLimit = Number.parseInt(req.query.limit, 10);
        const limit = Number.isSafeInteger(requestedLimit)
            ? Math.min(Math.max(requestedLimit, 1), 100)
            : 100;
        const configuredSources = await sources.getAll();
        const sourceById = new Map(configuredSources.map(source => [String(source.id), source]));
        const rows = favorites.getVisibleChannels(req.user.id, limit);
        const channels = [];

        for (const row of rows) {
            const source = sourceById.get(String(row.source_id));
            if (!source?.enabled
                || !['xtream', 'm3u'].includes(source.type)
                || source.contentVisibility?.live === false) continue;

            const data = parseChannelData(row.data);
            const sourceType = source.type;
            channels.push({
                favoriteId: row.favorite_id,
                id: `${sourceType}_${row.source_id}_${row.item_id}`,
                streamId: row.item_id,
                name: row.name,
                tvgId: data.epg_channel_id || data.tvgId || null,
                tvgLogo: row.stream_icon,
                ...(sourceType === 'm3u' ? { url: row.stream_url } : {}),
                groupId: `${sourceType}_${row.source_id}_${row.category_id || ''}`,
                groupTitle: row.category_name || 'Uncategorized',
                sourceId: row.source_id,
                sourceType
            });
        }

        res.json(channels);
    } catch (err) {
        console.error('Error resolving favorite channels:', err);
        res.status(500).json({ error: 'Failed to resolve favorite channels' });
    }
});

// Get all favorites for current user
router.get('/', async (req, res) => {
    try {
        const { sourceId, itemType } = req.query;
        const items = favorites.getAll(req.user.id, sourceId || null, itemType || null);
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add favorite for current user
router.post('/', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        favorites.add(req.user.id, sourceId, itemId, itemType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove favorite for current user
router.delete('/', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        favorites.remove(req.user.id, sourceId, itemId, itemType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check if item is favorited by current user
router.get('/check', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.query;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        const isFav = favorites.isFavorite(req.user.id, sourceId, itemId, itemType);
        res.json({ isFavorite: isFav });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

