const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.NODECAST_DATA_DIR
    ? path.resolve(process.env.NODECAST_DATA_DIR)
    : path.join(__dirname, '..', '..', 'data');
const dbPath = path.join(dataDir, 'content.db');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let db;

function getDb() {
    if (!db) {
        console.log('[SQLite] Opening database at', dbPath);
        db = new Database(dbPath);
        // Optimize performance
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        initSchema();
    }
    return db;
}

function initSchema() {
    if (!db) throw new Error('Database not initialized');

    // Categories (Groups)
    db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY, -- Composite key: sourceId:categoryId
            source_id INTEGER NOT NULL,
            category_id TEXT NOT NULL,
            type TEXT NOT NULL, -- 'live', 'movie', 'series'
            name TEXT NOT NULL,
            parent_id TEXT, -- For nested categories
            is_hidden INTEGER DEFAULT 0,
            data JSON -- Extra provider data
        );
        CREATE INDEX IF NOT EXISTS idx_categories_source_type ON categories(source_id, type);
        CREATE INDEX IF NOT EXISTS idx_categories_source_type_category
            ON categories(source_id, type, category_id);
    `);

    // Playlist Items (Channels, Movies, Series, Episodes)
    db.exec(`
        CREATE TABLE IF NOT EXISTS playlist_items (
            id TEXT PRIMARY KEY, -- Composite key: sourceId:itemId
            source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL, -- Original ID from provider
            type TEXT NOT NULL, -- 'live', 'movie', 'series', 'episode'
            name TEXT NOT NULL,
            category_id TEXT, -- maps to categories.category_id (not our composite id)
            parent_id TEXT, -- For episodes -> series_id
            
            -- Common Media Fields
            stream_icon TEXT,
            stream_url TEXT, -- Direct link if available
            container_extension TEXT,
            
            -- VOD/Series Specific
            rating REAL,
            year TEXT,
            added_at TEXT,
            
            -- App State
            is_hidden INTEGER DEFAULT 0,
            is_favorite INTEGER DEFAULT 0,
            
            data JSON -- Full original JSON object
        );
        CREATE INDEX IF NOT EXISTS idx_items_source_type ON playlist_items(source_id, type);
        CREATE INDEX IF NOT EXISTS idx_items_category ON playlist_items(source_id, category_id);
        CREATE INDEX IF NOT EXISTS idx_items_source_type_item
            ON playlist_items(source_id, type, item_id);
        CREATE INDEX IF NOT EXISTS idx_items_source_type_category_hidden
            ON playlist_items(source_id, type, category_id, is_hidden);
        CREATE INDEX IF NOT EXISTS idx_items_source_type_hidden_name
            ON playlist_items(source_id, type, is_hidden, name COLLATE NOCASE, item_id);
        CREATE INDEX IF NOT EXISTS idx_items_source_type_category_hidden_name
            ON playlist_items(source_id, type, category_id, is_hidden, name COLLATE NOCASE, item_id);
    `);

    // EPG Programs
    // Optimized for range queries
    db.exec(`
        CREATE TABLE IF NOT EXISTS epg_programs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT NOT NULL, -- matches playlist_items.id if possible, or mapping key
            source_id INTEGER NOT NULL,
            start_time INTEGER NOT NULL, -- Unix timestamp (ms)
            end_time INTEGER NOT NULL,   -- Unix timestamp (ms)
            title TEXT,
            description TEXT,
            data JSON
        );
        CREATE INDEX IF NOT EXISTS idx_epg_channel_time ON epg_programs(channel_id, start_time, end_time);
        CREATE INDEX IF NOT EXISTS idx_epg_cleanup ON epg_programs(end_time); -- For deleting old programs
        CREATE INDEX IF NOT EXISTS idx_epg_source_start
            ON epg_programs(source_id, start_time, end_time, channel_id, title);
    `);

    // Sync Status
    db.exec(`
        CREATE TABLE IF NOT EXISTS sync_status (
            source_id INTEGER NOT NULL,
            type TEXT NOT NULL, -- 'live', 'vod', 'series', 'epg'
            last_sync INTEGER NOT NULL,
            status TEXT, -- 'success', 'error', 'syncing'
            error TEXT,
            PRIMARY KEY (source_id, type)
        );
    `);

    // Default visibility for content discovered during later provider syncs.
    // This preserves a staged "hide all" or "show all" choice when a large
    // playlist adds or renumbers items after the choice was saved.
    db.exec(`
        CREATE TABLE IF NOT EXISTS content_visibility_defaults (
            source_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
            PRIMARY KEY (source_id, type)
        );
    `);

    // Monotonic source revisions let clients invalidate compact catalogue
    // summaries and pages without downloading the full catalogue first.
    db.exec(`
        CREATE TABLE IF NOT EXISTS catalogue_revisions (
            source_id INTEGER PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
    `);

    // User Favorites (per-user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            item_type TEXT NOT NULL, -- 'channel', 'movie', 'series'
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, source_id, item_id, item_type)
        );
        CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
        CREATE INDEX IF NOT EXISTS idx_favorites_user_type ON favorites(user_id, item_type);
    `);

    // Watch History (per-user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS watch_history (
            id TEXT PRIMARY KEY, -- Composite key: user_id:item_id
            user_id INTEGER NOT NULL,
            source_id INTEGER, -- Source ID for Xtream/M3U
            item_type TEXT NOT NULL, -- 'movie', 'episode'
            item_id TEXT NOT NULL, -- The original item ID (stream_id or composite)
            parent_id TEXT, -- For episodes (series ID)
            progress INTEGER DEFAULT 0, -- Current position in seconds
            duration INTEGER DEFAULT 0, -- Total duration in seconds
            updated_at INTEGER NOT NULL, -- Timestamp
            data JSON -- Snapshot of item data (title, poster, etc)
        );
        CREATE INDEX IF NOT EXISTS idx_history_user_updated ON watch_history(user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_history_user_item ON watch_history(user_id, item_id);
    `);

    // Migration: Add source_id column if missing (for existing databases)
    try {
        db.exec(`ALTER TABLE watch_history ADD COLUMN source_id INTEGER`);
        console.log('[SQLite] Added source_id column to watch_history');
    } catch (e) {
        // Column already exists, ignore
    }

    console.log('[SQLite] Schema initialized');
}

// ============================================================
// Favorites CRUD Operations
// ============================================================
const favorites = {
    getAll(userId, sourceId = null, itemType = null) {
        const db = getDb();
        let sql = 'SELECT * FROM favorites WHERE user_id = ?';
        const params = [userId];

        if (sourceId) {
            sql += ' AND source_id = ?';
            params.push(sourceId);
        }
        if (itemType) {
            sql += ' AND item_type = ?';
            params.push(itemType);
        }

        sql += ' ORDER BY created_at DESC';
        return db.prepare(sql).all(...params);
    },

    add(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO favorites (user_id, source_id, item_id, item_type)
            VALUES (?, ?, ?, ?)
        `);
        const result = stmt.run(userId, sourceId, itemId, itemType);
        return result.changes > 0;
    },

    remove(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        const stmt = db.prepare(`
            DELETE FROM favorites 
            WHERE user_id = ? AND source_id = ? AND item_id = ? AND item_type = ?
        `);
        const result = stmt.run(userId, sourceId, itemId, itemType);
        return result.changes > 0;
    },

    isFavorite(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        const row = db.prepare(`
            SELECT 1 FROM favorites 
            WHERE user_id = ? AND source_id = ? AND item_id = ? AND item_type = ?
        `).get(userId, sourceId, itemId, itemType);
        return !!row;
    },

    // Get all favorites for a user, grouped by type (for bulk checks)
    getAllAsSet(userId) {
        const db = getDb();
        const rows = db.prepare('SELECT source_id, item_id, item_type FROM favorites WHERE user_id = ?').all(userId);
        const set = new Set();
        for (const row of rows) {
            set.add(`${row.source_id}:${row.item_id}:${row.item_type}`);
        }
        return set;
    },

    getVisibleChannels(userId, limit = 100) {
        const db = getDb();
        const favoriteRows = db.prepare(`
            SELECT
                f.id AS favorite_id,
                f.source_id,
                f.item_id AS favorite_item_id
            FROM favorites f
            WHERE f.user_id = ?
              AND f.item_type = 'channel'
            ORDER BY f.created_at DESC, f.id DESC
            LIMIT ?
        `).all(userId, limit);
        const resolveChannel = db.prepare(`
            SELECT
                p.item_id,
                p.name,
                p.category_id,
                p.stream_icon,
                p.stream_url,
                p.data,
                c.name AS category_name
            FROM playlist_items p
            LEFT JOIN categories c
                ON c.source_id = p.source_id
               AND c.type = p.type
               AND c.category_id = p.category_id
            WHERE p.source_id = ?
              AND p.type = 'live'
              AND p.item_id = ?
              AND p.is_hidden = 0
              AND COALESCE(c.is_hidden, 0) = 0
            LIMIT 1
        `);
        const channels = [];

        for (const favorite of favoriteRows) {
            const compositePrefixes = [
                `m3u_${favorite.source_id}_`,
                `xtream_${favorite.source_id}_`
            ];
            const candidates = [String(favorite.favorite_item_id)];
            for (const prefix of compositePrefixes) {
                if (candidates[0].startsWith(prefix)) {
                    candidates.push(candidates[0].slice(prefix.length));
                }
            }

            let channel = null;
            for (const itemId of candidates) {
                channel = resolveChannel.get(favorite.source_id, itemId);
                if (channel) break;
            }
            if (!channel) continue;

            channels.push({
                favorite_id: favorite.favorite_id,
                source_id: favorite.source_id,
                ...channel
            });
        }

        return channels;
    }
};

const catalogueRevisions = {
    get(sourceId) {
        const row = getDb().prepare(
            'SELECT revision, updated_at FROM catalogue_revisions WHERE source_id = ?'
        ).get(sourceId);
        return row || { revision: 0, updated_at: null };
    },

    bump(sourceId) {
        const now = Date.now();
        getDb().prepare(`
            INSERT INTO catalogue_revisions (source_id, revision, updated_at)
            VALUES (?, 1, ?)
            ON CONFLICT(source_id) DO UPDATE SET
                revision = catalogue_revisions.revision + 1,
                updated_at = excluded.updated_at
        `).run(sourceId, now);
        return this.get(sourceId);
    },

    remove(sourceId) {
        return getDb().prepare(
            'DELETE FROM catalogue_revisions WHERE source_id = ?'
        ).run(sourceId).changes > 0;
    }
};

module.exports = {
    getDb,
    initSchema,
    favorites,
    catalogueRevisions
};
