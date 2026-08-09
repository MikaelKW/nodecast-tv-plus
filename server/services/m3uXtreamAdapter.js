/**
 * M3U Xtream Adapter
 * 
 * Makes M3U sources respond to Xtream-style API methods.
 * Queries data from SQLite (already synced during source refresh).
 */

const { getDb } = require('../db/sqlite');

class M3uXtreamAdapter {
    constructor(sourceId) {
        this.sourceId = sourceId;
    }

    /**
     * Get live categories (groups) for this M3U source.
     * Returns Xtream-compatible format: [{ category_id, category_name, parent_id }]
     */
    getLiveCategories(includeHidden = false) {
        const db = getDb();

        // M3U stores group name in category_id field of playlist_items
        // We need to aggregate unique groups with counts
        let query = `
            SELECT 
                category_id,
                category_id as category_name,
                NULL as parent_id,
                CASE WHEN SUM(CASE WHEN is_hidden = 0 THEN 1 ELSE 0 END) > 0 THEN 0 ELSE 1 END as is_hidden,
                COUNT(*) as channel_count
            FROM playlist_items 
            WHERE source_id = ? AND type = 'live'
            ${!includeHidden ? 'AND is_hidden = 0' : ''}
            GROUP BY category_id
            ORDER BY category_id ASC
        `;

        const rows = db.prepare(query).all(this.sourceId);

        return rows.map(row => ({
            category_id: row.category_id || 'Uncategorized',
            category_name: row.category_id || 'Uncategorized',
            parent_id: null,
            is_hidden: row.is_hidden,
            // Bonus: include count for lazy-loading UI
            channel_count: row.channel_count
        }));
    }

    /**
     * Get live streams (channels), optionally filtered by category.
     * Returns Xtream-compatible format: [{ stream_id, name, stream_icon, category_id, ... }]
     */
    getLiveStreams(categoryId = null, includeHidden = false) {
        const db = getDb();

        let query = `
            SELECT 
                item_id as stream_id,
                name,
                stream_icon,
                stream_url,
                category_id,
                is_hidden,
                added_at,
                data
            FROM playlist_items 
            WHERE source_id = ? AND type = 'live'
            ${!includeHidden ? 'AND is_hidden = 0' : ''}
        `;

        const params = [this.sourceId];

        if (categoryId) {
            query += ` AND category_id = ?`;
            params.push(categoryId);
        }

        query += ` ORDER BY name ASC`;

        const rows = db.prepare(query).all(...params);

        return rows.map(row => {
            // Parse any extra data stored as JSON
            let extra = {};
            if (row.data) {
                try { extra = JSON.parse(row.data); } catch (e) { }
            }

            return {
                stream_id: row.stream_id,
                name: row.name,
                stream_icon: row.stream_icon,
                category_id: row.category_id,
                is_hidden: row.is_hidden,
                added: row.added_at,
                // M3U-specific: direct stream URL (Xtream builds URLs from credentials)
                stream_url: row.stream_url,
                // Include extra fields from parser (tvgId, etc.)
                epg_channel_id: extra.tvgId || null,
                ...extra
            };
        });
    }

    /**
     * Build stream URL for playback.
     * For M3U, we return the stored URL directly (no credential building).
     */
    buildStreamUrl(streamId, type = 'live', container = 'ts') {
        const db = getDb();

        const row = db.prepare(`
            SELECT stream_url FROM playlist_items 
            WHERE source_id = ? AND item_id = ?
        `).get(this.sourceId, streamId);

        return row?.stream_url || null;
    }

    /**
     * Get XMLTV EPG URL - M3U sources don't have built-in EPG URLs.
     * Returns null; EPG must be configured as a separate source.
     */
    getXmltvUrl() {
        return null;
    }
}

/**
 * Factory function to create adapter from source ID
 */
function createFromSourceId(sourceId) {
    return new M3uXtreamAdapter(sourceId);
}

module.exports = { M3uXtreamAdapter, createFromSourceId };
