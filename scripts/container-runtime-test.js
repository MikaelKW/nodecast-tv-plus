'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const version = '9.0.2';
const sourceDigest = '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e';
assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Unexpected container Node.js line');

function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr}`);
    return `${result.stdout}\n${result.stderr}`;
}

for (const command of ['ffmpeg', 'ffprobe']) {
    assert.match(run(command, ['-version']), new RegExp(`${command} version ${version.replaceAll('.', '\\.')}\\b`));
}
assert.equal(fs.realpathSync(require('ffmpeg-static')), '/usr/local/bin/ffmpeg');
assert.equal(fs.realpathSync(require('@ffprobe-installer/ffprobe').path), '/usr/local/bin/ffprobe');
assert.equal(crypto.createHash('sha256').update(
    fs.readFileSync(`/usr/share/nodecast-runtime/sources/ffmpeg-${version}.tar.xz`)
).digest('hex'), sourceDigest, 'Corresponding source digest mismatch');

const capabilities = {
    encoders: ['libx264', 'aac', 'webvtt', 'h264_nvenc', 'h264_vaapi'],
    decoders: ['h264', 'hevc', 'mpeg2video', 'aac', 'ac3', 'eac3', 'libdav1d', 'h264_cuvid'],
    demuxers: ['hls', 'mpegts', 'mov', 'matroska', 'dash'],
    muxers: ['hls', 'mp4', 'webvtt'],
    filters: ['scale', 'pan', 'aresample', 'hwupload', 'hwdownload', 'scale_cuda', 'scale_vaapi'],
    protocols: ['http', 'https', 'tcp', 'tls', 'crypto']
};
if (process.arch === 'x64') {
    capabilities.encoders.push('h264_qsv');
    capabilities.filters.push('scale_qsv');
}
for (const [category, names] of Object.entries(capabilities)) {
    const listing = run('ffmpeg', ['-hide_banner', `-${category}`]);
    for (const name of names) assert.match(listing, new RegExp(`\\b${name}\\b`), `Missing ${category}: ${name}`);
    if (category === 'decoders') {
        assert.doesNotMatch(listing, /\blibrsvg\b|\bsvg\b/, 'Unexpected server-side SVG decoder');
    }
}

// Browser artwork is separate from the media tools. Keep SVG rendering out of
// both server-side tools, including their dynamically linked dependencies.
for (const command of ['ffmpeg', 'ffprobe']) {
    const linkage = run('ldd', [`/usr/local/bin/${command}`]);
    assert.doesNotMatch(linkage, /librsvg|libpango/, 'Unexpected SVG renderer linkage');
}

// Real software decode/filter/encode/mux cycle; encoder presence alone is not
// proof of operation. Hardware operation still requires an actual device.
run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
    '-t', '1', '-vf', 'scale=96:54', '-af', 'aresample=async=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    '-f', 'null', '-'
]);
console.log('Container runtime versions, source, paired fallback paths, capabilities and software media cycle passed.');
