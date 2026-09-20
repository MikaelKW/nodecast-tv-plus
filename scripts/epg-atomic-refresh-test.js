const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-epg-atomic-test-'));
process.env.NODECAST_DATA_DIR = testDataDir;

const { sources } = require('../server/db');
const { getDb } = require('../server/db/sqlite');
const epgParser = require('../server/services/epgParser');
const syncService = require('../server/services/syncService');

const originalFetchAndParseStreaming = epgParser.fetchAndParseStreaming;
const fixtureUrl = 'http://example.test/guide.xml';

function programme(title, channelId = 'channel.test', hour = 6) {
    const start = new Date(Date.UTC(2026, 6, 14, hour, 0, 0));
    const stop = new Date(Date.UTC(2026, 6, 14, hour + 1, 0, 0));
    return {
        channelId,
        start,
        stop,
        title,
        description: `${title} description`,
        category: []
    };
}

function channel(id, name) {
    return { id, name, icon: null, url: null };
}

function setStreamFactory(factory) {
    epgParser.fetchAndParseStreaming = factory;
}

function seedGuide(sourceId, title = 'Old programme', channelId = 'old.channel') {
    const db = getDb();
    const oldProgramme = programme(title, channelId);
    db.prepare(`
        INSERT INTO epg_programs (
            channel_id, source_id, start_time, end_time, title, description, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        oldProgramme.channelId,
        sourceId,
        oldProgramme.start.getTime(),
        oldProgramme.stop.getTime(),
        oldProgramme.title,
        oldProgramme.description,
        JSON.stringify(oldProgramme)
    );
    db.prepare(`
        INSERT INTO playlist_items (
            id, source_id, item_id, type, name, stream_icon, stream_url, category_id, data
        ) VALUES (?, ?, ?, 'epg_channel', ?, NULL, NULL, NULL, ?)
    `).run(
        `${sourceId}:epg_channel:${channelId}`,
        sourceId,
        channelId,
        'Old channel',
        JSON.stringify(channel(channelId, 'Old channel'))
    );
}

function guideSnapshot(sourceId) {
    const db = getDb();
    return {
        programmes: db.prepare(`
            SELECT channel_id, title
            FROM epg_programs
            WHERE source_id = ?
            ORDER BY start_time, title
        `).all(sourceId),
        channels: db.prepare(`
            SELECT item_id, name
            FROM playlist_items
            WHERE source_id = ? AND type = 'epg_channel'
            ORDER BY item_id
        `).all(sourceId)
    };
}

function guideCounts(sourceId) {
    const db = getDb();
    return {
        programmes: db.prepare(
            'SELECT COUNT(*) AS count FROM epg_programs WHERE source_id = ?'
        ).get(sourceId).count,
        channels: db.prepare(`
            SELECT COUNT(*) AS count
            FROM playlist_items
            WHERE source_id = ? AND type = 'epg_channel'
        `).get(sourceId).count
    };
}

function assertNoStagingRows() {
    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM temp.epg_programs_staging').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM temp.epg_channels_staging').get().count, 0);
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM main.sqlite_master
        WHERE name IN ('epg_programs_staging', 'epg_channels_staging')
    `).get().count, 0, 'staging tables must remain connection-scoped for restart cleanup');
}

async function createEpgSource(name) {
    return sources.create({
        type: 'epg',
        name,
        url: fixtureUrl
    });
}

