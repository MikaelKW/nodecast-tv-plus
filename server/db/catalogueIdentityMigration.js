'use strict';

const { randomUUID } = require('node:crypto');
const MIGRATION_NAME = 'catalogue-content-type-identities-v1';

function migrateCatalogueIdentities(db) {
    db.transaction(() => {
        if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(MIGRATION_NAME)) return;
        // Moving the affected IDs aside first also handles provider IDs such as
        // "live:77", whose old storage key can equal another row's new key.
        // Only the internal key changes. Original type/provider ID, flags and
        // metadata survive byte-for-byte, including already-corrupted metadata
        // that needs a provider refresh rather than a guessed reconstruction.
        const prefix = `catalogue-migration:${randomUUID()}:`;
        if (db.prepare('SELECT 1 FROM playlist_items WHERE substr(id, 1, ?) = ?').get(prefix.length, prefix)
            || db.prepare('SELECT 1 FROM categories WHERE substr(id, 1, ?) = ?').get(prefix.length, prefix)) {
            throw new Error('Temporary catalogue migration identity already exists');
        }
        db.prepare(`
            UPDATE categories SET id = ? || rowid
            WHERE id <> source_id || ':' || type || ':' || category_id
        `).run(prefix);
        db.prepare(`
            UPDATE categories SET id = source_id || ':' || type || ':' || category_id
            WHERE substr(id, 1, ?) = ?
        `).run(prefix.length, prefix);
        db.prepare(`
            UPDATE playlist_items SET id = ? || rowid
            WHERE id <> source_id || ':' || type || ':' || item_id
        `).run(prefix);
        db.prepare(`
            UPDATE playlist_items SET id = source_id || ':' || type || ':' || item_id
            WHERE substr(id, 1, ?) = ?
        `).run(prefix.length, prefix);
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(MIGRATION_NAME, Date.now());
    }).immediate();
}

module.exports = { migrateCatalogueIdentities, MIGRATION_NAME };
