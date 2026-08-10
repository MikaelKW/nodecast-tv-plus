const express = require('express');
const { rateLimit } = require('express-rate-limit');
const router = express.Router();
const { parseBoundedInteger } = require('../services/requestControls');
const { getDb } = require('../db/sqlite');
const auth = require('../auth');

router.use(auth.requireAuth);

const limitRecentContent = rateLimit({
    limit: 120,
    windowMs: 60 * 1000,
    keyGenerator: req => String(req.user.id),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many recent-content requests. Try again shortly.' }
});

function requireSourceId(value) {
    const sourceId = Number(value);
    return Number.isSafeInteger(sourceId) && sourceId > 0 ? sourceId : null;
}

function contentTypes(value) {
    if (value === 'movies') return ['movie'];
    if (value === 'series') return ['series'];
    if (value === 'channels' || value === 'live' || value === undefined) return ['live'];
    return null;
}

function setVisibilityDefault(db, sourceId, type, isHidden) {
    db.prepare(`
        INSERT INTO content_visibility_defaults (source_id, type, is_hidden)
        VALUES (?, ?, ?)
        ON CONFLICT(source_id, type) DO UPDATE SET is_hidden = excluded.is_hidden
    `).run(sourceId, type, isHidden ? 1 : 0);
}

// Helper to map API item types to DB types and tables
function mapItemType(apiType) {
    switch (apiType) {
        case 'channel': return { table: 'playlist_items', type: 'live' };
        case 'group': return { table: 'categories', type: 'live' };
        case 'vod_category': return { table: 'categories', type: 'movie' };
        case 'series_category': return { table: 'categories', type: 'series' };
        case 'movie': return { table: 'playlist_items', type: 'movie' };
        case 'series': return { table: 'playlist_items', type: 'series' };
        default: return null;
    }
}

// Get all hidden items (formatted like db.json for frontend compatibility)
router.get('/hidden', async (req, res) => {
    try {
        const { sourceId } = req.query;
        const db = getDb();

        let hidden = [];
        const resultFormat = (row, itemType) => ({
            source_id: row.source_id,
            item_type: itemType,
            item_id: itemType.includes('category') || itemType === 'group' ? row.category_id : row.item_id
        });

        // Query Categories
        let catQuery = `SELECT source_id, category_id, type FROM categories WHERE is_hidden = 1`;
        let itemQuery = `SELECT source_id, item_id, type FROM playlist_items WHERE is_hidden = 1`;

        const params = [];
        if (sourceId) {
            catQuery += ` AND source_id = ?`;
            itemQuery += ` AND source_id = ?`;
            const sid = parseInt(sourceId);
            params.push(sid);
        }

        const hiddenCats = db.prepare(catQuery).all(...params);
        const hiddenItems = db.prepare(itemQuery).all(...params);

        hiddenCats.forEach(row => {
            let apiType;
            if (row.type === 'live') apiType = 'group';
            else if (row.type === 'movie') apiType = 'vod_category';
            else if (row.type === 'series') apiType = 'series_category';

            if (apiType) hidden.push(resultFormat(row, apiType));
        });

        hiddenItems.forEach(row => {
            let apiType;
            if (row.type === 'live') apiType = 'channel';
            else if (row.type === 'movie') apiType = 'movie';
            else if (row.type === 'series') apiType = 'series';

            if (apiType) hidden.push(resultFormat(row, apiType));
        });

        res.json(hidden);
    } catch (err) {
        console.error('Error getting hidden items:', err);
        res.status(500).json({ error: 'Failed to get hidden items' });
    }
});

// Hide item
router.post('/hide', auth.requireAdmin, async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.body;
        const mapping = mapItemType(itemType);

        if (!mapping) return res.status(400).json({ error: 'Invalid item type' });

        const db = getDb();
        const idCol = mapping.table === 'categories' ? 'category_id' : 'item_id';

        const stmt = db.prepare(`
            UPDATE ${mapping.table} 
            SET is_hidden = 1 
            WHERE source_id = ? AND type = ? AND ${idCol} = ?
        `);

        stmt.run(sourceId, mapping.type, itemId);

        res.json({ success: true });
    } catch (err) {
        console.error('Error hiding item:', err);
        res.status(500).json({ error: 'Failed to hide item' });
    }
});

