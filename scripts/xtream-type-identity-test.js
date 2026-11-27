const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

// Xtream providers number live streams, movies, series and each category list
// independently. These fixtures reuse provider ID 1901 and category ID 19
// across all three content types.
const provider = {
    liveCategories: [
        { category_id: '19', category_name: 'Sports Group', parent_id: 0 },
        { category_id: '20', category_name: 'News Group', parent_id: 0 }
    ],
    live: [
        { num: 1, stream_id: 1901, name: 'News Channel', category_id: '20', epg_channel_id: 'news.example' },
        { num: 2, stream_id: 1903, name: 'Sports Channel', category_id: '19' }
    ],
    movieCategories: [{ category_id: '19', category_name: 'Movie Group', parent_id: 0 }],
    movies: [
        { stream_id: 1901, name: 'Feature Film', category_id: '19', container_extension: 'mp4' },
        { stream_id: 1902, name: 'Documentary', category_id: '19', container_extension: 'mkv' }
    ],
    seriesCategories: [
        { category_id: '19', category_name: 'Series Group', parent_id: 0 },
        { category_id: '21', category_name: 'Kids Group', parent_id: 0 }
    ],
    series: [
        { series_id: 1901, name: 'Drama Series', category_id: '19', cover: 'https://example.test/drama.png' },
        { series_id: 1902, name: 'Comedy Series', category_id: '21', cover: 'https://example.test/comedy.png' }
    ]
};

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-xtream-type-identity-test-'));
process.env.NODECAST_DATA_DIR = testDataDir;

// ------------------------------------------------------------------
// A v2.7.2 database: same schema, `sourceId:providerId` keys, and the
// v2.7.2 upserts that let a later content type overwrite an earlier one.
// ------------------------------------------------------------------
const legacyDb = new Database(path.join(testDataDir, 'content.db'));
legacyDb.exec(`
    CREATE TABLE categories (
        id TEXT PRIMARY KEY,
        source_id INTEGER NOT NULL,
        category_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_id TEXT,
        is_hidden INTEGER DEFAULT 0,
        data JSON
    );
    CREATE TABLE playlist_items (
        id TEXT PRIMARY KEY,
        source_id INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        category_id TEXT,
        parent_id TEXT,
        stream_icon TEXT,
        stream_url TEXT,
        container_extension TEXT,
        channel_number REAL,
        rating REAL,
        year TEXT,
        added_at TEXT,
        is_hidden INTEGER DEFAULT 0,
        is_favorite INTEGER DEFAULT 0,
        data JSON
    );
    CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES ('backfill-live-channel-number-v1', 1);
    INSERT INTO schema_migrations VALUES ('backfill-m3u-stream-url-column-v1', 1);
    CREATE TABLE content_visibility_defaults (
        source_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
        PRIMARY KEY (source_id, type)
    );
    CREATE TABLE favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        source_id INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        item_type TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, source_id, item_id, item_type)
    );
    CREATE TABLE watch_history (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        source_id INTEGER,
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        parent_id TEXT,
        progress INTEGER DEFAULT 0,
        duration INTEGER DEFAULT 0,
        updated_at INTEGER NOT NULL,
        data JSON
    );
`);

function legacySaveCategories(db, sourceId, type, categories) {
    const stmt = db.prepare(`
        INSERT INTO categories (id, source_id, category_id, type, name, parent_id, is_hidden, data)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            data = excluded.data
    `);
    for (const cat of categories) {
        stmt.run(`${sourceId}:${cat.category_id}`, sourceId, String(cat.category_id), type,
            cat.category_name, cat.parent_id || null, JSON.stringify(cat));
    }
}

function legacySaveStreams(db, sourceId, type, items) {
    const stmt = db.prepare(`
        INSERT INTO playlist_items (
            id, source_id, item_id, type, name, category_id,
            stream_icon, stream_url, container_extension,
            rating, year, added_at, is_hidden, channel_number, data
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            category_id = excluded.category_id,
            stream_icon = excluded.stream_icon,
            stream_url = excluded.stream_url,
            container_extension = excluded.container_extension,
            channel_number = excluded.channel_number,
            data = excluded.data
    `);
    for (const item of items) {
        const itemId = type === 'series' ? item.series_id : item.stream_id;
        stmt.run(`${sourceId}:${itemId}`, sourceId, String(itemId), type, item.name, String(item.category_id),
            item.stream_icon || item.cover || null, item.stream_url || null, item.container_extension || null,
            null, null, null, item.num ?? null, JSON.stringify(item));
    }
}

