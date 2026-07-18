const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const auth = require('../auth');
const { appendHttpReconnectArgs } = require('../services/ffmpegNetwork');
const { FFMPEG_PROTOCOL_WHITELIST, redactText, redactUrl, validateHttpUrl } = require('../services/urlSecurity');

router.use(auth.requireAuth);

/**
 * Probe endpoint - detects stream codecs and container
 * GET /api/probe?url=...
 * 
 * Returns:
 * {
 *   video: "h264",
 *   audio: "aac",
 *   container: "mpegts",
 *   compatible: true,
 *   needsRemux: false,
 *   needsTranscode: false
 * }
 */

// Probe cache (URL → result)
const probeCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const FAILURE_CACHE_TTL = 30 * 1000;

// Browser-compatible codecs
const BROWSER_VIDEO_CODECS = ['h264', 'avc', 'avc1'];
const BROWSER_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis'];

/**
 * Probe stream with ffprobe
 */
function probeStream(url, ffprobePath, userAgent = null, timeout = 15000, signal = null) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
            '-user_agent', userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        ];
        appendHttpReconnectArgs(args);
        args.push(
            '-print_format', 'json',
            '-show_streams',
            '-show_format',
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
            url
        );

        const proc = spawn(ffprobePath, args);
        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abortProbe);
            callback(value);
        };

        const abortProbe = () => {
            proc.kill('SIGKILL');
            const error = new Error('Probe cancelled');
            error.name = 'AbortError';
            finish(reject, error);
        };

        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            finish(reject, new Error('Probe timeout'));
        }, timeout);

        if (signal?.aborted) return abortProbe();
        signal?.addEventListener('abort', abortProbe, { once: true });

        proc.stdout.on('data', (data) => { stdout += data; });
        proc.stderr.on('data', (data) => { stderr += data; });

        proc.on('close', (code) => {
            if (code !== 0) {
                finish(reject, new Error(`ffprobe exited with code ${code}: ${stderr}`));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                finish(resolve, result);
            } catch (e) {
                finish(reject, new Error('Failed to parse ffprobe output'));
            }
        });

        proc.on('error', (err) => {
            finish(reject, err);
        });
    });
}

/**
 * Analyze probe result and determine compatibility
 */
function analyzeProbeResult(probeResult, url) {
    const streams = probeResult.streams || [];
    const format = probeResult.format || {};

    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioStreams = streams.filter(s => s.codec_type === 'audio');
    const audioStream = audioStreams[0];

    const videoCodec = videoStream?.codec_name?.toLowerCase() || 'unknown';
    const audioCodec = audioStream?.codec_name?.toLowerCase() || 'unknown';
    const container = format.format_name?.toLowerCase() || 'unknown';

    // Check codec compatibility
    const videoOk = BROWSER_VIDEO_CODECS.some(c => videoCodec.includes(c));
    const audioOk = BROWSER_AUDIO_CODECS.some(c => audioCodec.includes(c));

    // Browser-safe containers
    // Note: We exclude 'webm' because ffprobe reports MKV as "matroska,webm", 
    // and H.264/AAC in MKV/WebM is not universally supported. Best to remux to MP4.
    const BROWSER_CONTAINERS = ['hls', 'mp4', 'mov'];
    const containerOk = BROWSER_CONTAINERS.some(c => container.includes(c));

    // Check if it's a raw TS stream (not HLS)
    const isRawTs = (container.includes('mpegts') || url.endsWith('.ts')) && !url.includes('.m3u8');

    // Preserve absolute FFmpeg stream indexes so a later playback request can
    // select the exact embedded audio or subtitle stream.
    const audioTracks = audioStreams.map((stream, position) => ({
        index: stream.index,
        language: stream.tags?.language || 'und',
        title: stream.tags?.title || stream.tags?.language || `Audio ${position + 1}`,
        codec: stream.codec_name || 'unknown',
        channels: stream.channels || 0,
        default: Boolean(stream.disposition?.default)
    }));

    // Extract subtitle tracks
    const subtitles = streams
        .filter(s => s.codec_type === 'subtitle' && s.codec_name !== 'timed_id3' && s.codec_name !== 'bin_data')
        .map(s => ({
            index: s.index,
            language: s.tags?.language || 'und',
            title: s.tags?.title || s.tags?.language || `Track ${s.index}`,
            codec: s.codec_name
        }));

    // Determine what processing is needed
    // 4. MKV files often cause OOM/decoding issues in browser fMP4 remux, 
    // so we force them to "needsTranscode" which uses HLS (more robust).
    // The frontend will still use "copy" mode if codecs are compatible.
    const isMkv = container.includes('matroska') || container.includes('webm') || url.endsWith('.mkv');

    // 1. Incompatible audio/video OR MKV -> Transcode (or HLS Copy)
    const needsTranscode = !audioOk || !videoOk || isMkv;

    // 2. Compatible audio/video but incompatible container (non-MKV) -> Remux (fMP4 pipe)
    const needsRemux = !needsTranscode && (!containerOk || isRawTs);

    const compatible = !needsTranscode && !needsRemux;

    return {
        video: videoCodec,
        audio: audioCodec,
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        audioChannels: audioStream?.channels || 0, // For Smart Audio Copy
        container: container,
        compatible: compatible,
        needsRemux: needsRemux,
        needsTranscode: needsTranscode,
        audioTracks: audioTracks,
        subtitles: subtitles
    };
}