async function assertParserRejectsIncompleteXml() {
    const truncated = `<?xml version="1.0"?><tv>
      <channel id="broken"><display-name>Broken</display-name></channel>
      <programme start="20260714060000 +0000" stop="20260714070000 +0000" channel="broken">
        <title>Partial programme</title>
      </programme>`;

    await assert.rejects(epgParser.parse(truncated), /Invalid XMLTV document/);
    await assert.rejects(async () => {
        for await (const unused of epgParser.parseStreaming(Readable.from([truncated]), 1)) {
            void unused;
        }
    }, /Invalid XMLTV document/);

    const interrupted = new Readable({
        read() {
            this.push('<tv><channel id="broken"></channel>');
            this.destroy(new Error('fixture connection interrupted'));
        }
    });
    await assert.rejects(async () => {
        for await (const unused of epgParser.parseStreaming(interrupted, 1)) {
            void unused;
        }
    }, /fixture connection interrupted/);

    const emptyBatches = [];
    for await (const batch of epgParser.parseStreaming(Readable.from(['<tv></tv>']))) {
        emptyBatches.push(batch);
    }
    assert.equal(emptyBatches.length, 1);
    assert.equal(emptyBatches[0].isLast, true);
    assert.deepEqual(emptyBatches[0].channels, []);
    assert.deepEqual(emptyBatches[0].programmes, []);
}

async function assertFailedRefreshPreservesActiveGuide() {
    const source = await createEpgSource('Failed refresh');
    seedGuide(source.id);
    const before = guideSnapshot(source.id);

    setStreamFactory(async function* partialThenFail() {
        yield {
            channels: [channel('new.channel', 'New channel')],
            programmes: [programme('Partial replacement', 'new.channel')],
            skippedProgrammes: 0,
            isLast: false
        };
        throw new Error('fixture parser failed after a complete batch');
    });

    await assert.rejects(
        syncService.syncEpgFromUrl(source.id, fixtureUrl),
        /fixture parser failed/
    );
    assert.deepEqual(guideSnapshot(source.id), before);
    assertNoStagingRows();
}

async function assertIncompleteGeneratorPreservesActiveGuide() {
    const source = await createEpgSource('Incomplete refresh');
    seedGuide(source.id);
    const before = guideSnapshot(source.id);

    setStreamFactory(async function* incompleteRefresh() {
        yield {
            channels: [channel('new.channel', 'New channel')],
            programmes: [programme('Incomplete replacement', 'new.channel')],
            skippedProgrammes: 0,
            isLast: false
        };
    });

    await assert.rejects(
        syncService.syncEpgFromUrl(source.id, fixtureUrl),
        /ended before the XMLTV document completed/
    );
    assert.deepEqual(guideSnapshot(source.id), before);
    assertNoStagingRows();
}

async function assertSuccessfulRefreshActivatesOneCompleteGeneration() {
    const source = await createEpgSource('Successful refresh');
    seedGuide(source.id);
    const before = guideSnapshot(source.id);
    let snapshotDuringImport = null;

    setStreamFactory(async function* completeRefresh() {
        yield {
            channels: [channel('new.channel', 'New channel')],
            programmes: [programme('New programme one', 'new.channel', 7)],
            skippedProgrammes: 0,
            isLast: false
        };
        snapshotDuringImport = guideSnapshot(source.id);
        yield {
            channels: null,
            programmes: [programme('New programme two', 'new.channel', 8)],
            skippedProgrammes: 0,
            isLast: true
        };
    });

    await syncService.syncEpgFromUrl(source.id, fixtureUrl);
    assert.deepEqual(snapshotDuringImport, before);
    assert.deepEqual(guideSnapshot(source.id), {
        programmes: [
            { channel_id: 'new.channel', title: 'New programme one' },
            { channel_id: 'new.channel', title: 'New programme two' }
        ],
        channels: [{ item_id: 'new.channel', name: 'New channel' }]
    });
    assertNoStagingRows();
}

async function assertValidEmptyFeedClearsGuide() {
    const source = await createEpgSource('Valid empty refresh');
    seedGuide(source.id);

    setStreamFactory(async function* emptyRefresh() {
        yield {
            channels: [],
            programmes: [],
            skippedProgrammes: 0,
            isLast: true
        };
    });

    await syncService.syncEpgFromUrl(source.id, fixtureUrl);
    assert.deepEqual(guideSnapshot(source.id), { programmes: [], channels: [] });
    assertNoStagingRows();
}

