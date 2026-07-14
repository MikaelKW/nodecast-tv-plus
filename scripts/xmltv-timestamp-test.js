const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
    parse,
    parseStreaming,
    parseXmltvDate
} = require('../server/services/epgParser');

function assertTimestamp(input, expected) {
    const parsed = parseXmltvDate(input);
    assert.ok(parsed instanceof Date, `${input} should produce a Date`);
    assert.equal(parsed.toISOString(), expected, input);
}

async function collectStreaming(xml, batchSize = 2) {
    const result = { channels: [], programmes: [], skippedProgrammes: 0 };

    for await (const batch of parseStreaming(Readable.from([xml]), batchSize)) {
        if (batch.channels) result.channels.push(...batch.channels);
        result.programmes.push(...batch.programmes);
        result.skippedProgrammes += batch.skippedProgrammes || 0;
    }

    return result;
}

async function main() {
    assertTimestamp('20260714061234 +0000', '2026-07-14T06:12:34.000Z');
    assertTimestamp('202607140612 +0000', '2026-07-14T06:12:00.000Z');
    assertTimestamp('2026071406 -0500', '2026-07-14T11:00:00.000Z');
    assertTimestamp('20260714 +0230', '2026-07-13T21:30:00.000Z');
    assertTimestamp('202607', '2026-07-01T00:00:00.000Z');
    assertTimestamp('2026', '2026-01-01T00:00:00.000Z');
    assertTimestamp('20260714061234Z', '2026-07-14T06:12:34.000Z');
    assertTimestamp('20260714061234 +0530', '2026-07-14T00:42:34.000Z');
    assertTimestamp('2026-07-14T06:12:34+02:00', '2026-07-14T04:12:34.000Z');

    for (const invalid of [
        '',
        'not-a-timestamp',
        '20260230060000 +0000',
        '20261301060000 +0000',
        '20260714240000 +0000',
        '20260714066000 +0000',
        '20260714060060 +0000',
        '20260714060000 +2460',
        '20260714060 +0000',
        '2026-02-30T06:00:00Z',
        '2026-07-14T06:00:00+24:00'
    ]) {
        assert.equal(parseXmltvDate(invalid), null, `${invalid || '<empty>'} should be rejected`);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="timestamp.test"><display-name>Timestamp Test</display-name></channel>
  <programme start="20260714060000 +0000" stop="20260714063000 +0000" channel="timestamp.test"><title>Seconds</title></programme>
  <programme start="202607140630 +0000" stop="202607140700 +0000" channel="timestamp.test"><title>Minutes</title></programme>
  <programme start="20260230070000 +0000" stop="20260714073000 +0000" channel="timestamp.test"><title>Invalid start</title></programme>
  <programme start="20260714073000 +0000" stop="20260714250000 +0000" channel="timestamp.test"><title>Invalid stop</title></programme>
</tv>`;

    const parsed = await parse(xml);
    assert.equal(parsed.channels.length, 1);
    assert.deepEqual(parsed.programmes.map(programme => programme.title), ['Seconds', 'Minutes']);
    assert.equal(parsed.skippedProgrammes, 2);

    const streamed = await collectStreaming(xml, 10);
    assert.equal(streamed.channels.length, 1);
    assert.deepEqual(streamed.programmes.map(programme => programme.title), ['Seconds', 'Minutes']);
    assert.equal(streamed.skippedProgrammes, 2);

    console.log('XMLTV timestamp validation passed.');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
