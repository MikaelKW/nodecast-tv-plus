const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const db = require('../db');

/**
 * Allowed input URL schemes for the remux endpoint.
 *
 * FFmpeg accepts a wide variety of protocol handlers (file://, concat:,
 * subfile:, data:, pipe:, crypto:, async:, cache:, ...). Several of them
 * read from the local filesystem or compose existing protocols, so they
 * must NOT be reachable from a request parameter — otherwise an attacker
 * who can call /api/remux can read arbitrary local files via the streamed
 * response.
 *
 * Only plain http/https stream URLs are valid inputs here.
 */
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

/**
 * The set of ffmpeg protocols we explicitly permit via -protocol_whitelist.
 * This is a defence-in-depth layer applied on top of the scheme check: even
 * if a future code path forwarded a different URL, ffmpeg itself would
 * refuse to touch local files / arbitrary demuxer-level protocols.
 *
 * - file/concat/subfile/pipe/data/crypto/async/cache are intentionally absent.
 * - tls/tcp are needed for https; https/http are obvious.
 * - hls is needed so the demuxer can follow HLS playlists.
 */
const FFMPEG_PROTOCOL_WHITELIST = 'http,https,tls,tcp,hls';

/**
 * Validate a user-supplied stream URL.
 * Returns the normalised URL string on success, or null on rejection.
 */
function validateStreamUrl(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    // Reject control characters (incl. CR/LF/NUL) before WHATWG URL parsing,
    // which would otherwise silently strip some of them.
    if (/[\x00-\x1F\x7F]/.test(raw)) return null;
    let parsed;
    try {
        parsed = new URL(raw);
    } catch (_) {
        return null;
    }
    if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) return null;
    return parsed.toString();
}

/**
 * Remux stream (container conversion only)
 * GET /api/remux?url=...
 * 
 * Remuxes MPEG-TS to fragmented MP4 for browser playback.
 * This is a lightweight operation - no video/audio re-encoding.
 * Use this for raw .ts streams that browsers can't play directly.
 * 
 * Note: This does NOT fix Dolby/AC3 audio issues - use /api/transcode for that.
 */
router.get('/', async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const safeUrl = validateStreamUrl(url);
    if (!safeUrl) {
        return res.status(400).json({ error: 'URL must be an http:// or https:// stream URL' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';

    // Get User-Agent from settings
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    console.log(`[Remux] Starting remux for: ${safeUrl}`);
    console.log(`[Remux] Using User-Agent: ${settings.userAgentPreset}`);

    // FFmpeg arguments for pure remux (no encoding)
    // Very lightweight - just changes container from TS to fragmented MP4
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        // Restrict the protocols ffmpeg is allowed to open for input.
        // Defence in depth: blocks file://, concat:, subfile:, data:, pipe:, etc.
        // even if a different URL slipped past validateStreamUrl().
        '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
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
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        // Prevent Range/HEAD requests that some providers reject with 405
        '-seekable', '0',
        '-i', safeUrl,
        // STRICT MAPPING: Only map video and audio, ignore subtitles/data/attachments
        // This prevents remux failure when source container has incompatible subtitle tracks (e.g. MKV -> MP4)
        '-map', '0:v',
        '-map', '0:a',
        // Drop subtitles (-sn) and data (-dn) explicitly
        '-sn', '-dn',
        // Copy streams without re-encoding
        '-c', 'copy',
        // Ensure extradata is correctly extracted/converted (fixes Annex B -> AVCC issues in Firefox)
        '-bsf:v', 'dump_extra',
        // NOTE: We intentionally do NOT use -bsf:a aac_adtstoasc here
        // That filter only works for AAC audio and breaks AC3/EAC3/MP3.
        // If AAC audio from MPEG-TS fails in MP4, use /api/transcode instead.
        // Handle timestamp discontinuities at output
        '-fps_mode', 'passthrough',
        '-max_muxing_queue_size', '1024',
        // Fragmented MP4 for streaming (browser-compatible)
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-' // Output to stdout
    ];

    console.log(`[Remux] Full command: ${ffmpegPath} ${args.join(' ')}`);

    let ffmpeg;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (spawnErr) {
        console.error('[Remux] Failed to spawn FFmpeg:', spawnErr);
        return res.status(500).json({ error: 'FFmpeg spawn failed', details: spawnErr.message });
    }

    // Set headers for fragmented MP4
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe stdout to response
    ffmpeg.stdout.pipe(res);

    // Log stderr (useful for debugging)
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        // Only log warnings/errors, not progress
        if (msg.includes('Warning') || msg.includes('Error') || msg.includes('error')) {
            console.log(`[Remux FFmpeg] ${msg}`);
        }
    });

    // Cleanup on client disconnect
    req.on('close', () => {
        console.log('[Remux] Client disconnected, killing FFmpeg process');
        ffmpeg.kill('SIGKILL');
    });

    // Handle process exit
    ffmpeg.on('exit', (code) => {
        if (code !== null && code !== 0 && code !== 255) {
            console.error(`[Remux] FFmpeg exited with code ${code}`);
        }
    });

    // Handle spawn errors
    ffmpeg.on('error', (err) => {
        console.error('[Remux] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Remux failed to start' });
        }
    });
});

module.exports = router;