async function assertFirstImportFailureLeavesNoPartialGuide() {
    const source = await createEpgSource('Failed first import');

    setStreamFactory(async function* failedFirstImport() {
        yield {
            channels: [channel('partial.channel', 'Partial channel')],
            programmes: [programme('Partial first import', 'partial.channel')],
            skippedProgrammes: 0,
            isLast: false
        };
        throw new Error('fixture first import failed');
    });

    await assert.rejects(
        syncService.syncEpgFromUrl(source.id, fixtureUrl),
        /fixture first import failed/
    );
    assert.deepEqual(guideSnapshot(source.id), { programmes: [], channels: [] });
    assertNoStagingRows();
}

async function assertStagingWriteFailurePreservesAndRecovers() {
    const source = await createEpgSource('Staging failure recovery');
    seedGuide(source.id);
    const before = guideSnapshot(source.id);
    const invalidProgramme = programme('Invalid staged programme');
    invalidProgramme.channelId = null;

    setStreamFactory(async function* invalidStagingWrite() {
        yield {
            channels: [channel('replacement.channel', 'Replacement channel')],
            programmes: [invalidProgramme],
            skippedProgrammes: 0,
            isLast: true
        };
    });

    await assert.rejects(
        syncService.syncEpgFromUrl(source.id, fixtureUrl),
        /NOT NULL constraint failed/
    );
    assert.deepEqual(guideSnapshot(source.id), before);
    assertNoStagingRows();

    setStreamFactory(async function* recoveredRefresh() {
        yield {
            channels: [channel('recovered.channel', 'Recovered channel')],
            programmes: [programme('Recovered programme', 'recovered.channel')],
            skippedProgrammes: 0,
            isLast: true
        };
    });

    await syncService.syncEpgFromUrl(source.id, fixtureUrl);
    assert.deepEqual(guideSnapshot(source.id), {
        programmes: [{ channel_id: 'recovered.channel', title: 'Recovered programme' }],
        channels: [{ item_id: 'recovered.channel', name: 'Recovered channel' }]
    });
    assertNoStagingRows();
}

async function assertConcurrentRefreshIsRejected() {
    const source = await createEpgSource('Concurrent refresh');
    let signalStarted;
    let releaseRefresh;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const release = new Promise(resolve => { releaseRefresh = resolve; });

    setStreamFactory(async function* blockedRefresh() {
        signalStarted();
        await release;
        yield {
            channels: [],
            programmes: [],
            skippedProgrammes: 0,
            isLast: true
        };
    });

    const firstRefresh = syncService.syncEpgFromUrl(source.id, fixtureUrl);
    await started;
    await assert.rejects(
        syncService.syncEpgFromUrl(source.id, fixtureUrl),
        /already in progress/
    );
    releaseRefresh();
    await firstRefresh;
    assertNoStagingRows();
}

async function assertDeletedSourceCannotActivateStagedGuide() {
    const source = await createEpgSource('Deleted during refresh');
    seedGuide(source.id);
    const before = guideSnapshot(source.id);
    let signalStaged;
    let releaseRefresh;
    const staged = new Promise(resolve => { signalStaged = resolve; });
    const release = new Promise(resolve => { releaseRefresh = resolve; });

    setStreamFactory(async function* refreshAcrossDeletion() {
        yield {
            channels: [channel('replacement.channel', 'Replacement channel')],
            programmes: [programme('Replacement programme', 'replacement.channel')],
            skippedProgrammes: 0,
            isLast: false
        };
        signalStaged();
        await release;
        yield {
            channels: null,
            programmes: [],
            skippedProgrammes: 0,
            isLast: true
        };
    });

    const refresh = syncService.syncEpgFromUrl(source.id, fixtureUrl);
    await staged;
    syncService.invalidateEpgSource(source.id);
    await sources.delete(source.id);
    releaseRefresh();
    await assert.rejects(refresh, /was removed during refresh/);
    assert.deepEqual(guideSnapshot(source.id), before);
    assertNoStagingRows();
}

