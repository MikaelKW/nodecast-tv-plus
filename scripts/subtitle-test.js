const assert = require('node:assert/strict');
const { buildSubtitleExtractionArgs } = require('../server/services/subtitleExtraction');

function valueAfter(args, option) {
    const index = args.indexOf(option);
    assert.notEqual(index, -1, `Expected ${option}`);
    return args[index + 1];
}

const windowed = buildSubtitleExtractionArgs({
    url: 'https://example.com/media.mkv',
    streamIndex: 3,
    userAgent: 'NodeCast Test',
    windowStart: 1920,
    windowDuration: 60
});
const inputIndex = windowed.indexOf('-i');
assert.ok(windowed.indexOf('-copyts') < inputIndex);
assert.ok(windowed.indexOf('-ss') < inputIndex);
assert.equal(valueAfter(windowed, '-ss'), '1920');
assert.equal(valueAfter(windowed, '-to'), '1980');
assert.equal(windowed.includes('-t'), false);
assert.equal(windowed.includes('-seekable'), false);

const complete = buildSubtitleExtractionArgs({
    url: 'https://example.com/media.mkv',
    streamIndex: 3,
    userAgent: 'NodeCast Test'
});
assert.equal(complete.includes('-copyts'), false);
assert.equal(complete.includes('-ss'), false);
assert.equal(complete.includes('-to'), false);
assert.equal(valueAfter(complete, '-seekable'), '0');

console.log('Subtitle extraction tests passed.');
