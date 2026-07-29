const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const db = require('../db');
const auth = require('../auth');
const { redactText, redactUrl } = require('../services/urlSecurity');
const { authorizeMediaUrl } = require('../services/mediaAccess');
const { mediaProcessLimit } = require('../services/concurrencyLimiter');
const { buildRemuxArgs, parseAudioCodecs } = require('../services/remux');

router.use(auth.requireAuth);

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
router.get('/', mediaProcessLimit, async (req, res) => {
    const { url, audioCodecs: audioCodecsValue } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    let validatedUrl;
    let audioCodecs;
    try {
        validatedUrl = await authorizeMediaUrl(url);
        audioCodecs = parseAudioCodecs(audioCodecsValue);
    } catch (err) {
        return res.status(err.statusCode || 400).json({ error: err.message });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';

    // Get User-Agent from settings
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    console.log(`[Remux] Starting remux for: ${redactUrl(validatedUrl)}`);
    console.log(`[Remux] Using User-Agent: ${settings.userAgentPreset}`);

    const args = buildRemuxArgs({
        url: validatedUrl,
        userAgent,
        audioCodecs
    });

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
            console.log(`[Remux FFmpeg] ${redactText(msg)}`);
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
