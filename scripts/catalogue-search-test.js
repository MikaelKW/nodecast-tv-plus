const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-catalogue-search-'));
process.env.NODECAST_DATA_DIR = testRoot;

const { getDb } = require('../server/db/sqlite');
const { getLiveChannelPage } = require('../server/services/catalogueService');

function run() {
    const db = getDb();
    const insertCategory = db.prepare(`
        INSERT INTO categories (id, source_id, category_id, type, name)
        VALUES (?, 1, ?, 'live', ?)
    `);
    const insertChannel = db.prepare(`
        INSERT INTO playlist_items
            (id, source_id, item_id, type, name, category_id, data)
        VALUES (?, 1, ?, 'live', ?, ?, '{}')
    `);

    insertCategory.run('1:norway', 'norway', 'Norway');
    insertCategory.run('1:sweden', 'sweden', 'Sweden');
    db.transaction(() => {
        for (let index = 0; index < 135; index += 1) {
            const itemId = `norway-${String(index).padStart(3, '0')}`;
            insertChannel.run(`1:${itemId}`, itemId, `Channel ${index}`, 'norway');
        }
        insertChannel.run('1:sweden-norway', 'sweden-norway', 'Norway News', 'sweden');
    })();

    const firstPage = getLiveChannelPage(1, { query: 'norway', limit: 50 });
    assert.equal(firstPage.items.length, 50);
    assert.equal(firstPage.hasMore, true);
    assert.deepEqual(firstPage.matchGroups, [
        { name: 'Norway', count: 135 },
        { name: 'Sweden', count: 1 }
    ]);

    const secondPage = getLiveChannelPage(1, {
        query: 'norway',
        cursor: firstPage.nextCursor,
        limit: 50
    });
    assert.equal(secondPage.items.length, 50);
    assert.equal(secondPage.matchGroups, undefined);

    db.close();
    console.log('Catalogue search test passed.');
}

try {
    run();
} finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
}
