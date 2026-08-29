const assert = require('node:assert/strict');
const { buildSubtitleExtractionArgs } = require('../server/services/subtitleExtraction');
const {
    MODES,
    normalizeLanguage,
    normalizePreferences,
    languageMatches,
    selectPreferredSubtitleTrack
} = require('../public/js/components/SubtitlePreferences');

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

assert.deepEqual(normalizePreferences(), { language: '', mode: MODES.OFF });
assert.deepEqual(normalizePreferences({ language: 'ENG', mode: MODES.PREFERRED }), {
    language: 'en',
    mode: MODES.PREFERRED
});
assert.deepEqual(normalizePreferences({ language: '', mode: MODES.PREFERRED }), {
    language: '',
    mode: MODES.OFF
});
assert.deepEqual(normalizePreferences({ language: 'en', mode: 'unsupported' }), {
    language: 'en',
    mode: MODES.OFF
});
assert.equal(normalizeLanguage('nob'), 'nb');
assert.equal(languageMatches('nob', 'no'), true);
assert.equal(languageMatches('nno', 'no'), true);
assert.equal(languageMatches('eng', 'no'), false);

const tracks = [
    { position: 0, language: 'eng', default: false, forced: false },
    { position: 1, language: 'nor', default: false, forced: false },
    { position: 2, language: 'nob', default: true, forced: false },
    { position: 3, language: 'eng', default: false, forced: true }
];

assert.equal(selectPreferredSubtitleTrack(tracks, { language: 'no', mode: MODES.PREFERRED }).position, 2);
assert.equal(selectPreferredSubtitleTrack(tracks, { language: 'en', mode: MODES.FORCED }).position, 3);
assert.equal(selectPreferredSubtitleTrack(tracks, { language: 'no', mode: MODES.DEFAULT }).position, 2);
assert.equal(selectPreferredSubtitleTrack(tracks, { language: 'fr', mode: MODES.DEFAULT }).position, 2);
assert.equal(selectPreferredSubtitleTrack(tracks, { language: 'fr', mode: MODES.PREFERRED }), null);
assert.equal(selectPreferredSubtitleTrack(tracks, { language: 'no', mode: MODES.OFF }), null);
assert.equal(selectPreferredSubtitleTrack([
    { position: 4, language: 'en', kind: 'metadata', default: true },
    { position: 7, language: 'en', kind: 'subtitles', default: true }
], { language: 'en', mode: MODES.PREFERRED }).position, 7);
assert.equal(selectPreferredSubtitleTrack([
    { position: 0, language: 'en', default: false, forced: false }
], { language: 'en', mode: MODES.DEFAULT }), null);
assert.equal(selectPreferredSubtitleTrack([
    { position: 0, language: '', default: false, forced: true }
], { language: '', mode: MODES.FORCED }).position, 0);

console.log('Subtitle extraction tests passed.');
