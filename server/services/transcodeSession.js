/**
 * Transcode Session Service
 * 
 * Manages HLS transcoding sessions with segment caching for VOD seeking.
 * Each session transcodes a source URL to HLS segments on disk.
 * 
 * Key features:
 * - Session-based transcoding with unique IDs
 * - HLS segment output for seeking support
 * - Segment caching for fast access
 * - Automatic cleanup of stale sessions
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const EventEmitter = require('events');
const hwDetect = require('./hwDetect');
const { FFMPEG_PROTOCOL_WHITELIST, redactText, redactUrl, validateHttpUrl } = require('./urlSecurity');
const { appendHttpReconnectArgs } = require('./ffmpegNetwork');

// Session storage
const sessions = new Map();
const leaseLocks = new Map();

const PLAYBACK_LEASE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

// Cache directory for transcoded segments
const CACHE_DIR = process.env.NODECAST_CACHE_DIR
    ? path.resolve(process.env.NODECAST_CACHE_DIR)
    : path.join(process.cwd(), 'transcode-cache');

// Session settings
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes idle timeout
const SEGMENT_DURATION = 4; // seconds per HLS segment
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const MAX_ACTIVE_SESSIONS = 12;
const MAX_ACTIVE_SESSIONS_PER_USER = 4;
const LIVE_RESTART_DELAY_MS = 250;
const LIVE_STABLE_RUN_MS = 10 * 1000;
const MAX_RAPID_LIVE_RESTARTS = 4;

/**
 * Generate a unique session ID
 */
function generateSessionId() {
    return crypto.randomBytes(8).toString('hex');
}

function normalizePlaybackLeaseId(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !PLAYBACK_LEASE_ID_PATTERN.test(value)) {
        const error = new Error('playbackLeaseId must be a valid opaque identifier');
        error.statusCode = 400;
        throw error;
    }
    return value;
}

function getLeaseKey(ownerId, playbackLeaseId) {
    if (ownerId === null || ownerId === undefined || !playbackLeaseId) return null;
    return `${String(ownerId)}:${playbackLeaseId}`;
}

function getLeaseTag(playbackLeaseId) {
    if (!playbackLeaseId) return null;
    return crypto.createHash('sha256').update(playbackLeaseId).digest('hex').slice(0, 10);
}

async function withLeaseLock(leaseKey, task) {
    if (!leaseKey) return task();

    const previous = leaseLocks.get(leaseKey) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    leaseLocks.set(leaseKey, current);

    await previous.catch(() => {});
    try {
        return await task();
    } finally {
        release();
        if (leaseLocks.get(leaseKey) === current) leaseLocks.delete(leaseKey);
    }
}

/**
 * Ensure cache directory exists
 */
async function ensureCacheDir() {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
}

/**
 * TranscodeSession class
 * Manages a single transcoding session from source URL to HLS segments
 */
class TranscodeSession extends EventEmitter {
    constructor(url, options = {}) {
        super();
        this.id = generateSessionId();
        this.url = validateHttpUrl(url);
        this.dir = path.join(CACHE_DIR, this.id);
        this.playlistPath = path.join(this.dir, 'stream.m3u8');
        this.process = null;
        this.restartTimer = null;
        this.processStartedAt = 0;
        this.rapidLiveRestartCount = 0;
        this.retired = false;
        this.segments = new Map(); // segment index -> { ready: boolean, path: string }
        this.status = 'pending'; // pending | starting | running | stopped | error
        this.error = null;
        this.startTime = Date.now();
        this.mediaStartTime = Math.max(0, Number(options.seekOffset) || 0);
        this.lastAccess = Date.now();
        this.ownerId = options.ownerId ?? null;
        this.playbackLeaseId = normalizePlaybackLeaseId(options.playbackLeaseId);
        this.playbackLeaseTag = getLeaseTag(this.playbackLeaseId);
        this.options = {
            ffmpegPath: options.ffmpegPath || 'ffmpeg',
            ffprobePath: options.ffprobePath || 'ffprobe',
            userAgent: options.userAgent || 'Mozilla/5.0',
            seekOffset: options.seekOffset || 0,
            hwEncoder: options.hwEncoder || 'software',
            maxResolution: options.maxResolution || '1080p',
            quality: options.quality || 'medium',
            // Upscaling options
            upscaleEnabled: options.upscaleEnabled || false,
            upscaleMethod: options.upscaleMethod || 'hardware', // 'hardware' or 'software'
            upscaleTarget: options.upscaleTarget || '1080p',
            ...options
        };
    }