// Show item
router.post('/show', auth.requireAdmin, async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.body;
        const mapping = mapItemType(itemType);

        if (!mapping) return res.status(400).json({ error: 'Invalid item type' });

        const db = getDb();
        const idCol = mapping.table === 'categories' ? 'category_id' : 'item_id';

        const stmt = db.prepare(`
            UPDATE ${mapping.table} 
            SET is_hidden = 0 
            WHERE source_id = ? AND type = ? AND ${idCol} = ?
        `);

        stmt.run(sourceId, mapping.type, itemId);

        res.json({ success: true });
    } catch (err) {
        console.error('Error showing item:', err);
        res.status(500).json({ error: 'Failed to show item' });
    }
});

// Check hidden status
router.get('/hidden/check', async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.query;
        const mapping = mapItemType(itemType);
        if (!mapping) return res.json({ hidden: false });

        const db = getDb();
        const idCol = mapping.table === 'categories' ? 'category_id' : 'item_id';

        const row = db.prepare(`
            SELECT is_hidden FROM ${mapping.table} 
            WHERE source_id = ? AND type = ? AND ${idCol} = ?
        `).get(sourceId, mapping.type, itemId);

        res.json({ hidden: !!(row && row.is_hidden) });
    } catch (err) {
        console.error('Error checking hidden:', err);
        res.status(500).json({ error: 'Failed to check status' });
    }
});

