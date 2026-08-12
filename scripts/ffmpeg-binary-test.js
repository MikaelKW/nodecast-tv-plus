'use strict';

const assert = require('node:assert/strict');
const {
    normalizeBundledPath,
    resolveFFmpegPath
} = require('../server/services/ffmpegBinary');

let bundledLoads = 0;
const systemResult = resolveFFmpegPath({
    commandAvailable: command => command === 'ffmpeg',
    loadBundled: () => {
        bundledLoads += 1;
        throw new Error('optional package is unavailable');
    }
});
assert.deepEqual(systemResult, { path: 'ffmpeg', source: 'system' });
assert.equal(bundledLoads, 0, 'The optional package must not load when system FFmpeg is available.');

const bundledResult = resolveFFmpegPath({
    commandAvailable: () => false,
    loadBundled: () => '/opt/node_modules/ffmpeg-static/ffmpeg'
});
assert.deepEqual(bundledResult, {
    path: '/opt/node_modules/ffmpeg-static/ffmpeg',
    source: 'bundled'
});

const missingResult = resolveFFmpegPath({
    commandAvailable: () => false,
    loadBundled: () => {
        throw new Error('optional package is unavailable');
    }
});
assert.deepEqual(missingResult, { path: null, source: 'unavailable' });

assert.equal(
    normalizeBundledPath('/app/resources/app.asar/node_modules/ffmpeg-static/ffmpeg'),
    '/app/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg'
);
assert.equal(normalizeBundledPath(null), null);

console.log('FFmpeg binary resolution tests passed.');