    /**
     * Start the transcoding process
     */
    async start() {
        if (this.retired) {
            const error = new Error('Transcode session was replaced before startup completed');
            error.statusCode = 409;
            throw error;
        }
        if (this.status === 'running' || this.process) {
            return;
        }

        this.status = 'starting';
        console.log(`[TranscodeSession ${this.id}] Starting session for: ${redactUrl(this.url)}`);

        // Create session directory
        try {
            await fs.mkdir(this.dir, { recursive: true });
        } catch (err) {
            this.status = 'error';
            this.error = err.message;
            throw err;
        }

        // Build FFmpeg arguments for HLS output
        const args = this.buildFFmpegArgs();

        try {
            const activeProcess = spawn(this.options.ffmpegPath, args, {
                cwd: this.dir,
                windowsHide: true
            });
            this.process = activeProcess;
            this.processStartedAt = Date.now();

            this.status = 'running';

            // Handle stdout (should be empty for file output)
            activeProcess.stdout.on('data', (data) => {
                console.log(`[TranscodeSession ${this.id}] stdout: ${data}`);
            });

            // Handle stderr (FFmpeg progress/errors)
            let stderrBuffer = '';
            activeProcess.stderr.on('data', (data) => {
                stderrBuffer += data.toString();
                // Log periodically to avoid spam
                const lines = stderrBuffer.split('\n');
                if (lines.length > 1) {
                    lines.slice(0, -1).forEach(line => {
                        if (line.trim()) {
                            console.log(`[FFmpeg ${this.id}] ${redactText(line)}`);
                        }
                    });
                    stderrBuffer = lines[lines.length - 1];
                }
            });

            // Handle process exit
            activeProcess.on('exit', (code) => {
                if (this.process === activeProcess) this.process = null;

                if (this.options.livePlayback === true && !this.retired) {
                    this.scheduleLiveRestart(code);
                } else if (code === 0 || code === null) {
                    console.log(`[TranscodeSession ${this.id}] FFmpeg completed successfully`);
                    this.status = 'stopped';
                } else if (code !== 255) { // 255 is often from SIGKILL
                    console.error(`[TranscodeSession ${this.id}] FFmpeg exited with code ${code}`);
                    this.status = 'error';
                    this.error = `FFmpeg exited with code ${code}`;
                }
                this.emit('exit', code);
            });

            // Handle spawn errors
            activeProcess.on('error', (err) => {
                console.error(`[TranscodeSession ${this.id}] FFmpeg error:`, err);
                this.status = 'error';
                this.error = err.message;
                this.emit('error', err);
            });

            // A rapid replacement can retire a pending session between the
            // initial check and process creation. Never let that process outlive
            // the lease that created it.
            if (this.retired && this.process) {
                this.process.kill('SIGKILL');
                this.status = 'stopped';
            }

        } catch (err) {
            this.status = 'error';
            this.error = err.message;
            throw err;
        }
    }