// Bulk Hide
router.post('/hide/bulk', auth.requireAdmin, async (req, res) => {
    try {
        const { items } = req.body;
        if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });

        const db = getDb();

        // Prepare statements once
        const hideCat = db.prepare('UPDATE categories SET is_hidden = 1 WHERE source_id = ? AND type = ? AND category_id = ?');
        const hideItem = db.prepare('UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND type = ? AND item_id = ?');

        // Cascading statements (hide all children of a category)
        const hideCatChildren = db.prepare('UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND type = ? AND category_id = ?');

        const runBulk = db.transaction((list) => {
            for (const item of list) {
                const mapping = mapItemType(item.itemType);
                if (mapping) {
                    if (mapping.table === 'categories') {
                        // Hide the category
                        hideCat.run(item.sourceId, mapping.type, item.itemId);
                        // Cascade to children
                        hideCatChildren.run(item.sourceId, mapping.type, item.itemId);
                    } else {
                        // Hide individual item
                        hideItem.run(item.sourceId, mapping.type, item.itemId);
                    }
                }
            }
        });

        runBulk(items);
        res.json({ success: true, count: items.length });
    } catch (err) {
        if (err.code === 'SQLITE_BUSY') {
            return res.status(503).json({ error: 'Database is busy, please try again' });
        }
        console.error('Error bulk hide:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

// Bulk Show
router.post('/show/bulk', auth.requireAdmin, async (req, res) => {
    try {
        const { items } = req.body;
        if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });

        const db = getDb();

        // Prepare statements once
        const showCat = db.prepare('UPDATE categories SET is_hidden = 0 WHERE source_id = ? AND type = ? AND category_id = ?');
        const showItem = db.prepare('UPDATE playlist_items SET is_hidden = 0 WHERE source_id = ? AND type = ? AND item_id = ?');

        // Cascading statements (show all children of a category)
        const showCatChildren = db.prepare('UPDATE playlist_items SET is_hidden = 0 WHERE source_id = ? AND type = ? AND category_id = ?');

        const runBulk = db.transaction((list) => {
            for (const item of list) {
                const mapping = mapItemType(item.itemType);
                if (mapping) {
                    if (mapping.table === 'categories') {
                        // Show the category
                        showCat.run(item.sourceId, mapping.type, item.itemId);
                        // Cascade to children
                        showCatChildren.run(item.sourceId, mapping.type, item.itemId);
                    } else {
                        // Show individual item
                        showItem.run(item.sourceId, mapping.type, item.itemId);
                    }
                }
            }
        });

        runBulk(items);
        res.json({ success: true, count: items.length });
    } catch (err) {
        if (err.code === 'SQLITE_BUSY') {
            return res.status(503).json({ error: 'Database is busy, please try again' });
        }
        console.error('Error bulk show:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

// Show ALL items for a source (single SQL statement - much faster than bulk)
router.post('/show/all', auth.requireAdmin, async (req, res) => {
    try {
        const { contentType } = req.body;
        const sourceId = requireSourceId(req.body.sourceId);
        const types = contentTypes(contentType);
        if (!sourceId) return res.status(400).json({ error: 'Valid sourceId required' });
        if (!types) return res.status(400).json({ error: 'Invalid contentType' });

        const db = getDb();
        let catCount = 0;
        let itemCount = 0;

        db.transaction(() => {
            for (const type of types) {
                setVisibilityDefault(db, sourceId, type, false);
                const catResult = db.prepare(`UPDATE categories SET is_hidden = 0 WHERE source_id = ? AND type = ?`).run(sourceId, type);
                const itemResult = db.prepare(`UPDATE playlist_items SET is_hidden = 0 WHERE source_id = ? AND type = ?`).run(sourceId, type);
                catCount += catResult.changes;
                itemCount += itemResult.changes;
            }
        })();

        console.log('[Channels] Show all completed:', { sourceId, contentType: types[0], catCount, itemCount });
        res.json({ success: true, categoriesUpdated: catCount, itemsUpdated: itemCount });
    } catch (err) {
        console.error('Error show all:', err);
        res.status(500).json({ error: 'Failed to show all' });
    }
});

// Hide ALL items for a source (single SQL statement - much faster than bulk)
router.post('/hide/all', auth.requireAdmin, async (req, res) => {
    try {
        const { contentType } = req.body;
        const sourceId = requireSourceId(req.body.sourceId);
        const types = contentTypes(contentType);
        if (!sourceId) return res.status(400).json({ error: 'Valid sourceId required' });
        if (!types) return res.status(400).json({ error: 'Invalid contentType' });

        const db = getDb();
        let catCount = 0;
        let itemCount = 0;

        db.transaction(() => {
            for (const type of types) {
                setVisibilityDefault(db, sourceId, type, true);
                const catResult = db.prepare(`UPDATE categories SET is_hidden = 1 WHERE source_id = ? AND type = ?`).run(sourceId, type);
                const itemResult = db.prepare(`UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND type = ?`).run(sourceId, type);
                catCount += catResult.changes;
                itemCount += itemResult.changes;
            }
        })();

        console.log('[Channels] Hide all completed:', { sourceId, contentType: types[0], catCount, itemCount });
        res.json({ success: true, categoriesUpdated: catCount, itemsUpdated: itemCount });
    } catch (err) {
        console.error('Error hide all:', err);
        res.status(500).json({ error: 'Failed to hide all' });
    }
});

// Apply a whole-source visibility state with a bounded set of exceptions.
// This keeps large providers on a constant-size database path instead of
// issuing one update for every channel.
router.post('/visibility/apply', auth.requireAdmin, async (req, res) => {
    try {
        const { contentType, visible, overrides = [] } = req.body;
        const sourceId = requireSourceId(req.body.sourceId);
        const types = contentTypes(contentType);

        if (!sourceId) return res.status(400).json({ error: 'Valid sourceId required' });
        if (!types) return res.status(400).json({ error: 'Invalid contentType' });
        if (typeof visible !== 'boolean') return res.status(400).json({ error: 'visible must be true or false' });
        if (!Array.isArray(overrides) || overrides.length > 10000) {
            return res.status(400).json({ error: 'overrides must contain at most 10000 items' });
        }

        const normalizedOverrides = overrides.map(override => {
            const mapping = mapItemType(override?.itemType);
            const itemId = typeof override?.itemId === 'string' || Number.isSafeInteger(override?.itemId)
                ? String(override.itemId)
                : '';
            if (!mapping || !types.includes(mapping.type) || !itemId || typeof override.hidden !== 'boolean') {
                const error = new Error('Invalid visibility override');
                error.statusCode = 400;
                throw error;
            }
            return { mapping, itemId, hidden: override.hidden };
        });

        const db = getDb();
        const apply = db.transaction(() => {
            const baselineHidden = visible ? 0 : 1;
            let categoriesUpdated = 0;
            let itemsUpdated = 0;

            for (const type of types) {
                setVisibilityDefault(db, sourceId, type, baselineHidden);
                categoriesUpdated += db.prepare(
                    'UPDATE categories SET is_hidden = ? WHERE source_id = ? AND type = ?'
                ).run(baselineHidden, sourceId, type).changes;
                itemsUpdated += db.prepare(
                    'UPDATE playlist_items SET is_hidden = ? WHERE source_id = ? AND type = ?'
                ).run(baselineHidden, sourceId, type).changes;
            }

            const updateCategory = db.prepare(
                'UPDATE categories SET is_hidden = ? WHERE source_id = ? AND type = ? AND category_id = ?'
            );
            const updateCategoryItems = db.prepare(
                'UPDATE playlist_items SET is_hidden = ? WHERE source_id = ? AND type = ? AND category_id = ?'
            );
            const updateItem = db.prepare(
                'UPDATE playlist_items SET is_hidden = ? WHERE source_id = ? AND type = ? AND item_id = ?'
            );
            const getItemCategory = db.prepare(
                'SELECT category_id FROM playlist_items WHERE source_id = ? AND type = ? AND item_id = ?'
            );
            const categoryHasVisibleItems = db.prepare(`
                SELECT 1 FROM playlist_items
                WHERE source_id = ? AND type = ? AND category_id = ? AND is_hidden = 0
                LIMIT 1
            `);
            const touchedCategories = new Map();

            // Category overrides run first so a later item override can refine
            // one channel inside an otherwise uniform category.
            for (const override of normalizedOverrides.filter(value => value.mapping.table === 'categories')) {
                const hidden = override.hidden ? 1 : 0;
                categoriesUpdated += updateCategory.run(
                    hidden, sourceId, override.mapping.type, override.itemId
                ).changes;
                itemsUpdated += updateCategoryItems.run(
                    hidden, sourceId, override.mapping.type, override.itemId
                ).changes;
            }
            for (const override of normalizedOverrides.filter(value => value.mapping.table === 'playlist_items')) {
                const category = getItemCategory.get(sourceId, override.mapping.type, override.itemId);
                itemsUpdated += updateItem.run(
                    override.hidden ? 1 : 0,
                    sourceId,
                    override.mapping.type,
                    override.itemId
                ).changes;
                if (category?.category_id) {
                    touchedCategories.set(
                        `${override.mapping.type}:${category.category_id}`,
                        { type: override.mapping.type, categoryId: category.category_id }
                    );
                }
            }

            // Only categories affected by individual item exceptions need to
            // be derived again. Whole-source and category operations already
            // established every other category state.
            for (const { type, categoryId } of touchedCategories.values()) {
                const hasVisibleItems = Boolean(
                    categoryHasVisibleItems.get(sourceId, type, categoryId)
                );
                categoriesUpdated += updateCategory.run(
                    hasVisibleItems ? 0 : 1,
                    sourceId,
                    type,
                    categoryId
                ).changes;
            }

            return { categoriesUpdated, itemsUpdated };
        });

        const result = apply();
        console.log('[Channels] Visibility applied:', {
            sourceId,
            contentType: types[0],
            visible,
            overrideCount: normalizedOverrides.length
        });
        res.json({ success: true, ...result, overrideCount: normalizedOverrides.length });
    } catch (err) {
        if (err.statusCode === 400) return res.status(400).json({ error: err.message });
        if (err.code === 'SQLITE_BUSY') {
            return res.status(503).json({ error: 'Database is busy, please try again' });
        }
        console.error('Error applying visibility:', err);
        res.status(500).json({ error: 'Failed to apply visibility' });
    }
});

// Get recent movies or series
router.get('/recent', limitRecentContent, async (req, res) => {
    try {
        const { type, limit = 12 } = req.query;
        if (!type || (type !== 'movie' && type !== 'series')) {
            return res.status(400).json({ error: 'Valid type (movie or series) is required' });
        }

        const boundedLimit = parseBoundedInteger(limit, {
            name: 'limit',
            defaultValue: 12,
            min: 1,
            max: 100
        });
        const db = getDb();
        const recentItems = db.prepare(`
            SELECT * FROM playlist_items p
            WHERE p.type = ? 
              AND p.is_hidden = 0
              AND NOT EXISTS (
                  SELECT 1 FROM categories c 
                  WHERE c.source_id = p.source_id 
                    AND c.category_id = p.category_id 
                    AND c.type = p.type 
                    AND c.is_hidden = 1
              )
            ORDER BY p.added_at DESC
            LIMIT ?
        `).all(type, boundedLimit);

        // Parse JSON data for each item
        const formatted = recentItems.map(item => ({
            ...item,
            data: JSON.parse(item.data)
        }));

        res.json(formatted);
    } catch (err) {
        if (err.statusCode === 400) {
            return res.status(400).json({ error: err.message });
        }
        console.error('Error getting recent items:', err);
        res.status(500).json({ error: 'Failed to get recent items' });
    }
});

module.exports = router;

