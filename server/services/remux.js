'use strict';

const { FFMPEG_PROTOCOL_WHITELIST } = require('./urlSecurity');
const { appendHttpReconnectArgs } = require('./ffmpegNetwork');

const MAX_AUDIO_CODEC_HINTS = 16;
const AUDIO_CODEC_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

function parseAudioCodecs(value) {
    if (value === undefined || value === null || value === '') return [];
    if (Array.isArray(value)) {
        const error = new Error('audioCodecs must be a comma-separated string');
        error.statusCode = 400;
        throw error;
    }

    const codecs = String(value)
        .split(',')
        .map(codec => codec.trim().toLowerCase());

    if (codecs.length > MAX_AUDIO_CODEC_HINTS || codecs.some(codec => !AUDIO_CODEC_PATTERN.test(codec))) {
        const error = new Error('audioCodecs contains an invalid codec list');
        error.statusCode = 400;
        throw error;
    }

    return codecs;
}

function buildRemuxArgs({ url, userAgent, audioCodecs = [], output = '-' }) {
    const audioBitstreamFilters = [];
    audioCodecs.forEach((codec, outputAudioIndex) => {
        if (codec === 'aac') {
            audioBitstreamFilters.push(
                `-bsf:a:${outputAudioIndex}`,
                'aac_adtstoasc'
            );
        }
    });

    return [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', userAgent,
        '-user_agent', userAgent,
        // Standard probe size to handle complex containers (MKV) correctly
        '-probesize', '5000000',
        '-analyzeduration', '5000000',
        // Error resilience: discard corrupt packets, generate timestamps, ignore DTS, no buffering
        '-fflags', '+genpts+discardcorrupt+igndts+nobuffer',
        // Ignore errors in stream and continue
        '-err_detect', 'ignore_err',
        // Limit max demux delay to prevent buffering issues with bad timestamps
        '-max_delay', '5000000',
        // Reconnect settings for network drops
        ...appendHttpReconnectArgs([]),
        // Prevent Range/HEAD requests that some providers reject with 405
        '-seekable', '0',
        '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
        '-i', url,
        // Only map video and audio, ignoring subtitles, data, and attachments.
        '-map', '0:v',
        '-map', '0:a',
        '-sn', '-dn',
        // Copy streams without re-encoding.
        '-c', 'copy',
        // Convert Annex B video extradata for fragmented MP4.
        '-bsf:v', 'dump_extra',
        // MPEG-TS commonly carries AAC in ADTS. Apply its MP4 conversion only
        // to AAC outputs so other audio codecs remain unaffected.
        ...audioBitstreamFilters,
        '-fps_mode', 'passthrough',
        '-max_muxing_queue_size', '1024',
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        output
    ];
}

module.exports = {
    buildRemuxArgs,
    parseAudioCodecs
};