function legacyXtreamSync(db, sourceId) {
    legacySaveCategories(db, sourceId, 'live', provider.liveCategories);
    legacySaveStreams(db, sourceId, 'live', provider.live);
    legacySaveCategories(db, sourceId, 'movie', provider.movieCategories);
    legacySaveStreams(db, sourceId, 'movie', provider.movies);
    legacySaveCategories(db, sourceId, 'series', provider.seriesCategories);
    legacySaveStreams(db, sourceId, 'series', provider.series);
}

// Source 1 is the upgraded Xtream source, source 2 a legacy M3U source.
legacyXtreamSync(legacyDb, 1);
legacySaveStreams(legacyDb, 2, 'live', [{ stream_id: 'm3u-abc', name: 'M3U Channel', category_id: 'Local' }]);
legacySaveCategories(legacyDb, 2, 'live', [{ category_id: 'Local', category_name: 'Local' }]);
legacyDb.prepare(`
    INSERT INTO playlist_items (id, source_id, item_id, type, name, data)
    VALUES ('1:epg_channel:news.example', 1, 'news.example', 'epg_channel', 'News Channel', '{}')
`).run();

// The v2.7.2 overwrite: one row per provider ID, the first type and the
// last synchronized metadata.
assert.deepEqual(
    legacyDb.prepare("SELECT id, type, name FROM playlist_items WHERE source_id = 1 AND type <> 'epg_channel' ORDER BY id").all(),
    [
        { id: '1:1901', type: 'live', name: 'Drama Series' },
        { id: '1:1902', type: 'movie', name: 'Comedy Series' },
        { id: '1:1903', type: 'live', name: 'Sports Channel' }
    ],
    'The fixture reproduces the v2.7.2 collision'
);

// Saved user state recorded by v2.7.2.
legacyDb.exec(`
    UPDATE playlist_items SET is_hidden = 1 WHERE id = '1:1903';
    UPDATE categories SET is_hidden = 1 WHERE id = '1:19';
    UPDATE playlist_items SET is_hidden = 1 WHERE id = '2:m3u-abc';
    INSERT INTO favorites (user_id, source_id, item_id, item_type, created_at) VALUES
        (1, 1, '1901', 'channel', '2026-01-01 00:00:00'),
        (1, 1, '1901', 'movie', '2026-01-01 00:00:01'),
        (1, 1, '1902', 'series', '2026-01-01 00:00:02'),
        (2, 2, 'm3u-abc', 'channel', '2026-01-01 00:00:03');
    INSERT INTO content_visibility_defaults (source_id, type, is_hidden) VALUES (1, 'series', 0), (2, 'live', 1);
    INSERT INTO watch_history (id, user_id, source_id, item_type, item_id, progress, duration, updated_at, data)
        VALUES ('1:1901', 1, 1, 'movie', '1901', 120, 6000, 1, '{"title":"Feature Film","sourceId":1}');
`);
const savedReferences = db => ({
    favorites: db.prepare('SELECT * FROM favorites ORDER BY id').all(),
    visibilityDefaults: db.prepare('SELECT * FROM content_visibility_defaults ORDER BY source_id, type').all(),
    // Watch history references provider IDs, not catalogue keys. Its own
    // record key is migrated separately (#583), so it is not compared here.
    watchHistory: db.prepare(`
        SELECT user_id, source_id, item_type, item_id, progress, duration, updated_at, data
        FROM watch_history
        ORDER BY user_id, source_id, item_type, item_id
    `).all()
});
const legacyReferences = savedReferences(legacyDb);
const legacyItemCount = legacyDb.prepare('SELECT COUNT(*) AS count FROM playlist_items').get().count;
const legacyCategoryCount = legacyDb.prepare('SELECT COUNT(*) AS count FROM categories').get().count;
legacyDb.close();

const sqlite = require('../server/db/sqlite');
const { getDb, initSchema, favorites, buildCatalogueKey } = sqlite;
const syncService = require('../server/services/syncService');
const { getLiveChannel } = require('../server/services/catalogueService');

async function syncXtream(sourceId, order = ['live', 'movie', 'series'], data = provider) {
    const steps = {
        live: async () => {
            await syncService.saveCategories(sourceId, 'live', data.liveCategories);
            await syncService.saveStreams(sourceId, 'live', data.live);
        },
        movie: async () => {
            await syncService.saveCategories(sourceId, 'movie', data.movieCategories);
            await syncService.saveStreams(sourceId, 'movie', data.movies);
        },
        series: async () => {
            await syncService.saveCategories(sourceId, 'series', data.seriesCategories);
            await syncService.saveStreams(sourceId, 'series', data.series);
        }
    };
    for (const type of order) await steps[type]();
}