    scheduleLiveRestart(code) {
        if (this.retired || this.restartTimer) return;

        const runDuration = Date.now() - this.processStartedAt;
        if (runDuration >= LIVE_STABLE_RUN_MS) {
            this.rapidLiveRestartCount = 0;
        } else {
            this.rapidLiveRestartCount += 1;
        }

        if (this.rapidLiveRestartCount > MAX_RAPID_LIVE_RESTARTS) {
            this.status = 'error';
            this.error = 'Live input repeatedly disconnected before playback stabilized';
            console.error(`[TranscodeSession ${this.id}] ${this.error}`);
            return;
        }

        this.status = 'reconnecting';
        console.warn(
            `[TranscodeSession ${this.id}] Live input ended (code ${code ?? 'signal'}); reopening a fresh connection`
        );
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.retired) return;
            this.start().catch(error => {
                this.status = 'error';
                this.error = error.message;
                console.error(`[TranscodeSession ${this.id}] Live input restart failed: ${redactText(error.message)}`);
            });
        }, LIVE_RESTART_DELAY_MS);
        this.restartTimer.unref?.();
    }

    /**
     * Build FFmpeg arguments for HLS output with optional GPU encoding
     */
    buildFFmpegArgs() {
        const segmentPattern = path.join(this.dir, 'seg%04d.m4s');
        const videoMode = this.options.videoMode || 'encode';

        // Resolve 'auto' encoder to detected hardware, fallback to software
        let encoder = this.options.hwEncoder || 'software';
        if (encoder === 'auto') {
            const hwCaps = hwDetect.getCapabilities();
            encoder = hwCaps?.recommended || 'software';
            console.log(`[TranscodeSession ${this.id}] Auto encoder resolved to: ${encoder}`);
        }

        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-user_agent', this.options.userAgent,
        ];

        // Add hardware acceleration input options based on encoder (only if encoding)
        if (videoMode === 'encode') {
            this.addHwAccelInputArgs(args, encoder);
        }

        // Input options (common)
        const reconnectArgs = this.options.livePlayback === true
            ? []
            : appendHttpReconnectArgs([]);
        args.push(
            '-probesize', '2000000',
            '-analyzeduration', '3000000',
            '-fflags', '+genpts+discardcorrupt',
            '-err_detect', 'ignore_err',
            ...reconnectArgs
        );

        args.push('-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST);

        // VOD seeks must happen before opening the input so FFmpeg can use HTTP
        // byte ranges instead of reading and discarding everything from the
        // beginning. The non-seek path retains the provider-compatible setting
        // that avoids speculative Range/HEAD requests during ordinary startup.
        if (this.options.seekOffset > 0) {
            // Video is frequently stream-copied while incompatible audio is
            // transcoded. Accurate input seeking discards the audio preroll but
            // cannot discard copied video packets, leaving the first HLS segment
            // with a multi-second A/V timestamp gap in some containers. Keep the
            // same seek preroll for every mapped stream so browser decoders begin
            // from one coherent clock.
            // Retain the source clock so the first generated segment can report
            // the actual keyframe/audio preroll used for stream-copy seeking.
            args.push('-copyts', '-ss', String(this.options.seekOffset), '-noaccurate_seek');
        } else {
            args.push('-seekable', '0');
        }

        args.push('-i', this.url);

        // Map streams
        args.push('-map', '0:v:0');
        const audioMap = Number.isInteger(this.options.audioStreamIndex)
            ? `0:${this.options.audioStreamIndex}?`
            : '0:a:0?';
        args.push('-map', audioMap);

        // Add video encoder and filters based on selected encoder OR copy
        if (videoMode === 'copy') {
            args.push('-c:v', 'copy');

            // Critical for MKV/MP4 -> TS copy: Convert bitstream from AVCC/HVCC to Annex B
            if (this.options.videoCodec === 'hevc' || this.options.videoCodec === 'h265') {
                args.push('-bsf:v', 'hevc_mp4toannexb');
            } else if (this.options.videoCodec === 'h264' || this.options.videoCodec === 'avc') {
                args.push('-bsf:v', 'h264_mp4toannexb');
            } else {
                // Fallback (e.g. unknown codec), try strict extraction
                args.push('-bsf:v', 'dump_extra');
            }
        } else {
            this.addVideoEncoderArgs(args, encoder);
        }

        // Audio: Apply mix preset
        const audioCodec = this.options.audioCodec?.toLowerCase() || 'unknown';
        const audioChannels = this.options.audioChannels || 0;
        const audioMixPreset = this.options.audioMixPreset || 'auto';
        const forceAudioTranscode = this.options.forceAudioTranscode === true;
        const isStereoAac = audioCodec.includes('aac') && audioChannels === 2;

        // Define pan filter presets for 5.1 -> Stereo downmix
        const AUDIO_MIX_FILTERS = {
            // ITU-R BS.775 Standard: Mathematically balanced, transparent
            itu: 'pan=stereo|FL=FL+0.707*FC+0.707*BL+0.5*LFE|FR=FR+0.707*FC+0.707*BR+0.5*LFE',
            // Night Mode: Heavy dialogue boost, reduced bass/surrounds for quiet viewing
            night: 'pan=stereo|FL=0.5*FL+1.2*FC+0.3*BL+0.1*LFE|FR=0.5*FR+1.2*FC+0.3*BR+0.1*LFE',
            // Cinematic: Wide soundstage, immersive (original "dialogue boost" mix)
            cinematic: 'pan=stereo|FL=FC+0.80*FL+0.60*BL+0.5*LFE|FR=FC+0.80*FR+0.60*BR+0.5*LFE'
        };

        if (forceAudioTranscode) {
            // Firefox does not reliably expose audio from the low-latency
            // fragmented-MP4 remux response. Normalize it into stereo AAC-LC
            // inside the HLS compatibility path while leaving video untouched.
            console.log(`[TranscodeSession ${this.id}] Audio: Compatibility transcode (${audioCodec} ${audioChannels}ch -> Stereo AAC-LC)`);
            args.push(
                '-c:a', 'aac',
                '-profile:a', 'aac_low',
                '-ar', '48000',
                '-ac', '2',
                '-b:a', '192k',
                '-af', 'aresample=async=1'
            );
        } else if (audioMixPreset === 'passthrough') {
            // Passthrough: Always copy audio, no processing
            console.log(`[TranscodeSession ${this.id}] Audio: Passthrough (copy)`);
            args.push('-c:a', 'copy');
        } else if (audioMixPreset === 'auto' && isStereoAac) {
            // Auto + Stereo AAC source: Smart copy
            console.log(`[TranscodeSession ${this.id}] Audio: Auto (Smart Copy) - Source is Stereo AAC`);
            args.push('-c:a', 'copy');
        } else {
            // Transcode to AAC with selected mix preset (default to ITU for 'auto')
            const mixPreset = (audioMixPreset === 'auto') ? 'itu' : audioMixPreset;
            const panFilter = AUDIO_MIX_FILTERS[mixPreset] || AUDIO_MIX_FILTERS.itu;

            console.log(`[TranscodeSession ${this.id}] Audio: ${mixPreset.toUpperCase()} mix (${audioCodec} ${audioChannels}ch -> Stereo AAC)`);
            args.push(
                '-c:a', 'aac',
                '-ar', '48000',
                '-b:a', '192k',
                '-af', `${panFilter},aresample=async=1`
            );
        }

        // HLS output options
        if (this.options.seekOffset > 0) {
            // With -copyts, remove the MPEG-TS muxer's artificial timestamp
            // lead so ffprobe reports the real source time of the first packet.
            args.push('-muxpreload', '0', '-muxdelay', '0');
        }
        const hlsFlags = this.options.livePlayback === true
            ? 'independent_segments+append_list+omit_endlist'
            : 'independent_segments+append_list';
        args.push(
            '-f', 'hls',
            '-hls_time', String(SEGMENT_DURATION),
            '-hls_list_size', '0', // Keep all segments in playlist
            '-hls_flags', hlsFlags,
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', path.join(this.dir, 'seg%04d.ts'),
            this.playlistPath
        );

        return args;
    }

    /**
     * Add hardware acceleration input arguments
     */
    addHwAccelInputArgs(args, encoder) {
        switch (encoder) {
            case 'nvenc':
                // NVIDIA CUDA/NVDEC hardware decoding
                args.push(
                    '-hwaccel', 'cuda',
                    '-hwaccel_output_format', 'cuda'
                );
                break;
            case 'vaapi':
                // VAAPI hardware decoding (Linux)
                args.push(
                    '-hwaccel', 'vaapi',
                    '-hwaccel_device', '/dev/dri/renderD128',
                    '-hwaccel_output_format', 'vaapi'
                );
                break;
            case 'qsv':
                // Intel QuickSync hardware decoding
                args.push(
                    '-hwaccel', 'qsv',
                    '-hwaccel_output_format', 'qsv'
                );
                break;
            case 'amf':
                // AMD AMF (no hwaccel input, AMF is encode-only)
                // Decode on CPU, encode on GPU
                break;
            case 'software':
            case 'auto':
            default:
                // No hardware acceleration for input
                break;
        }
    }

    /**
     * Add video encoder arguments based on selected encoder
     */
    addVideoEncoderArgs(args, encoder) {
        const resolution = this.getTargetHeight();
        const quality = this.options.quality || 'medium';

        // Quality presets mapping
        const qualityPresets = {
            'high': { nvenc: 18, vaapi: 18, qsv: 18, amf: 18, software: 18 },
            'medium': { nvenc: 24, vaapi: 24, qsv: 24, amf: 24, software: 23 },
            'low': { nvenc: 30, vaapi: 30, qsv: 30, amf: 30, software: 28 }
        };
        const qp = qualityPresets[quality] || qualityPresets.medium;

        switch (encoder) {
            case 'nvenc':
                this.addNvencEncoderArgs(args, resolution, qp.nvenc);
                break;
            case 'amf':
                this.addAmfEncoderArgs(args, resolution, qp.amf);
                break;
            case 'vaapi':
                this.addVaapiEncoderArgs(args, resolution, qp.vaapi);
                break;
            case 'qsv':
                this.addQsvEncoderArgs(args, resolution, qp.qsv);
                break;
            case 'software':
            case 'auto':
            default:
                this.addSoftwareEncoderArgs(args, resolution, qp.software);
                break;
        }
    }

    /**
     * Get target height based on maxResolution or upscaleTarget setting
     * When upscaling is enabled, uses the upscaleTarget resolution.
     * Otherwise, uses maxResolution to cap the output.
     */
    getTargetHeight() {
        const resolutionMap = {
            '4k': 2160,
            '1080p': 1080,
            '720p': 720,
            '480p': 480
        };

        // When upscaling is enabled, use the upscale target resolution
        if (this.options.upscaleEnabled) {
            const target = resolutionMap[this.options.upscaleTarget] || 1080;
            console.log(`[TranscodeSession ${this.id}] Upscale target height: ${target}p`);
            return target;
        }

        // Otherwise, use max resolution as the cap
        return resolutionMap[this.options.maxResolution] || 1080;
    }

    /**
     * Build scale filter string based on encoder and upscaling settings
     * @param {string} encoder - The encoder being used
     * @param {number} height - Target height
     */
    buildScaleFilter(encoder, height) {
        const useUpscale = this.options.upscaleEnabled;
        const upscaleMethod = this.options.upscaleMethod || 'hardware';
        const sourceHeight = Number(this.options.videoHeight);
        const effectiveHeight = !useUpscale && Number.isInteger(sourceHeight) && sourceHeight > 0
            ? Math.min(height, sourceHeight)
            : height;

        // Log upscaling status
        if (useUpscale) {
            console.log(`[TranscodeSession ${this.id}] Upscaling: ${upscaleMethod} method to ${effectiveHeight}p`);
        } else if (effectiveHeight < height) {
            console.log(`[TranscodeSession ${this.id}] Source ${sourceHeight}p is below the ${height}p cap; preserving its resolution`);
        }

        // Hardware scaling filters (for both upscale and downscale)
        if (upscaleMethod === 'hardware' || !useUpscale) {
            switch (encoder) {
                case 'nvenc':
                    // NVIDIA CUDA scaling with Lanczos
                    // Force nv12 (8-bit) output to handle 10-bit inputs (fixes "10 bit encode not supported")
                    return `scale_cuda=-2:${effectiveHeight}:interp_algo=lanczos:format=nv12`;
                case 'vaapi':
                    return `scale_vaapi=w=-2:h=${effectiveHeight}:format=nv12`;
                case 'qsv':
                    return `scale_qsv=w=-2:h=${effectiveHeight}:format=nv12`;
                case 'amf':
                    // AMF uses CPU decode, so use software scale
                    return useUpscale ? `scale=-2:${effectiveHeight}:flags=lanczos` : `scale=-2:${effectiveHeight}`;
                case 'software':
                default:
                    return useUpscale ? `scale=-2:${effectiveHeight}:flags=lanczos` : `scale=-2:${effectiveHeight}`;
            }
        }

        // Software Lanczos scaling (high quality, slower)
        return `scale=-2:${effectiveHeight}:flags=lanczos`;
    }

    /**
     * NVIDIA NVENC encoder arguments
     */
    addNvencEncoderArgs(args, height, qp) {
        // Video filter for scaling on GPU
        args.push('-vf', this.buildScaleFilter('nvenc', height));

        // NVENC encoder with quality settings
        // Using portable options that work across FFmpeg builds
        args.push(
            '-c:v', 'h264_nvenc',
            '-preset', 'p4',           // Balanced preset (p1=fastest, p7=best)
            '-rc', 'constqp',          // Constant QP mode
            '-qp', String(qp),
            '-bf', '3'                 // B-frames for better compression
        );
    }

    /**
     * AMD AMF encoder arguments
     */
    addAmfEncoderArgs(args, height, qp) {
        // CPU decoding + software scale + AMF encode
        args.push('-vf', this.buildScaleFilter('amf', height));

        args.push(
            '-c:v', 'h264_amf',
            '-quality', 'quality',     // Quality preset
            '-rc', 'cqp',              // Constant QP
            '-qp_i', String(qp),
            '-qp_p', String(qp + 2),
            '-qp_b', String(qp + 4),
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility
        );
    }

    /**
     * VAAPI encoder arguments (Linux)
     */
    addVaapiEncoderArgs(args, height, qp) {
        // VAAPI filter chain:
        // 1. scale_vaapi to resize on GPU
        // 2. Ensure output format is nv12 for maximum encoder compatibility
        // The format is handled automatically when using -hwaccel_output_format vaapi
        args.push('-vf', this.buildScaleFilter('vaapi', height));

        // VAAPI encoder with quality setting
        // Note: -global_quality is the portable way to set quality for VAAPI
        args.push(
            '-c:v', 'h264_vaapi',
            '-profile:v', 'main',      // Use main profile for compatibility
            '-global_quality', String(qp),
            '-bf', '3',
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility
        );
    }

    /**
     * Intel QuickSync encoder arguments
     */
    addQsvEncoderArgs(args, height, qp) {
        // Scale on QSV
        args.push('-vf', this.buildScaleFilter('qsv', height));

        args.push(
            '-c:v', 'h264_qsv',
            '-preset', 'medium',
            '-global_quality', String(qp),
            '-look_ahead', '1',
            '-look_ahead_depth', '40',
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility
        );
    }

    /**
     * Software encoder arguments (fallback)
     */
    addSoftwareEncoderArgs(args, height, crf) {
        // Software scaling (use Lanczos for upscaling if enabled)
        args.push('-vf', this.buildScaleFilter('software', height));

        args.push(
            '-c:v', 'libx264',
            '-preset', 'veryfast',     // Fast for real-time
            '-crf', String(crf),
            '-profile:v', 'high',
            '-level', '4.1',
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility (fixes 10-bit input errors)
        );
    }

    /**
     * Stop the transcoding process
     */
    async stop() {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        const activeProcess = this.process;
        if (activeProcess) {
            console.log(`[TranscodeSession ${this.id}] Stopping FFmpeg process`);
            const waitForExit = () => new Promise(resolve => {
                if (activeProcess.exitCode !== null || activeProcess.signalCode !== null) {
                    resolve(true);
                    return;
                }
                activeProcess.once('exit', () => resolve(true));
            });
            const wait = ms => new Promise(resolve => setTimeout(() => resolve(false), ms));

            activeProcess.kill('SIGTERM');
            const exited = await Promise.race([waitForExit(), wait(2000)]);
            if (!exited && this.process === activeProcess) {
                activeProcess.kill('SIGKILL');
                await Promise.race([waitForExit(), wait(1000)]);
            }
        }
        this.status = 'stopped';
    }

    /**
     * Update last access time (prevents cleanup)
     */
    touch() {
        this.lastAccess = Date.now();
    }

    /**
     * Check if playlist exists and is ready
     */
    async isPlaylistReady() {
        try {
            const content = await fs.readFile(this.playlistPath, 'utf8');
            // Check if playlist has at least one segment
            return content.includes('.ts');
        } catch {
            return false;
        }
    }

    /**
     * Wait for playlist to be ready (with timeout)
     */
    async waitForPlaylist(timeoutMs = 10000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            if (await this.isPlaylistReady()) {
                return true;
            }
            if (this.status === 'error' || this.status === 'stopped') {
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return false;
    }

    async resolveMediaStartTime() {
        if (!(this.options.seekOffset > 0)) {
            this.mediaStartTime = 0;
            return this.mediaStartTime;
        }

        const segmentPath = path.join(this.dir, 'seg0000.ts');
        const value = await new Promise((resolve, reject) => {
            const probe = spawn(this.options.ffprobePath, [
                '-v', 'error',
                '-show_entries', 'format=start_time',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                segmentPath
            ], { windowsHide: true });
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
                probe.kill('SIGKILL');
                reject(new Error('First-segment timestamp probe timed out'));
            }, 5000);
            probe.stdout.on('data', chunk => { stdout += chunk; });
            probe.stderr.on('data', chunk => { stderr += chunk; });
            probe.on('error', error => {
                clearTimeout(timer);
                reject(error);
            });
            probe.on('close', code => {
                clearTimeout(timer);
                if (code !== 0) {
                    reject(new Error(`First-segment timestamp probe failed: ${redactText(stderr)}`));
                    return;
                }
                resolve(Number(stdout.trim()));
            });
        });

        if (!Number.isFinite(value) || value < 0) {
            throw new Error('First-segment timestamp probe returned an invalid value');
        }
        this.mediaStartTime = value;
        return this.mediaStartTime;
    }

    /**
     * Start FFmpeg and retry once when a provider rejects the initial
     * connection before any playlist data is produced.
     */
    async startAndWaitForPlaylist(timeoutMs = 10000, maxAttempts = 2) {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            await this.start();
            if (await this.waitForPlaylist(timeoutMs)) {
                await this.resolveMediaStartTime();
                return true;
            }
            if (this.status !== 'error' || attempt === maxAttempts) return false;

            console.warn(`[TranscodeSession ${this.id}] Initial connection failed; retrying once`);
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return false;
    }

    /**
     * Get the HLS playlist content
     */
    async getPlaylist() {
        this.touch();
        try {
            return await fs.readFile(this.playlistPath, 'utf8');
        } catch (err) {
            return null;
        }
    }

    /**
     * Get a specific segment
     */
    async getSegment(segmentName) {
        this.touch();
        if (!/^seg\d{4,12}\.ts$/.test(segmentName)) return null;
        const sessionDirectory = path.resolve(this.dir);
        const segmentPath = path.resolve(sessionDirectory, segmentName);
        if (!segmentPath.startsWith(`${sessionDirectory}${path.sep}`)) return null;
        try {
            await fs.access(segmentPath);
            return segmentPath;
        } catch {
            return null;
        }
    }

    /**
     * Delete session directory and all segments
     */
    async cleanup() {
        this.retired = true;
        await this.stop();
        try {
            await fs.rm(this.dir, { recursive: true, force: true });
            console.log(`[TranscodeSession ${this.id}] Cleaned up session directory`);
        } catch (err) {
            console.error(`[TranscodeSession ${this.id}] Failed to cleanup:`, err.message);
        }
    }
}

