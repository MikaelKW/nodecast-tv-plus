const { FFMPEG_PROTOCOL_WHITELIST } = require('./urlSecurity');
const { appendHttpReconnectArgs } = require('./ffmpegNetwork');

function buildSubtitleExtractionArgs({
    url,
    streamIndex,
    userAgent,
    windowStart = 0,
    windowDuration = null
}) {
    const windowed = Number.isFinite(windowDuration);
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', userAgent,
        '-probesize', '5000000',
        '-analyzeduration', '5000000',
        ...appendHttpReconnectArgs([]),
        '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST
    ];

    if (windowed) {
        // Preserve source timestamps so overlapping extraction windows return
        // identical cue times. Rebased timestamps vary with the seek point and
        // create duplicate, competing cues in WebKit.
        args.push('-copyts');
        if (windowStart > 0) args.push('-ss', String(windowStart));
    } else {
        args.push('-seekable', '0');
    }

    args.push(
        '-i', url,
        '-map', `0:${streamIndex}`
    );

    if (windowed) {
        // With -copyts, -to is an absolute output timestamp. This bounds the
        // requested window without rebasing its cues to a new zero point.
        args.push('-to', String(windowStart + windowDuration));
    }

    args.push(
        '-c:s', 'webvtt',
        '-f', 'webvtt',
        '-'
    );

    return args;
}

module.exports = { buildSubtitleExtractionArgs };