function catalogue(db, sourceId) {
    return {
        items: db.prepare(`
            SELECT id, type, item_id, name, category_id
            FROM playlist_items
            WHERE source_id = ? AND type <> 'epg_channel'
            ORDER BY type, item_id
        `).all(sourceId),
        categories: db.prepare(`
            SELECT id, type, category_id, name
            FROM categories
            WHERE source_id = ?
            ORDER BY type, category_id
        `).all(sourceId)
    };
}

function expectedCatalogue(sourceId) {
    const item = (type, itemId, name, categoryId) => ({
        id: `${sourceId}:${type}:${itemId}`, type, item_id: itemId, name, category_id: categoryId
    });
    const category = (type, categoryId, name) => ({
        id: `${sourceId}:${type}:${categoryId}`, type, category_id: categoryId, name
    });
    return {
        items: [
            item('live', '1901', 'News Channel', '20'),
            item('live', '1903', 'Sports Channel', '19'),
            item('movie', '1901', 'Feature Film', '19'),
            item('movie', '1902', 'Documentary', '19'),
            item('series', '1901', 'Drama Series', '19'),
            item('series', '1902', 'Comedy Series', '21')
        ],
        categories: [
            category('live', '19', 'Sports Group'),
            category('live', '20', 'News Group'),
            category('movie', '19', 'Movie Group'),
            category('series', '19', 'Series Group'),
            category('series', '21', 'Kids Group')
        ]
    };
}

const hiddenState = (db, table, id) => db.prepare(`SELECT is_hidden FROM ${table} WHERE id = ?`).get(id)?.is_hidden;
const legacyKeyCount = db => db.prepare(`
    SELECT
        (SELECT COUNT(*) FROM playlist_items
         WHERE id <> CAST(source_id AS TEXT) || ':' || type || ':' || item_id)
      + (SELECT COUNT(*) FROM categories
         WHERE id <> CAST(source_id AS TEXT) || ':' || type || ':' || category_id) AS count
`).get().count;
const fullSnapshot = db => ({
    items: db.prepare('SELECT * FROM playlist_items ORDER BY id').all(),
    categories: db.prepare('SELECT * FROM categories ORDER BY id').all(),
    references: savedReferences(db)
});

