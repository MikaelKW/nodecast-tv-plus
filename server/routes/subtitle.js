const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const auth = require('../auth');
const { FFMPEG_PROTOCOL_WHITELIST, validateHttpUrl } = require('../services/urlSecurity');

router.use(auth.requireAuth);

/**
 * Subtitle extraction endpoint
 * GET /api/subtitle?url=...&index=...
 * 
 * Extracts a specific subtitle track and converts it to WebVTT on the fly.
 */
router.get('/', (req, res) => {
    const { url, index } = req.query;

    if (!url || index === undefined) {
        return res.status(400).json({ error: 'URL and index parameters are required' });
    }

    let validatedUrl;
    try {
        validatedUrl = validateHttpUrl(url);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    // console.log(`[Subtitle] Extracting track ${index} from: ${url}`);

    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        '-probesize', '5000000',
        '-analyzeduration', '5000000',
        '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
        '-i', validatedUrl,
        '-map', `0:${index}`,
        '-c:s', 'webvtt',
        '-f', 'webvtt',
        '-'
    ];

    const ffmpeg = spawn(ffmpegPath, args);

    res.setHeader('Content-Type', 'text/vtt');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe stdout to response
    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', (data) => {
        // console.error(`[Subtitle FFmpeg] ${data}`);
    });

    req.on('close', () => {
        ffmpeg.kill('SIGKILL');
    });

    ffmpeg.on('error', (err) => {
        console.error('[Subtitle] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).send('Subtitle extraction failed');
        }
    });
});

module.exports = router;
