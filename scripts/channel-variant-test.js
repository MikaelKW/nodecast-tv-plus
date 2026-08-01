const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-channel-variant-test-'));
process.env.NODECAST_DATA_DIR = testDataDir;

const m3uParser = require('../server/services/m3uParser');
const syncService = require('../server/services/syncService');
const { getDb } = require('../server/db/sqlite');

const playlist = `#EXTM3U
#EXTINF:-1 tvg-id="example.channel" group-title="Variant Test",Example 4K
https://streams.example.test/example-4k.m3u8
#EXTINF:-1 tvg-id="example.channel" group-title="Variant Test",Example FHD
https://streams.example.test/example-fhd.m3u8
#EXTINF:-1 tvg-id="example.channel" group-title="Variant Test",Example HD
https://streams.example.test/example-hd.m3u8
#EXTINF:-1 tvg-id="example.channel" group-title="Variant Test",Example
https://streams.example.test/example-sd.m3u8
`;

async function collectStreaming(input, batchSize) {
    const channels = [];
    for await (const batch of m3uParser.parseStreaming(input, batchSize)) {
        channels.push(...batch.channels);
    }
    return channels;
}

function assertVariants(channels) {
    assert.equal(channels.length, 4);
    assert.deepEqual(channels.map(channel => channel.name), [
        'Example 4K',
        'Example FHD',
        'Example HD',
        'Example'
    ]);
    assert.equal(new Set(channels.map(channel => channel.id)).size, 4);
    assert.equal(channels[0].id, 'example.channel');
    assert.ok(channels.slice(1).every(channel => channel.id.startsWith('example.channel__')));
    assert.ok(channels.every(channel => channel.tvgId === 'example.channel'));
}

async function main() {
    const parsed = await m3uParser.parse(playlist);
    const parsedAgain = await m3uParser.parse(playlist);
    const streamed = await collectStreaming(playlist, 2);

    assertVariants(parsed.channels);
    assertVariants(streamed);
    assert.deepEqual(
        parsed.channels.map(channel => channel.id),
        parsedAgain.channels.map(channel => channel.id),
        'M3U variant identifiers must remain stable for an unchanged playlist'
    );
    assert.deepEqual(
        parsed.channels.map(channel => channel.id),
        streamed.map(channel => channel.id),
        'streaming batches must not reset collision tracking'
    );

    const sourceId = 81;
    await syncService.saveStreams(sourceId, 'live', parsed.channels.map(channel => ({
        stream_id: channel.id,
        name: channel.name,
        category_id: channel.groupTitle,
        stream_url: channel.url,
        tvgId: channel.tvgId
    })));

    await syncService.saveStreams(sourceId + 1, 'live', [
        { stream_id: 4100, name: 'Example 4K', category_id: '91' },
        { stream_id: 1080, name: 'Example FHD', category_id: '91' },
        { stream_id: 720, name: 'Example HD', category_id: '91' },
        { stream_id: 480, name: 'Example', category_id: '91' }
    ]);

    const db = getDb();
    const m3uRows = db.prepare(`
        SELECT item_id, name, json_extract(data, '$.tvgId') AS tvg_id
        FROM playlist_items
        WHERE source_id = ? AND type = 'live'
        ORDER BY name
    `).all(sourceId);
    const xtreamRows = db.prepare(`
        SELECT item_id, name
        FROM playlist_items
        WHERE source_id = ? AND type = 'live'
        ORDER BY CAST(item_id AS INTEGER)
    `).all(sourceId + 1);

    assert.equal(m3uRows.length, 4);
    assert.equal(new Set(m3uRows.map(row => row.item_id)).size, 4);
    assert.ok(m3uRows.every(row => row.tvg_id === 'example.channel'));

    const hiddenVariantId = m3uRows.find(row => row.name === 'Example HD').item_id;
    db.prepare(`
        UPDATE playlist_items
        SET is_hidden = 1
        WHERE source_id = ? AND type = 'live' AND item_id = ?
    `).run(sourceId, hiddenVariantId);
    const visibility = db.prepare(`
        SELECT name, is_hidden
        FROM playlist_items
        WHERE source_id = ? AND type = 'live'
        ORDER BY name
    `).all(sourceId);
    assert.equal(visibility.filter(row => row.is_hidden === 1).length, 1);
    assert.equal(visibility.find(row => row.is_hidden === 1).name, 'Example HD');

    assert.deepEqual(xtreamRows, [
        { item_id: '480', name: 'Example' },
        { item_id: '720', name: 'Example HD' },
        { item_id: '1080', name: 'Example FHD' },
        { item_id: '4100', name: 'Example 4K' }
    ]);

    console.log('Distinct Live TV quality variant regression test passed.');
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        try {
            getDb().close();
        } catch (_) {
            // The database may not have opened if an earlier import failed.
        }
        fs.rmSync(testDataDir, { recursive: true, force: true });
    });
