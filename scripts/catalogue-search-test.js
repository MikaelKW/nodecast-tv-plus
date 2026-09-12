const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-catalogue-search-'));
process.env.NODECAST_DATA_DIR = testRoot;

const { getDb } = require('../server/db/sqlite');
const { getLiveChannelPage, getLiveChannel } = require('../server/services/catalogueService');
const { parseExtinf } = require('../server/services/m3uParser');

function run() {
    const db = getDb();
    const insertCategory = db.prepare(`
        INSERT INTO categories (id, source_id, category_id, type, name)
        VALUES (?, 1, ?, 'live', ?)
    `);
    const insertChannel = db.prepare(`
        INSERT INTO playlist_items
            (id, source_id, item_id, type, name, category_id, channel_number, data)
        VALUES (?, 1, ?, 'live', ?, ?, ?, '{}')
    `);

    assert.equal(
        parseExtinf('#EXTINF:-1 tvg-id="one" tvg-chno="12.5" group-title="Test",Channel One').tvgChno,
        '12.5'
    );

    insertCategory.run('1:norway', 'norway', 'Norway');
    insertCategory.run('1:sweden', 'sweden', 'Sweden');
    db.transaction(() => {
        for (let index = 0; index < 135; index += 1) {
            const itemId = `norway-${String(index).padStart(3, '0')}`;
            insertChannel.run(`1:${itemId}`, itemId, `Channel ${index}`, 'norway', index + 10);
        }
        insertChannel.run('1:norway-unnumbered-a', 'norway-unnumbered-a', 'AAA Unnumbered', 'norway', null);
        insertChannel.run('1:norway-unnumbered-z', 'norway-unnumbered-z', 'ZZZ Unnumbered', 'norway', null);
        insertChannel.run('1:sweden-norway', 'sweden-norway', 'Norway News', 'sweden', null);
    })();

    const firstPage = getLiveChannelPage(1, { query: 'norway', limit: 50 });
    assert.equal(firstPage.items.length, 50);
    assert.equal(firstPage.hasMore, true);
    assert.deepEqual(firstPage.matchGroups, [
        { name: 'Norway', count: 137 },
        { name: 'Sweden', count: 1 }
    ]);

    const secondPage = getLiveChannelPage(1, {
        query: 'norway',
        cursor: firstPage.nextCursor,
        limit: 50
    });
    assert.equal(secondPage.items.length, 50);
    assert.equal(secondPage.matchGroups, undefined);

    const numberedPage = getLiveChannelPage(1, { categoryId: 'norway', sort: 'number', limit: 50 });
    assert.equal(numberedPage.sort, 'number');
    assert.deepEqual(numberedPage.items.slice(0, 3).map(item => item.channel_number), [10, 11, 12]);
    const numberedSecondPage = getLiveChannelPage(1, {
        categoryId: 'norway',
        sort: 'number',
        cursor: numberedPage.nextCursor,
        limit: 50
    });
    assert.deepEqual(numberedSecondPage.items.slice(0, 2).map(item => item.channel_number), [60, 61]);
    let numberedCursor = numberedSecondPage.nextCursor;
    let numberedTail = numberedSecondPage.items;
    while (numberedCursor) {
        const page = getLiveChannelPage(1, {
            categoryId: 'norway',
            sort: 'number',
            cursor: numberedCursor,
            limit: 50
        });
        numberedTail = page.items;
        numberedCursor = page.nextCursor;
    }
    assert.deepEqual(
        numberedTail.slice(-2).map(item => [item.name, item.channel_number]),
        [['AAA Unnumbered', null], ['ZZZ Unnumbered', null]]
    );
    assert.throws(
        () => getLiveChannelPage(1, { sort: 'unsupported' }),
        /sort must be either name or number/
    );
    assert.equal(
        getLiveChannelPage(1, { query: 'norway', includeGroupCounts: false }).matchGroups,
        undefined
    );

    const rememberedChannel = getLiveChannel(1, 'norway-000');
    assert.equal(rememberedChannel.stream_id, 'norway-000');
    assert.equal(rememberedChannel.name, 'Channel 0');
    assert.equal(rememberedChannel.category_name, 'Norway');
    assert.equal(rememberedChannel.channel_number, 10);
    assert.equal(getLiveChannel(1, 'missing-channel'), null);
    assert.throws(() => getLiveChannel(1, ''), /Valid channel itemId required/);

    db.prepare("UPDATE playlist_items SET is_hidden = 1 WHERE source_id = 1 AND item_id = 'norway-000'").run();
    assert.equal(getLiveChannel(1, 'norway-000'), null);

    db.close();
    console.log('Catalogue search test passed.');
}

try {
    run();
} finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
}
