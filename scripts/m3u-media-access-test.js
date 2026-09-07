const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-m3u-media-access-'));
process.env.NODECAST_DATA_DIR = testRoot;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'm3u-media-access-jwt-secret-for-tests-only';
process.env.SESSION_SECRET = 'm3u-media-access-session-secret-for-tests-only';

const playlistOrigin = 'https://playlist.example.test';
const legacyStreamUrl = 'https://media.example.test/live/legacy-channel.m3u8';
const freshStreamUrl = 'https://cdn.example.test/live/fresh-channel.m3u8';
const updatedStreamUrl = 'https://edge.example.test/live/fresh-channel.m3u8';

fs.writeFileSync(path.join(testRoot, 'db.json'), JSON.stringify({
    sources: [{
        id: 1,
        name: 'Cross-origin M3U test',
        type: 'm3u',
        url: `${playlistOrigin}/channels.m3u`,
        enabled: true,
        contentVisibility: { live: true, movies: false, series: false }
    }],
    hiddenItems: [],
    favorites: [],
    settings: {},
    users: [],
    nextId: 2
}));

const legacyDb = new Database(path.join(testRoot, 'content.db'));
legacyDb.exec(`
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
        rating REAL,
        year TEXT,
        added_at TEXT,
        is_hidden INTEGER DEFAULT 0,
        is_favorite INTEGER DEFAULT 0,
        data JSON
    );
`);
legacyDb.prepare(`
    INSERT INTO playlist_items
        (id, source_id, item_id, type, name, category_id, stream_url, data)
    VALUES (?, ?, ?, 'live', ?, ?, NULL, ?)
`).run(
    '1:legacy',
    1,
    'legacy',
    'Legacy cross-origin channel',
    'Test',
    JSON.stringify({ stream_url: legacyStreamUrl })
);
legacyDb.close();

const { getDb } = require('../server/db/sqlite');
const { isConfiguredMediaUrl } = require('../server/services/mediaAccess');
const syncService = require('../server/services/syncService');

async function run() {
    try {
        assert.equal(
            await isConfiguredMediaUrl(legacyStreamUrl),
            true,
            'A cross-origin M3U URL stored by an earlier release must remain authorized.'
        );

        assert.equal(
            getDb().prepare('SELECT stream_url FROM playlist_items WHERE id = ?').get('1:legacy').stream_url,
            legacyStreamUrl,
            'Existing M3U catalogue records must be backfilled into the indexed URL column.'
        );
        assert.equal(
            getDb().prepare(`
                SELECT COUNT(*) AS count
                FROM schema_migrations
                WHERE name = 'backfill-m3u-stream-url-column-v1'
            `).get().count,
            1,
            'The existing-catalogue backfill must be recorded as a one-time migration.'
        );
        const lookupPlan = getDb().prepare(`
            EXPLAIN QUERY PLAN
            SELECT 1 FROM playlist_items WHERE stream_url = ? LIMIT 1
        `).all(legacyStreamUrl).map(step => step.detail).join(' ');
        assert.match(
            lookupPlan,
            /idx_items_stream_url/,
            'Media authorization must use the indexed URL lookup for large catalogues.'
        );

        await syncService.saveStreams(1, 'live', [{
            stream_id: 'fresh',
            name: 'Fresh cross-origin channel',
            category_id: 'Test',
            stream_icon: null,
            stream_url: freshStreamUrl
        }], { skipPurge: true });

        assert.equal(
            getDb().prepare('SELECT stream_url FROM playlist_items WHERE id = ?').get('1:fresh').stream_url,
            freshStreamUrl,
            'A newly synchronized M3U URL must be stored in the indexed URL column.'
        );
        assert.equal(await isConfiguredMediaUrl(freshStreamUrl), true);

        await syncService.saveStreams(1, 'live', [{
            stream_id: 'fresh',
            name: 'Fresh cross-origin channel',
            category_id: 'Test',
            stream_icon: null,
            stream_url: updatedStreamUrl
        }], { skipPurge: true });

        assert.equal(
            getDb().prepare('SELECT stream_url FROM playlist_items WHERE id = ?').get('1:fresh').stream_url,
            updatedStreamUrl,
            'A changed M3U URL must replace the previously synchronized URL.'
        );
        assert.equal(await isConfiguredMediaUrl(updatedStreamUrl), true);
        assert.equal(await isConfiguredMediaUrl(freshStreamUrl), false);

        console.log('M3U media access tests passed.');
    } finally {
        try { getDb().close(); } catch {}
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
