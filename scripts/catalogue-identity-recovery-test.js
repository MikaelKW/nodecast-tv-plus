'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateCatalogueIdentities, MIGRATION_NAME } = require('../server/db/catalogueIdentityMigration');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-catalogue-recovery-'));
const messages = [];
const logger = { log: text => messages.push(text), warn: text => messages.push(text) };
const db = new Database(path.join(root, 'content.db'));
let reader;
try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 1234');
    db.exec(`CREATE TABLE categories (id TEXT PRIMARY KEY,source_id INTEGER,type TEXT,category_id TEXT,is_hidden INTEGER,data TEXT);
        CREATE TABLE playlist_items (id TEXT PRIMARY KEY,source_id INTEGER,type TEXT,item_id TEXT,is_hidden INTEGER,data TEXT);
        CREATE TABLE schema_migrations (name TEXT PRIMARY KEY,applied_at INTEGER);`);
    migrateCatalogueIdentities(db, { logger });
    const appliedAt = db.prepare('SELECT applied_at FROM schema_migrations WHERE name=?').get(MIGRATION_NAME).applied_at;
    const category = db.prepare("INSERT INTO categories VALUES (?,50,'live',?,?,?)");
    category.run('50:live:10', '10', 1, 'canonical hidden');
    category.run('50:10', '10', 0, 'old default-visible duplicate');
    category.run('50:live:11', '11', 1, 'canonical explicitly shown later');
    category.run('50:11', '11', 0, 'old duplicate');
    category.run('50:live:12', '12', 0, 'canonical explicitly hidden later');
    category.run('50:12', '12', 0, 'old duplicate');
    // This is the same source/type/provider-ID selection used by 2.7.2's
    // visibility routes. An explicit action changes both category copies.
    db.exec("UPDATE categories SET is_hidden=0 WHERE source_id=50 AND type='live' AND category_id='11'");
    db.exec("UPDATE categories SET is_hidden=1 WHERE source_id=50 AND type='live' AND category_id='12'");
    db.exec(`INSERT INTO playlist_items VALUES
        ('50:77',50,'live','77',1,'hidden during downgrade'),
        ('50:78',50,'live','78',0,'shown during downgrade'),
        ('50:live:79',50,'live','79',1,'canonical duplicate'),
        ('50:79',50,'live','79',0,'old default duplicate'),
        ('51:77',51,'live','77',1,'colon neighbour'),
        ('51:live:77',51,'live','live:77',0,'colon provider ID');`);

    for (const [table, column, index] of [
        ['categories','category_id','idx_categories_legacy_identity'],
        ['playlist_items','item_id','idx_items_legacy_identity']
    ]) {
        const where = `id <> source_id || ':' || type || ':' || ${column}`;
        assert.match(db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).all().map(row => row.detail).join(' '), new RegExp(index));
        assert.ok(db.prepare(`SELECT count(*) AS count FROM ${table} INDEXED BY ${index} WHERE ${where}`).get().count > 0);
    }
    const beforeCategories = db.prepare('SELECT * FROM categories ORDER BY id').all();
    const beforeItems = db.prepare('SELECT * FROM playlist_items ORDER BY id').all();
    db.exec("CREATE TRIGGER fail_recovery BEFORE UPDATE OF id ON playlist_items BEGIN SELECT RAISE(ABORT,'Synthetic recovery failure'); END");
    assert.throws(() => migrateCatalogueIdentities(db, { logger }), /Synthetic recovery failure/);
    assert.deepEqual(db.prepare('SELECT * FROM categories ORDER BY id').all(), beforeCategories);
    assert.deepEqual(db.prepare('SELECT * FROM playlist_items ORDER BY id').all(), beforeItems);
    db.exec('DROP TRIGGER fail_recovery');

    const repaired = migrateCatalogueIdentities(db, { logger });
    assert.equal(repaired.duplicatesRemoved, 4);
    assert.equal(repaired.converted, 4);
    assert.deepEqual(db.prepare('SELECT id,is_hidden,data FROM categories ORDER BY category_id').all(), [
        { id:'50:live:10',is_hidden:1,data:'canonical hidden' },
        { id:'50:live:11',is_hidden:0,data:'canonical explicitly shown later' },
        { id:'50:live:12',is_hidden:1,data:'canonical explicitly hidden later' }
    ]);
    assert.deepEqual(db.prepare('SELECT item_id,is_hidden FROM playlist_items WHERE source_id=50 ORDER BY item_id').all(), [
        {item_id:'77',is_hidden:1},{item_id:'78',is_hidden:0},{item_id:'79',is_hidden:1}
    ]);
    assert.deepEqual(db.prepare('SELECT id,item_id FROM playlist_items WHERE source_id=51 ORDER BY item_id').all(), [
        {id:'51:live:77',item_id:'77'},{id:'51:live:live:77',item_id:'live:77'}
    ]);
    assert.equal(db.prepare('SELECT applied_at FROM schema_migrations WHERE name=?').get(MIGRATION_NAME).applied_at, appliedAt);
    messages.length = 0;
    assert.equal(migrateCatalogueIdentities(db, { logger }).converted, 0);
    assert.deepEqual(messages, [], 'A clean restart must not announce another conversion.');

    // A real reader holds an older WAL snapshot while the writer commits.
    // Busy reclamation is bounded and must not undo the completed conversion.
    db.prepare("INSERT INTO playlist_items VALUES ('52:9',52,'live','9',1,'retained')").run();
    reader = new Database(path.join(root, 'content.db'), { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM playlist_items').get();
    const busy = migrateCatalogueIdentities(db, { logger });
    assert.equal(busy.checkpointComplete, false);
    assert.ok(messages.some(message => message.includes('cleanup deferred')));
    assert.ok(messages.some(message => /done in \d+\.\d+ seconds/.test(message)));
    assert.equal(db.prepare("SELECT is_hidden FROM playlist_items WHERE id='52:live:9'").get().is_hidden, 1);
    assert.equal(db.pragma('busy_timeout', { simple: true }), 1234);
    reader.exec('ROLLBACK'); reader.close(); reader = undefined;
    assert.equal(migrateCatalogueIdentities(db, { logger }).checkpointComplete, true);
    const wal = path.join(root, 'content.db-wal');
    assert.equal(fs.existsSync(wal) ? fs.statSync(wal).size : 0, 0);

    const originalPragma = db.pragma;
    try {
        db.pragma = function (source, ...args) {
            if (source === 'wal_checkpoint(TRUNCATE)') {
                assert.equal(originalPragma.call(this, 'busy_timeout', { simple:true }), 250);
                throw Object.assign(new Error('Synthetic checkpoint failure'), { code:'SQLITE_IOERR' });
            }
            return originalPragma.call(this, source, ...args);
        };
        db.exec("INSERT INTO playlist_items VALUES ('53:9',53,'live','9',0,'committed before checkpoint')");
        assert.throws(() => migrateCatalogueIdentities(db, { logger }), error => error.code === 'SQLITE_IOERR');
        assert.equal(db.prepare("SELECT data FROM playlist_items WHERE id='53:live:9'").get().data, 'committed before checkpoint');
        assert.equal(db.pragma('busy_timeout', { simple:true }), 1234);
        assert.ok(messages.some(message => message.includes('keys were committed, but WAL cleanup failed')));
    } finally { db.pragma = originalPragma; }
    assert.equal(migrateCatalogueIdentities(db, { logger }).checkpointComplete, true);
    console.log('Catalogue recovery, canonical-duplicate visibility, indexed restart and post-commit checkpoint tests passed.');
} finally {
    if (reader?.open) { reader.exec('ROLLBACK'); reader.close(); }
    db.close();
    fs.rmSync(root, { recursive:true,force:true });
}