/**
 * Session Manager
 */

/**
 * Create a new transcode session
 */
async function createSession(url, options = {}) {
    const ownerId = options.ownerId ?? null;
    const playbackLeaseId = normalizePlaybackLeaseId(options.playbackLeaseId);
    const leaseKey = getLeaseKey(ownerId, playbackLeaseId);

    return withLeaseLock(leaseKey, async () => {
        if (leaseKey) {
            const replacedSessions = Array.from(sessions.values()).filter(session => (
                session.ownerId === ownerId
                && session.playbackLeaseId === playbackLeaseId
            ));
            for (const replacedSession of replacedSessions) {
                await removeSession(replacedSession.id, ownerId, 'replaced');
            }
        }

        const activeSessions = Array.from(sessions.values()).filter(
            session => !['stopped', 'error'].includes(session.status)
        );
        const ownerSessions = activeSessions.filter(session => session.ownerId === ownerId);
        if (
            activeSessions.length >= MAX_ACTIVE_SESSIONS
            || ownerSessions.length >= MAX_ACTIVE_SESSIONS_PER_USER
        ) {
            const error = new Error('Too many transcode sessions are already running. Try again shortly.');
            error.statusCode = 429;
            throw error;
        }
        await ensureCacheDir();
        const session = new TranscodeSession(url, { ...options, playbackLeaseId });
        sessions.set(session.id, session);
        if (session.playbackLeaseTag) {
            console.log(`[TranscodeSession ${session.id}] Acquired playback lease ${session.playbackLeaseTag}`);
        }
        return session;
    });
}

