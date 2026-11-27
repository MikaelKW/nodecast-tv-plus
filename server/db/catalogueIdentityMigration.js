'use strict';

const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const MIGRATION_NAME = 'catalogue-content-type-identities-v1';
const TABLES = [
    { table: 'categories', providerId: 'category_id', index: 'idx_categories_legacy_identity' },
    { table: 'playlist_items', providerId: 'item_id', index: 'idx_items_legacy_identity' }
];

function checkpointCatalogue(db, logger) {
    const previousTimeout = db.pragma('busy_timeout', { simple: true });
    try {
        // Reclamation must not add an unbounded wait behind another reader.
        db.pragma('busy_timeout = 250');
        const result = db.pragma('wal_checkpoint(TRUNCATE)')[0];
        if (result.busy) {
            logger.warn('[SQLite] Catalogue WAL cleanup deferred because the database is busy. The committed migration remains valid.');
            return false;
        }
        return true;
    } catch (error) {
        if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') {
            logger.warn('[SQLite] Catalogue WAL cleanup deferred because the database is busy. The committed migration remains valid.');
            return false;
        }
        // Disk/I/O failures are not equivalent to a busy reader. The key
        // transaction has committed, but preparation must report this failure.
        logger.warn('[SQLite] Catalogue keys were committed, but WAL cleanup failed.');
        throw error;
    } finally {
        db.pragma(`busy_timeout = ${previousTimeout}`);
    }
}

function migrateCatalogueIdentities(db, { logger = console } = {}) {
    const start = performance.now();
    let announced = false;
    const announce = () => {
        if (!announced) {
            logger.log('[SQLite] Updating catalogue storage. This can take a few minutes on large catalogues.');
            announced = true;
        }
    };
    const result = { converted: 0, duplicatesRemoved: 0 };
    db.transaction(() => {
        const indexCount = db.prepare(`SELECT count(*) AS count FROM sqlite_schema
            WHERE type = 'index' AND name IN (?, ?)`).get(...TABLES.map(entry => entry.index)).count;
        if (indexCount !== TABLES.length) {
            announce();
            for (const { table, providerId, index } of TABLES) {
                // Only legacy rows occupy this index. Old releases also keep
                // it up to date when they write old-format keys after rollback.
                db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(id)
                    WHERE id <> source_id || ':' || type || ':' || ${providerId}`);
            }
        }
        for (const { table, providerId } of TABLES) {
            const legacy = `id <> source_id || ':' || type || ':' || ${providerId}`;
            if (!db.prepare(`SELECT 1 FROM ${table} WHERE ${legacy} LIMIT 1`).get()) continue;
            announce();
            // Matching key text alone is insufficient: an old provider ID
            // containing a colon can occupy another row's future key. Only a
            // genuinely canonical copy of the same logical record wins.
            result.duplicatesRemoved += db.prepare(`DELETE FROM ${table} AS old
                WHERE old.id <> old.source_id || ':' || old.type || ':' || old.${providerId}
                  AND EXISTS (SELECT 1 FROM ${table} AS canonical
                      WHERE canonical.id = old.source_id || ':' || old.type || ':' || old.${providerId}
                        AND canonical.source_id = old.source_id
                        AND canonical.type = old.type
                        AND canonical.${providerId} = old.${providerId})`).run().changes;
            const prefix = `catalogue-migration:${randomUUID()}:`;
            const upper = prefix + '\uffff';
            if (db.prepare(`SELECT 1 FROM ${table} WHERE id >= ? AND id < ? LIMIT 1`).get(prefix, upper)) {
                throw new Error('Temporary catalogue migration identity already exists');
            }
            // Move remaining legacy rows aside before assigning final keys.
            // Every other field, including explicit hide/show state, survives.
            result.converted += db.prepare(`UPDATE ${table} SET id = ? || rowid WHERE ${legacy}`).run(prefix).changes;
            db.prepare(`UPDATE ${table} SET id = source_id || ':' || type || ':' || ${providerId}
                WHERE id >= ? AND id < ?`).run(prefix, upper);
        }
        if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(MIGRATION_NAME)) {
            announce();
            db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(MIGRATION_NAME, Date.now());
        }
    }).immediate();

    // This is outside the transaction, and also retries deferred cleanup on a
    // later clean startup. It does not shrink the main database file.
    result.checkpointComplete = checkpointCatalogue(db, logger);
    if (announced) logger.log(`[SQLite] Catalogue storage update done in ${((performance.now() - start) / 1000).toFixed(2)} seconds.`);
    return result;
}

module.exports = { migrateCatalogueIdentities, MIGRATION_NAME };
