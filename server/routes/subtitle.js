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
    const { url, index } = req.query;

    if (!url || index === undefined) {
        return res.status(400).json({ error: 'URL and index parameters are required' });
    }

    let validatedUrl;
    let streamIndex;
    try {
        validatedUrl = validateHttpUrl(url);
        streamIndex = parseOptionalStreamIndex(index, 'index');
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
        '-seekable', '0',
        '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
        '-i', validatedUrl,
        '-map', `0:${streamIndex}`,
        '-c:s', 'webvtt',
        '-f', 'webvtt',
        '-'
    ];

    const ffmpeg = spawn(ffmpegPath, args);

    res.setHeader('Content-Type', 'text/vtt');
    res.setHeader('Access-Control-Allow-Origin', '*');

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