async function run() {
    const db = getDb();

    // ---------- Upgrade from v2.7.2 ----------
    assert.equal(buildCatalogueKey(1, 'live', 1901), '1:live:1901');
    assert.equal(legacyKeyCount(db), 0, 'Every catalogue row is rekeyed on upgrade');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playlist_items').get().count, legacyItemCount);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM categories').get().count, legacyCategoryCount);
    assert.deepEqual(
        db.prepare('SELECT id FROM playlist_items ORDER BY id').all().map(row => row.id),
        ['1:epg_channel:news.example', '1:live:1901', '1:live:1903', '1:movie:1902', '2:live:m3u-abc']
    );
    assert.deepEqual(
        db.prepare('SELECT id FROM categories ORDER BY id').all().map(row => row.id),
        ['1:live:19', '1:live:20', '1:series:21', '2:live:Local']
    );
    assert.equal(hiddenState(db, 'playlist_items', '1:live:1903'), 1, 'Hidden items stay hidden');
    assert.equal(hiddenState(db, 'playlist_items', '2:live:m3u-abc'), 1, 'Hidden M3U items stay hidden');
    assert.equal(hiddenState(db, 'categories', '1:live:19'), 1, 'Hidden categories stay hidden');
    assert.deepEqual(savedReferences(db), legacyReferences, 'Favourites, visibility defaults and history are untouched');

    // Repeating the migration on every start changes nothing.
    const migrated = fullSnapshot(db);
    initSchema();
    assert.deepEqual(fullSnapshot(db), migrated, 'The migration is idempotent');

    // An older release started on the upgraded database writes legacy keys
    // again. The next start keeps the typed rows and their saved state.
    legacySaveStreams(db, 1, 'live', provider.live);
    legacySaveCategories(db, 1, 'live', provider.liveCategories);
    assert.ok(legacyKeyCount(db) > 0);
    initSchema();
    assert.equal(legacyKeyCount(db), 0, 'Legacy keys written after an upgrade are migrated again');
    assert.equal(hiddenState(db, 'playlist_items', '1:live:1903'), 1);
    assert.equal(hiddenState(db, 'categories', '1:live:19'), 1);
    assert.deepEqual(
        db.prepare("SELECT id FROM playlist_items WHERE source_id = 1 AND type = 'live' ORDER BY id").all().map(row => row.id),
        ['1:live:1901', '1:live:1903']
    );

    // Until the provider is synchronized again, the favourite still carries
    // the series metadata that v2.7.2 wrote over it, including the series
    // category ID that happens to match the hidden live group.
    assert.deepEqual(
        db.prepare("SELECT name, category_id FROM playlist_items WHERE id = '1:live:1901'").get(),
        { name: 'Drama Series', category_id: '19' }
    );
    assert.deepEqual(favorites.getVisibleChannels(1), []);

    // ---------- Re-synchronization restores overwritten entries ----------
    await syncXtream(1);
    assert.deepEqual(catalogue(db, 1), expectedCatalogue(1), 'Re-sync restores every type and category');
    assert.equal(hiddenState(db, 'playlist_items', '1:live:1903'), 1, 'Re-sync keeps hidden items');
    assert.equal(hiddenState(db, 'categories', '1:live:19'), 1, 'Re-sync keeps hidden categories');
    assert.equal(hiddenState(db, 'categories', '1:movie:19'), 0, 'A hidden live category does not hide movies');
    assert.equal(hiddenState(db, 'categories', '1:series:19'), 0, 'A hidden live category does not hide series');
    assert.deepEqual(savedReferences(db), legacyReferences);
    const [favouriteChannel] = favorites.getVisibleChannels(1);
    assert.equal(favouriteChannel.name, 'News Channel', 'The favourite resolves to the restored live channel');
    assert.equal(favouriteChannel.category_name, 'News Group');
    assert.equal(getLiveChannel(1, '1901').name, 'News Channel');
    assert.equal(getLiveChannel(1, '1903'), null, 'The hidden live channel stays hidden');

    // ---------- Both import orders, repeated sync, separate sources ----------
    await syncXtream(10, ['live', 'movie', 'series']);
    await syncXtream(11, ['series', 'movie', 'live']);
    await syncXtream(12, ['movie', 'series', 'live']);
    for (const sourceId of [10, 11, 12]) {
        assert.deepEqual(catalogue(db, sourceId), expectedCatalogue(sourceId), `Import order for source ${sourceId}`);
    }
    for (let i = 0; i < 2; i += 1) {
        await syncXtream(10, ['series', 'live', 'movie']);
        await syncXtream(11, ['live', 'series', 'movie']);
    }
    for (const sourceId of [1, 10, 11, 12]) {
        assert.deepEqual(catalogue(db, sourceId), expectedCatalogue(sourceId), `Repeated sync for source ${sourceId}`);
    }

    // Visibility changes address one type only.
    db.prepare("UPDATE playlist_items SET is_hidden = 1 WHERE source_id = 10 AND type = 'movie' AND item_id = '1901'").run();
    db.prepare("UPDATE categories SET is_hidden = 1 WHERE source_id = 10 AND type = 'series' AND category_id = '19'").run();
    await syncXtream(10);
    assert.deepEqual(
        db.prepare('SELECT id, is_hidden FROM playlist_items WHERE source_id = 10 AND item_id = ? ORDER BY id').all('1901'),
        [
            { id: '10:live:1901', is_hidden: 0 },
            { id: '10:movie:1901', is_hidden: 1 },
            { id: '10:series:1901', is_hidden: 0 }
        ]
    );
    assert.deepEqual(
        db.prepare('SELECT id, is_hidden FROM categories WHERE source_id = 10 AND category_id = ? ORDER BY id').all('19'),
        [
            { id: '10:live:19', is_hidden: 0 },
            { id: '10:movie:19', is_hidden: 0 },
            { id: '10:series:19', is_hidden: 1 }
        ]
    );

    // Stale cleanup removes only the type being synchronized.
    await syncXtream(11, ['movie'], { ...provider, movies: provider.movies.filter(movie => movie.stream_id !== 1901) });
    assert.deepEqual(
        db.prepare('SELECT id FROM playlist_items WHERE source_id = 11 AND item_id = ? ORDER BY id').all('1901').map(row => row.id),
        ['11:live:1901', '11:series:1901'],
        'Purging a removed movie keeps the live channel and series with its ID'
    );
    assert.deepEqual(catalogue(db, 12), expectedCatalogue(12), 'Other sources are unaffected');

    console.log('Xtream content-type identity test passed.');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    try { getDb().close(); } catch { /* already closed */ }
    fs.rmSync(testDataDir, { recursive: true, force: true });
});