router.get('/', async (req, res) => {
    const { url, ua } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    let validatedUrl;
    try {
        validatedUrl = validateHttpUrl(url);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const ffprobePath = req.app.locals.ffprobePath;
    const cacheKey = `${validatedUrl}${ua ? `|${ua}` : ''}`;

    if (!ffprobePath) {
        // No ffprobe available - assume needs transcoding to be safe
        console.log('[Probe] FFprobe not available, assuming transcode needed');
        return res.json({
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            compatible: false,
            needsRemux: false,
            needsTranscode: true,
            audioTracks: [],
            subtitles: []
        });
    }

    // Check cache
    const cached = probeCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
        console.log(`[Probe] Cache hit for: ${redactUrl(validatedUrl)}`);
        return res.json(cached.result);
    }

    console.log(`[Probe] Probing: ${redactUrl(validatedUrl)} ${ua ? '(custom UA)' : ''}`);

    const probeAbortController = new AbortController();
    const cancelDisconnectedProbe = () => {
        if (!res.writableEnded) probeAbortController.abort();
    };
    res.on('close', cancelDisconnectedProbe);

    try {
        const probeResult = await probeStream(validatedUrl, ffprobePath, ua, 15000, probeAbortController.signal);
        const analysis = analyzeProbeResult(probeResult, validatedUrl);

        // Cache result
        probeCache.set(cacheKey, { result: analysis, expiresAt: Date.now() + CACHE_TTL });

        console.log(`[Probe] Result: video=${analysis.video}, audio=${analysis.audio}, ` +
            `container=${analysis.container}, compatible=${analysis.compatible}, ` +
            `needsRemux=${analysis.needsRemux}, needsTranscode=${analysis.needsTranscode}`);

        res.json(analysis);
    } catch (err) {
        if (err.name === 'AbortError' || probeAbortController.signal.aborted) return;
        console.error('[Probe] Failed:', redactText(err.message));

        // Briefly cache failures so a browser retry does not immediately open
        // another connection to an already rate-limited provider.
        const fallback = {
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            compatible: false,
            needsRemux: false,
            needsTranscode: true,
            audioTracks: [],
            subtitles: [],
            error: err.message
        };
        probeCache.set(cacheKey, { result: fallback, expiresAt: Date.now() + FAILURE_CACHE_TTL });
        res.json(fallback);
    } finally {
        res.off('close', cancelDisconnectedProbe);
    }
});

module.exports = router;
