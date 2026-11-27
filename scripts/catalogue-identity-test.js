'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const Database = require('better-sqlite3');
const { catalogueId } = require('../server/services/catalogueIdentity');
const { migrateCatalogueIdentities, MIGRATION_NAME } = require('../server/db/catalogueIdentityMigration');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-catalogue-identity-'));
process.env.NODECAST_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = randomBytes(48).toString('hex');
process.env.SESSION_SECRET = randomBytes(48).toString('hex');

const { getDb, initSchema, favorites } = require('../server/db/sqlite');
const sync = require('../server/services/syncService');
const catalogue = require('../server/services/catalogueService');
const { M3uXtreamAdapter } = require('../server/services/m3uXtreamAdapter');

function snapshot(db, table) {
    return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function referenceSnapshot(db, table) {
    const rows = snapshot(db, table);
    // #583 migrates the independent history record key during schema startup.
    // All provider references, progress, metadata and other fields stay equal.
    return table === 'watch_history' ? rows.map(({ id, ...record }) => record) : rows;
}

function checkMigration(db) {
    // Rebuild a legacy-key state on an otherwise complete schema. Include IDs
    // containing colons so a one-pass UPDATE would encounter a PK conflict.
    db.prepare('DELETE FROM schema_migrations WHERE name = ?').run(MIGRATION_NAME);
    const insert = db.prepare(`INSERT INTO playlist_items
        (id, source_id, item_id, type, name, category_id, is_hidden, is_favorite, stream_url, data)
        VALUES (?, 40, ?, 'live', ?, '5', ?, 1, 'https://example.test/live', ?)`);
    insert.run('40:77', '77', 'Hidden live', 1, '{"stream_id":77,"name":"Hidden live"}');
    insert.run('40:live:77', 'live:77', 'Colon ID', 0, '{"stream_id":"live:77"}');
    db.prepare(`INSERT INTO playlist_items (id,source_id,item_id,type,name,data)
        VALUES ('40:epg_channel:77',40,'77','epg_channel','Guide','{}')`).run();
    const category = db.prepare(`INSERT INTO categories
        (id, source_id, category_id, type, name, is_hidden, data) VALUES (?,40,?,'live',?,1,'{}')`);
    category.run('40:5', '5', 'Hidden category');
    category.run('40:live:5', 'live:5', 'Colon category');
    db.prepare("INSERT INTO content_visibility_defaults VALUES (40,'live',1)").run();
    favorites.add(1, 40, '77', 'channel');
    db.prepare(`INSERT INTO watch_history
        (id,user_id,source_id,item_type,item_id,progress,duration,updated_at,data)
        VALUES ('1:77',1,40,'movie','77',120,1000,123,'{}')`).run();
    db.prepare(`INSERT INTO epg_programs (channel_id,source_id,start_time,end_time,title)
        VALUES ('40:77',40,1,2,'Provider channel ID that resembles a storage ID')`).run();

    const itemsBefore = snapshot(db, 'playlist_items');
    const categoriesBefore = snapshot(db, 'categories');
    const references = ['favorites', 'watch_history', 'content_visibility_defaults', 'epg_programs'];
    const before = references.map(table => referenceSnapshot(db, table));
    const historyBefore = snapshot(db, 'watch_history');

    // Both tables and the marker must roll back on failure. No half-rekeyed DB.
    db.exec(`CREATE TRIGGER fail_identity_update BEFORE UPDATE OF id ON playlist_items
        BEGIN SELECT RAISE(ABORT, 'Synthetic migration failure'); END`);
    assert.throws(() => migrateCatalogueIdentities(db), /Synthetic migration failure/);
    assert.deepEqual(snapshot(db, 'categories'), categoriesBefore);
    assert.deepEqual(snapshot(db, 'playlist_items'), itemsBefore);
    assert.equal(db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(MIGRATION_NAME), undefined);
    db.exec('DROP TRIGGER fail_identity_update');

    // The catalogue migration itself leaves even the history key untouched.
    migrateCatalogueIdentities(db);
    assert.deepEqual(snapshot(db, 'watch_history'), historyBefore);

    // Exercise the real schema initialization path, not only the helper.
    initSchema();
    const expectedItems = itemsBefore.map(row => ({ ...row, id: catalogueId(row.source_id, row.type, row.item_id) }));
    const expectedCategories = categoriesBefore.map(row => ({ ...row, id: catalogueId(row.source_id, row.type, row.category_id) }));
    assert.deepEqual(snapshot(db, 'playlist_items'), expectedItems);
    assert.deepEqual(snapshot(db, 'categories'), expectedCategories);
    assert.deepEqual(references.map(table => referenceSnapshot(db, table)), before);
    const migrationTime = db.prepare('SELECT applied_at FROM schema_migrations WHERE name=?').get(MIGRATION_NAME).applied_at;
    initSchema();
    assert.deepEqual(snapshot(db, 'playlist_items'), expectedItems);
    assert.deepEqual(snapshot(db, 'categories'), expectedCategories);
    assert.equal(db.prepare('SELECT applied_at FROM schema_migrations WHERE name=?').get(MIGRATION_NAME).applied_at, migrationTime);
    return { before, references };
}

function item(type, id = 77) {
    return type === 'series'
        ? { series_id: id, name: `Synthetic ${type}`, category_id: 5, cover: 'https://example.test/series.png' }
        : { stream_id: id, name: `Synthetic ${type}`, category_id: 5, stream_icon: 'https://example.test/item.png', container_extension: 'mp4' };
}

async function checkImports(db) {
    for (const [source, order] of [[1, ['live', 'movie', 'series']], [2, ['series', 'movie', 'live']]]) {
        for (const type of order) {
            await sync.saveCategories(source, type, [{ category_id: 5, category_name: `Category ${type}` }]);
            await sync.saveStreams(source, type, [item(type)]);
        }
        const result = db.prepare('SELECT id,item_id,type,name,category_id,data FROM playlist_items WHERE source_id=? ORDER BY type').all(source);
        assert.equal(result.length, 3);
        for (const row of result) {
            assert.equal(row.id, catalogueId(source, row.type, '77'));
            assert.equal(row.name, `Synthetic ${row.type}`);
            assert.equal(JSON.parse(row.data).name, row.name);
        }
        assert.deepEqual(db.prepare('SELECT type,name FROM categories WHERE source_id=? ORDER BY type').all(source),
            ['live', 'movie', 'series'].map(type => ({ type, name: `Category ${type}` })));

        const live = catalogue.getLiveChannel(source, '77');
        assert.equal(live.name, 'Synthetic live');
        assert.equal(live.stream_id, '77');
        assert.equal(live.category_name, 'Category live');
        assert.equal(catalogue.getLiveSummary(source).totalChannels, 1);

        db.prepare("UPDATE playlist_items SET is_hidden=1 WHERE source_id=? AND type='movie'").run(source);
        db.prepare("UPDATE categories SET is_hidden=1 WHERE source_id=? AND type='series'").run(source);
        for (const type of order) {
            await sync.saveCategories(source, type, [{ category_id: 5, category_name: `Updated ${type}` }]);
            await sync.saveStreams(source, type, [{ ...item(type), name: `Updated ${type}` }]);
        }
        assert.equal(db.prepare("SELECT is_hidden FROM playlist_items WHERE source_id=? AND type='movie'").get(source).is_hidden, 1);
        assert.equal(db.prepare("SELECT is_hidden FROM categories WHERE source_id=? AND type='series'").get(source).is_hidden, 1);
        await sync.saveStreams(source, 'live', [item('live', 88)]);
        assert.equal(db.prepare("SELECT count(*) n FROM playlist_items WHERE source_id=? AND type IN ('movie','series')").get(source).n, 2);
        assert.equal(db.prepare("SELECT item_id FROM playlist_items WHERE source_id=? AND type='live'").get(source).item_id, '88');
    }

    // A previously overwritten legacy live row remains live and keeps its
    // hiding state during migration; a provider re-sync repairs its metadata.
    db.prepare(`INSERT INTO playlist_items (id,source_id,item_id,type,name,is_hidden,data)
        VALUES ('6:live:77',6,'77','live','Wrong series metadata',1,'{"series_id":77}')`).run();
    for (const type of ['live', 'movie', 'series']) await sync.saveStreams(6, type, [item(type)]);
    assert.equal(db.prepare("SELECT name FROM playlist_items WHERE id='6:live:77'").get().name, 'Synthetic live');
    assert.equal(db.prepare("SELECT is_hidden FROM playlist_items WHERE id='6:live:77'").get().is_hidden, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM playlist_items WHERE source_id=6').get().n, 3);

    // M3U URL resolution must not pick another type's equal provider ID.
    await sync.saveStreams(7, 'movie', [{ ...item('movie'), stream_url: 'https://example.test/movie' }]);
    await sync.saveStreams(7, 'live', [{ ...item('live'), stream_url: 'https://example.test/live' }]);
    const adapter = new M3uXtreamAdapter(7);
    assert.equal(adapter.buildStreamUrl('77'), 'https://example.test/live');
    assert.equal(adapter.getLiveStreams()[0].stream_id, 77);
    assert.equal(adapter.buildStreamUrl('77', 'series'), null);
}

async function run() {
    const db = getDb();
    try {
        const retained = checkMigration(db);
        await checkImports(db);
        await sync.saveCategories(40, 'live', [{ category_id: 5, category_name: 'Refreshed hidden category' }]);
        await sync.saveStreams(40, 'live', [item('live'), { ...item('live', 'live:77'), name: 'Colon ID' }, item('live', 99)]);
        assert.equal(db.prepare("SELECT is_hidden FROM playlist_items WHERE id='40:live:77'").get().is_hidden, 1);
        assert.equal(db.prepare("SELECT is_hidden FROM categories WHERE id='40:live:5'").get().is_hidden, 1);
        assert.equal(db.prepare("SELECT is_hidden FROM playlist_items WHERE id='40:live:live:77'").get().is_hidden, 0);
        assert.equal(db.prepare("SELECT is_hidden FROM playlist_items WHERE id='40:live:99'").get().is_hidden, 1);
        assert.deepEqual(retained.references.map(table => referenceSnapshot(db, table)), retained.before);
        console.log('Catalogue content-type identities, migration rollback/idempotence, retained state and sync regression tests passed.');
    } finally {
        db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
