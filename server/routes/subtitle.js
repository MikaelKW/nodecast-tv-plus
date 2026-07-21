const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const auth = require('../auth');
const db = require('../db');
const { FFMPEG_PROTOCOL_WHITELIST, validateHttpUrl } = require('../services/urlSecurity');
const { appendHttpReconnectArgs } = require('../services/ffmpegNetwork');
const { parseOptionalStreamIndex } = require('../services/mediaSelection');

router.use(auth.requireAuth);

/**
 * Subtitle extraction endpoint
 * GET /api/subtitle?url=...&index=...
 * 
 * Extracts a specific subtitle track and converts it to WebVTT on the fly.
 */
router.get('/', async (req, res) => {
    const { url, index, start, duration } = req.query;

    if (!url || index === undefined) {
        return res.status(400).json({ error: 'URL and index parameters are required' });
    }

    let validatedUrl;
    let streamIndex;
    let windowStart = 0;
    let windowDuration = null;
    try {
        validatedUrl = validateHttpUrl(url);
        streamIndex = parseOptionalStreamIndex(index, 'index');

        const hasWindow = start !== undefined || duration !== undefined;
        if (hasWindow) {
            windowStart = Number(start ?? 0);
            windowDuration = Number(duration);
            if (!Number.isFinite(windowStart) || windowStart < 0 || windowStart > 86400) {
                throw new Error('start must be between 0 and 86400 seconds');
            }
            if (!Number.isFinite(windowDuration) || windowDuration <= 0 || windowDuration > 120) {
                throw new Error('duration must be between 0 and 120 seconds');
            }
        }
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', userAgent,
        '-probesize', '5000000',
        '-analyzeduration', '5000000',
        ...appendHttpReconnectArgs([]),
        '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
        ...(windowDuration !== null && windowStart > 0 ? ['-ss', String(windowStart)] : []),
        ...(windowDuration === null ? ['-seekable', '0'] : []),
        '-i', validatedUrl,
        '-map', `0:${streamIndex}`,
        ...(windowDuration !== null ? ['-t', String(windowDuration)] : []),
        '-c:s', 'webvtt',
        '-f', 'webvtt',
        '-'
    ];

    const ffmpeg = spawn(ffmpegPath, args);

    res.setHeader('Content-Type', 'text/vtt');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    // FFmpeg's WebVTT muxer can finish the last cue with only one trailing
    // newline. Append an empty line so browser text-track parsers reliably
    // finalize that cue before the response ends.
    ffmpeg.stdout.pipe(res, { end: false });
    ffmpeg.stdout.on('end', () => {
        if (!res.writableEnded) res.end('\n');
    });

    ffmpeg.stderr.on('data', (data) => {
        // console.error(`[Subtitle FFmpeg] ${data}`);
    });

    const stopExtraction = () => {
        if (!res.writableEnded && !ffmpeg.killed) ffmpeg.kill('SIGKILL');
    };
    res.on('close', stopExtraction);

    ffmpeg.on('error', (err) => {
        console.error('[Subtitle] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).send('Subtitle extraction failed');
        }
    });

    ffmpeg.on('close', code => {
        res.off('close', stopExtraction);
        if (code !== 0 && code !== null && !res.writableEnded) {
            res.destroy(new Error('Subtitle extraction failed'));
        }
    });
});

module.exports = router;
