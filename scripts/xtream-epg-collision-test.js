const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-xtream-epg-test-'));
process.env.NODECAST_DATA_DIR = testDataDir;
process.env.ALLOW_LOCAL_MEDIA_URLS = 'true';

const syncService = require('../server/services/syncService');
const { getDb } = require('../server/db/sqlite');

function createEpgFixture() {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="1">
    <display-name>A Great Channel</display-name>
    <icon src="https://example.test/a.png" />
  </channel>
  <channel id="10">
    <display-name>B Great Channel</display-name>
    <icon src="https://example.test/b.png" />
  </channel>
  <programme start="20260713000000 +0000" stop="20260714000000 +0000" channel="10">
    <title>Fixture programme</title>
  </programme>
</tv>`;

    return http.createServer((request, response) => {
        response.setHeader('Content-Type', 'application/xml');
        response.end(xml);
    });
}

async function run() {
    const sourceId = 1;
    const fixtureServer = createEpgFixture();
    await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));

    try {
        await syncService.saveStreams(sourceId, 'live', [
            {
                num: 1,
                name: 'A Great Channel',
                stream_id: 10,
                stream_icon: 'https://example.test/a.png',
                epg_channel_id: '1',
                category_id: '142'
            },
            {
                num: 10,
                name: 'B Great Channel',
                stream_id: 21,
                stream_icon: 'https://example.test/b.png',
                epg_channel_id: '10',
                category_id: '143'
            }
        ]);

        const db = getDb();
        db.prepare(`
            INSERT INTO playlist_items (
                id, source_id, item_id, type, name, stream_icon, data
            ) VALUES (?, ?, ?, 'epg_channel', ?, ?, ?)
        `).run(
            '1:legacy-epg-id',
            sourceId,
            'legacy',
            'Legacy EPG Channel',
            'https://example.test/legacy.png',
            '{}'
        );

        const { port } = fixtureServer.address();
        await syncService.syncEpgFromUrl(sourceId, `http://127.0.0.1:${port}/epg.xml`);

        const liveChannels = db.prepare(`
            SELECT item_id, name, stream_icon
            FROM playlist_items
            WHERE source_id = ? AND type = 'live'
            ORDER BY item_id
        `).all(sourceId);

        assert.deepEqual(liveChannels, [
            {
                item_id: '10',
                name: 'A Great Channel',
                stream_icon: 'https://example.test/a.png'
            },
            {
                item_id: '21',
                name: 'B Great Channel',
                stream_icon: 'https://example.test/b.png'
            }
        ]);

        const epgChannels = db.prepare(`
            SELECT id, item_id, name
            FROM playlist_items
            WHERE source_id = ? AND type = 'epg_channel'
            ORDER BY item_id
        `).all(sourceId);

        assert.deepEqual(epgChannels, [
            { id: '1:epg_channel:1', item_id: '1', name: 'A Great Channel' },
            { id: '1:epg_channel:10', item_id: '10', name: 'B Great Channel' }
        ]);

        console.log('Xtream/EPG channel ID collision regression test passed.');
    } finally {
        await new Promise(resolve => fixtureServer.close(resolve));
        const db = getDb();
        db.close();
        fs.rmSync(testDataDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