async function assertDifferentSourcesCanRefreshConcurrently() {
    const first = await createEpgSource('Concurrent source one');
    const second = await createEpgSource('Concurrent source two');
    seedGuide(first.id, 'First old programme', 'first.old');
    seedGuide(second.id, 'Second old programme', 'second.old');

    setStreamFactory(async function* concurrentSources(url) {
        const isFirst = new URL(url).pathname.includes('first');
        const id = isFirst ? 'first.new' : 'second.new';
        await new Promise(resolve => setImmediate(resolve));
        yield {
            channels: [channel(id, isFirst ? 'First new channel' : 'Second new channel')],
            programmes: [programme(isFirst ? 'First new programme' : 'Second new programme', id)],
            skippedProgrammes: 0,
            isLast: true
        };
    });

    await Promise.all([
        syncService.syncEpgFromUrl(first.id, 'http://example.test/first.xml'),
        syncService.syncEpgFromUrl(second.id, 'http://example.test/second.xml')
    ]);

    assert.deepEqual(guideSnapshot(first.id), {
        programmes: [{ channel_id: 'first.new', title: 'First new programme' }],
        channels: [{ item_id: 'first.new', name: 'First new channel' }]
    });
    assert.deepEqual(guideSnapshot(second.id), {
        programmes: [{ channel_id: 'second.new', title: 'Second new programme' }],
        channels: [{ item_id: 'second.new', name: 'Second new channel' }]
    });
    assertNoStagingRows();
}

async function assertLargeImportRemainsStagedAndBounded() {
    const source = await createEpgSource('Large staged refresh');
    seedGuide(source.id, 'Large old programme', 'large.old');
    const batchSize = 1000;
    const batchCount = 12;
    const baselineHeap = process.memoryUsage().heapUsed;
    let peakHeap = baselineHeap;

    setStreamFactory(async function* largeRefresh() {
        for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
            if (batchIndex > 0) {
                assert.deepEqual(guideCounts(source.id), { programmes: 1, channels: 1 });
            }
            const programmes = Array.from({ length: batchSize }, (_, offset) => {
                const itemIndex = (batchIndex * batchSize) + offset;
                return programme(`Synthetic programme ${itemIndex}`, 'large.new', itemIndex + 1);
            });
            peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
            yield {
                channels: batchIndex === 0 ? [channel('large.new', 'Large new channel')] : null,
                programmes,
                skippedProgrammes: 0,
                isLast: batchIndex === batchCount - 1
            };
            await new Promise(resolve => setImmediate(resolve));
        }
    });

    await syncService.syncEpgFromUrl(source.id, fixtureUrl);
    assert.deepEqual(guideCounts(source.id), {
        programmes: batchSize * batchCount,
        channels: 1
    });
    const heapGrowthMb = (peakHeap - baselineHeap) / 1024 / 1024;
    assert.ok(heapGrowthMb < 128, `large staged import used ${heapGrowthMb.toFixed(1)}MB additional heap`);
    assertNoStagingRows();
    console.log(`Large staged EPG fixture: ${batchSize * batchCount} programmes, ${heapGrowthMb.toFixed(1)}MB peak heap growth.`);
}

async function run() {
    try {
        await assertParserRejectsIncompleteXml();
        await assertFailedRefreshPreservesActiveGuide();
        await assertIncompleteGeneratorPreservesActiveGuide();
        await assertSuccessfulRefreshActivatesOneCompleteGeneration();
        await assertValidEmptyFeedClearsGuide();
        await assertFirstImportFailureLeavesNoPartialGuide();
        await assertStagingWriteFailurePreservesAndRecovers();
        await assertConcurrentRefreshIsRejected();
        await assertDeletedSourceCannotActivateStagedGuide();
        await assertDifferentSourcesCanRefreshConcurrently();
        await assertLargeImportRemainsStagedAndBounded();
        console.log('Atomic EPG refresh regression tests passed.');
    } finally {
        epgParser.fetchAndParseStreaming = originalFetchAndParseStreaming;
        syncService.stopSyncTimer();
        const db = getDb();
        db.close();
        fs.rmSync(testDataDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