/**
 * Get an existing session by ID
 */
function getSession(sessionId, ownerId = null) {
    const session = sessions.get(sessionId);
    if (session && ownerId !== null && session.ownerId !== ownerId) return null;
    if (session) {
        session.touch();
    }
    return session;
}

/**
 * Get or create a session for a URL (reuses existing if still valid)
 */
async function getOrCreateSession(url, options = {}) {
    // Check for existing session with same URL
    for (const session of sessions.values()) {
        if (session.url === url && session.status === 'running') {
            session.touch();
            return session;
        }
    }
    // Create new session
    return createSession(url, options);
}

/**
 * Stop and remove a session
 */
async function removeSession(sessionId, ownerId = null, reason = 'requested') {
    const session = sessions.get(sessionId);
    if (session && ownerId !== null && session.ownerId !== ownerId) return false;
    if (session) {
        console.log(`[TranscodeSession ${session.id}] Removing session (${reason})`);
        await session.cleanup();
        sessions.delete(sessionId);
        return true;
    }
    return false;
}

async function releasePlaybackLease(ownerId, playbackLeaseId) {
    const normalizedLeaseId = normalizePlaybackLeaseId(playbackLeaseId);
    const leaseKey = getLeaseKey(ownerId, normalizedLeaseId);
    if (!leaseKey) return 0;

    return withLeaseLock(leaseKey, async () => {
        const ownedSessions = Array.from(sessions.values()).filter(session => (
            session.ownerId === ownerId
            && session.playbackLeaseId === normalizedLeaseId
        ));
        for (const session of ownedSessions) {
            await removeSession(session.id, ownerId, 'lease released');
        }
        return ownedSessions.length;
    });
}

/**
 * Cleanup stale sessions (idle for too long)
 */
async function cleanupStaleSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
            console.log(`[TranscodeSession] Cleaning up stale session ${id}`);
            await removeSession(id, null, 'stale');
        }
    }
}

/**
 * Start cleanup interval
 */
let cleanupInterval = null;
function startCleanupInterval() {
    if (!cleanupInterval) {
        cleanupInterval = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
        cleanupInterval.unref(); // Don't prevent process exit
    }
}

/**
 * Get all active sessions (for debugging/monitoring)
 */
function getAllSessions() {
    return Array.from(sessions.values()).map(s => ({
        id: s.id,
        url: redactUrl(s.url),
        status: s.status,
        startTime: s.startTime,
        lastAccess: s.lastAccess,
        idleMs: Date.now() - s.lastAccess,
        playbackLeaseTag: s.playbackLeaseTag
    }));
}

module.exports = {
    TranscodeSession,
    createSession,
    getSession,
    getOrCreateSession,
    removeSession,
    releasePlaybackLease,
    normalizePlaybackLeaseId,
    cleanupStaleSessions,
    startCleanupInterval,
    getAllSessions,
    CACHE_DIR,
    SEGMENT_DURATION
};
