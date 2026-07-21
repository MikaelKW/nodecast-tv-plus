/**
 * Watch Page Controller
 * Handles VOD (Movies/Series) playback with streaming service-style UI
 */

class WatchPage {
    constructor(app) {
        this.app = app;

        // Video elements
        this.video = document.getElementById('watch-video');
        this.overlay = document.getElementById('watch-overlay');

        // iOS: ensure inline playback (not fullscreen by default)
        if (this.video) {
            this.video.setAttribute('playsinline', '');
            this.video.setAttribute('webkit-playsinline', '');
        }

        // Top bar
        this.backBtn = document.getElementById('watch-back-btn');
        this.titleEl = document.getElementById('watch-title');
        this.subtitleEl = document.getElementById('watch-subtitle');

        // Controls
        this.centerPlayBtn = document.getElementById('watch-center-play');
        this.playPauseBtn = document.getElementById('watch-play-pause');
        this.skipBackBtn = document.getElementById('watch-skip-back');
        this.skipFwdBtn = document.getElementById('watch-skip-fwd');
        this.muteBtn = document.getElementById('watch-mute');
        this.volumeSlider = document.getElementById('watch-volume');
        this.fullscreenBtn = document.getElementById('watch-fullscreen');
        this.progressSlider = document.getElementById('watch-progress');
        this.timeCurrent = document.getElementById('watch-time-current');
        this.timeTotal = document.getElementById('watch-time-total');
        this.scrollHint = document.getElementById('watch-scroll-hint');
        this.loadingSpinner = document.getElementById('watch-loading');

        // Next episode
        this.nextEpisodePanel = document.getElementById('watch-next-episode');
        this.nextEpisodeTitle = document.getElementById('next-episode-title');
        this.nextCountdown = document.getElementById('next-countdown');
        this.nextPlayNowBtn = document.getElementById('next-play-now');
        this.nextCancelBtn = document.getElementById('next-cancel');

        // Details section
        this.posterEl = document.getElementById('watch-poster');
        this.contentTitleEl = document.getElementById('watch-content-title');
        this.yearEl = document.getElementById('watch-year');
        this.ratingEl = document.getElementById('watch-rating');
        this.durationEl = document.getElementById('watch-duration');
        this.descriptionEl = document.getElementById('watch-description');
        this.playBtn = document.getElementById('watch-play-btn');
        this.playBtnText = document.getElementById('watch-play-btn-text');
        this.favoriteBtn = document.getElementById('watch-favorite-btn');

        // Recommended / Episodes
        this.recommendedSection = document.getElementById('watch-recommended');
        this.recommendedGrid = document.getElementById('watch-recommended-grid');
        this.episodesSection = document.getElementById('watch-episodes');
        this.seasonsContainer = document.getElementById('watch-seasons');

        // Captions
        this.captionsBtn = document.getElementById('watch-captions-btn');
        this.captionsMenu = document.getElementById('watch-captions-menu');
        this.captionsList = document.getElementById('watch-captions-list');
        this.audioList = document.getElementById('watch-audio-list');

        // Transcode Status
        this.transcodeStatusEx = document.getElementById('watch-transcode-status');
        this.qualityBadgeEl = document.getElementById('watch-quality-badge');
        this.qualityBtn = document.getElementById('watch-quality-btn');
        this.qualityMenu = document.getElementById('watch-quality-menu');

        // State
        this.hls = null;
        this.hlsRecoveryTimer = null;
        this.hlsRecoveryCount = 0;
        this.hlsMediaRecoveryCount = 0;
        this.sourceUrl = null;
        this.playbackQuality = 'auto';
        this.qualityChanging = false;
        this.qualityCapWarning = null;
        this.qualityCapPending = false;
        this.settings = {};
        this.content = null;
        this.contentType = null; // 'movie' or 'series'
        this.seriesInfo = null;
        this.currentSeason = null;
        this.currentEpisode = null;
        this.isFavorite = false;
        this.returnPage = null;
        this.captionsMenuOpen = false;
        this.availableAudioTracks = [];
        this.availableSubtitleTracks = [];
        this.subtitleStreamUrl = null;
        this.probeSubtitleCues = new WeakMap();
        this.probeSubtitleWindows = new WeakMap();
        this.probeSubtitleLoads = new WeakMap();
        this.subtitleLoadControllers = new Set();
        this.selectedSubtitleStreamIndex = null;
        this.subtitleRestoreTimers = [];
        this.subtitleWindowDuration = 60;
        this.subtitleWindowStep = 50;
        this.subtitleWindowLookBehind = 10;
        this.subtitleLoadingEnabled = false;
        this.audioTrackMode = 'none';
        this.selectedAudioTrackIndex = null;
        this.selectedHlsAudioTrack = -1;
        this.audioSelectionExplicit = false;
        this.audioTrackChanging = false;
        // Server-side seeked transcode sessions start their media timeline at
        // zero. Keep the original content position separately so the controls
        // and watch history continue to show the real movie/episode time.
        this.playbackTimeOffset = 0;
        // A transcode playlist grows as FFmpeg generates segments. Keep the
        // original VOD duration separately so the scrubber never treats that
        // temporary playlist length as the full movie or episode.
        this.sourceDuration = 0;
        this.currentTranscodeOptions = null;
        this.seekChanging = false;
        this.progressScrubbing = false;

        // Overlay timer
        this.overlayTimeout = null;
        this.overlayVisible = true;

        // Next episode
        this.nextEpisodeTimeout = null;
        this.nextEpisodeCountdown = 10;
        this.nextEpisodeInterval = null;
        this.nextEpisodeShowing = false;
        this.nextEpisodeDismissed = false;

        // Watch history
        this.historyInterval = null;

        this.init();
    }

    init() {
        // iOS Safari: detect and compensate for floating bottom toolbar
        const updateIosUiBottom = () => {
            let uiBottom = 0;
            if (window.visualViewport) {
                const vv = window.visualViewport;
                uiBottom = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
            }
            document.documentElement.style.setProperty('--ios-ui-bottom', uiBottom + 'px');
        };

        updateIosUiBottom();

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', updateIosUiBottom);
            window.visualViewport.addEventListener('scroll', updateIosUiBottom);
        } else {
            window.addEventListener('resize', updateIosUiBottom);
        }

        // iOS: use custom --vh unit to avoid 100vh issues with dynamic toolbar
        const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
        const watchVideoSection = document.querySelector('.watch-video-section');
        if (isIOS && watchVideoSection) {
            const vh = window.innerHeight * 0.01;
            document.documentElement.style.setProperty('--vh', `${vh}px`);
            watchVideoSection.style.height = 'calc(var(--vh) * 100)';
        }

        // Apply safe area + iOS toolbar padding to overlay
        if (this.overlay) {
            this.overlay.style.paddingBottom = 'calc(env(safe-area-inset-bottom, 0px) + var(--ios-ui-bottom, 0px) + 12px)';
        }

        // Back button
        this.backBtn?.addEventListener('click', () => this.goBack());

        // Play/Pause
        this.centerPlayBtn?.addEventListener('click', () => this.togglePlay());
        this.playPauseBtn?.addEventListener('click', () => this.togglePlay());
        this.video?.addEventListener('click', () => this.togglePlay());

        // Skip buttons
        this.skipBackBtn?.addEventListener('click', () => void this.skip(-10));
        this.skipFwdBtn?.addEventListener('click', () => void this.skip(10));

        // Volume
        this.muteBtn?.addEventListener('click', () => this.toggleMute());
        this.volumeSlider?.addEventListener('input', (e) => this.setVolume(e.target.value));

        // Fullscreen
        this.fullscreenBtn?.addEventListener('click', () => this.toggleFullscreen());

        // Picture-in-Picture
        const pipBtn = document.getElementById('watch-pip');
        pipBtn?.addEventListener('click', () => this.togglePictureInPicture());

        // Overflow Menu
        const overflowBtn = document.getElementById('watch-overflow');
        const overflowMenu = document.getElementById('watch-overflow-menu');

        overflowBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            overflowMenu?.classList.toggle('hidden');
        });

        // Copy Stream URL
        const copyUrlBtn = document.getElementById('watch-copy-url');
        copyUrlBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyStreamUrl();
            overflowMenu?.classList.add('hidden');
        });

        // Close overflow menu when clicking outside
        document.addEventListener('click', (e) => {
            if (overflowMenu && !overflowMenu.classList.contains('hidden') &&
                !overflowMenu.contains(e.target) && e.target !== overflowBtn) {
                overflowMenu.classList.add('hidden');
            }
        });

        // Progress bar
        this.progressSlider?.addEventListener('input', (e) => this.previewSeek(e.target.value));
        this.progressSlider?.addEventListener('change', (e) => {
            void this.seek(e.target.value);
        });

        // Video events
        this.video?.addEventListener('timeupdate', () => {
            this.updateProgress();
            this.ensureSelectedSubtitleWindow();
        });
        this.video?.addEventListener('seeking', () => this.ensureSelectedSubtitleWindow({ prioritize: true }));
        this.video?.addEventListener('loadedmetadata', () => {
            this.onMetadataLoaded();
            this.scheduleSelectedSubtitleRestore();
        });
        this.video?.addEventListener('play', () => this.onPlay());
        this.video?.addEventListener('pause', () => this.onPause());
        this.video?.addEventListener('ended', () => this.onEnded());
        this.video?.addEventListener('error', (e) => this.onError(e));
        this.video?.addEventListener('waiting', () => this.showLoading());
        this.video?.addEventListener('canplay', () => {
            this.hlsMediaRecoveryCount = 0;
            this.hideLoading();
            this.scheduleSelectedSubtitleRestore();
        });

        // Overlay auto-hide + click to toggle play
        const watchSection = document.querySelector('.watch-video-section');
        watchSection?.addEventListener('mousemove', () => this.showOverlay());
        watchSection?.addEventListener('touchstart', () => this.showOverlay());
        watchSection?.addEventListener('click', (e) => {
            this.showOverlay();
            // Only toggle play if clicking on video area (not controls)
            if (e.target === this.video || e.target === watchSection ||
                e.target.classList.contains('watch-overlay') || e.target === this.overlay) {
                this.togglePlay();
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));

        // Details section buttons
        this.playBtn?.addEventListener('click', () => this.scrollToVideo());
        this.favoriteBtn?.addEventListener('click', () => this.toggleFavorite());

        // Next episode buttons
        this.nextPlayNowBtn?.addEventListener('click', () => this.playNextEpisode());
        this.nextCancelBtn?.addEventListener('click', () => this.cancelNextEpisode());

        // Captions toggle
        this.captionsBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCaptionsMenu();
        });

        this.qualityBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = this.qualityBtn?.getAttribute('aria-expanded') !== 'true';
            this.qualityMenu?.classList.toggle('hidden', !willOpen);
            this.qualityBtn?.setAttribute('aria-expanded', String(Boolean(willOpen)));
        });
        this.qualityMenu?.querySelectorAll('.quality-option').forEach(option => {
            option.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.changePlaybackQuality(option.dataset.quality);
            });
        });

        // Close captions menu when clicking outside
        document.addEventListener('click', (e) => {
            if (this.captionsMenuOpen && !this.captionsMenu?.contains(e.target) && e.target !== this.captionsBtn) {
                this.closeCaptionsMenu();
            }
            if (this.qualityMenu && !this.qualityMenu.classList.contains('hidden') &&
                !this.qualityMenu.contains(e.target) && e.target !== this.qualityBtn) {
                this.closeQualityMenu();
            }
        });

        // Hide scroll hint after scrolling
        const watchPage = document.getElementById('page-watch');
        watchPage?.addEventListener('scroll', () => {
            if (watchPage.scrollTop > 50) {
                this.scrollHint?.classList.add('hidden');
            } else {
                this.scrollHint?.classList.remove('hidden');
            }
        });
    }

    /**
     * Main entry point - play content
     * @param {Object} content - Movie or episode info
     * @param {string} streamUrl - Stream URL
     */
    async play(content, streamUrl) {
        this.resetMediaTracks();
        this.playbackTimeOffset = 0;
        this.sourceDuration = 0;
        this.currentTranscodeOptions = null;
        this.content = content;
        this.contentType = content.type;
        this.seriesInfo = content.seriesInfo || null;
        this.currentSeason = content.currentSeason || null;
        this.currentEpisode = content.currentEpisode || null;
        this.resumeTime = content.resumeTime || 0;
        this.containerExtension = content.containerExtension || 'mp4';
        this.returnPage = content.type === 'movie' ? 'movies' : 'series';
        this.sourceUrl = streamUrl;
        this.playbackQuality = 'auto';
        this.updateQualityMenu();

        // Stop any Live TV playback before starting movie/series
        this.app?.player?.stop?.();

        // Reset state
        this.cancelNextEpisode();
        this.nextEpisodeDismissed = false;

        // Navigate to watch page
        this.app.navigateTo('watch', true);

        // Scroll to top
        document.getElementById('page-watch')?.scrollTo(0, 0);

        // Update title bar
        this.titleEl.textContent = content.title || '';
        this.subtitleEl.textContent = content.subtitle || '';

        // Load video
        await this.loadVideo(streamUrl);
        this.subtitleLoadingEnabled = true;

        // Show Now Playing indicator in navbar
        this.showNowPlaying(content.title);

        // Populate details section
        this.renderDetails();

        // Load recommended (movies) or episodes (series)
        if (content.type === 'movie') {
            this.episodesSection?.classList.add('hidden');
            this.recommendedSection?.classList.remove('hidden');
            await this.loadRecommended(content.sourceId, content.categoryId);
        } else {
            this.recommendedSection?.classList.add('hidden');
            this.episodesSection?.classList.remove('hidden');
            this.renderEpisodes();
        }

        // Check favorite status
        await this.checkFavorite();
        // Show overlay initially
        this.showOverlay();

        // Start watch history tracking
        this.startHistoryTracking();
    }

    /**
     * Show Now Playing indicator in navbar
     */
    showNowPlaying(title) {
        const indicator = document.getElementById('now-playing-indicator');
        const textEl = document.getElementById('now-playing-text');
        if (indicator && textEl) {
            textEl.textContent = title || 'Now Playing';
            indicator.classList.remove('hidden');
        }
    }

    /**
     * Hide Now Playing indicator in navbar
     */
    hideNowPlaying() {
        const indicator = document.getElementById('now-playing-indicator');
        if (indicator) {
            indicator.classList.add('hidden');
        }
    }

    /**
     * Start a HLS transcode session
     */
    async startTranscodeSession(url, options = {}) {
        try {
            console.log('[WatchPage] Starting HLS transcode session...', options);
            const seekOffset = Math.max(0, Number(options.seekOffset ?? this.resumeTime) || 0);
            const res = await fetch(NodeCastUrl.resolve('/api/transcode/session'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    ...options,
                    seekOffset
                })
            });
            if (!res.ok) throw new Error('Failed to start session');
            const session = await res.json();
            this.currentSessionId = session.sessionId;
            this.playbackTimeOffset = seekOffset;
            const sessionOptions = { ...options };
            delete sessionOptions.seekOffset;
            this.currentTranscodeOptions = sessionOptions;
            // The backend already applied the resume point. Avoid seeking the
            // shortened HLS timeline a second time in loadedmetadata.
            this.resumeTime = 0;
            return NodeCastUrl.resolve(session.playlistUrl);
        } catch (err) {
            if (options.maxResolution || Number.isInteger(options.audioStreamIndex)) {
                console.warn('[WatchPage] Selected playback session failed:', err.message);
                throw err;
            }
            console.error('[WatchPage] Session start failed:', err);
            // Fallback to direct transcode if session fails
            return NodeCastUrl.resolve(`/api/transcode?url=${encodeURIComponent(url)}`);
        }
    }

    async startQualityPlayback(url, resolution, streamInfo = null) {
        const label = PlaybackQuality.getLabel(resolution);
        console.log(`[WatchPage] Applying session quality cap: ${label}`);
        this.updateTranscodeStatus('transcoding', `Up to ${label}`);
        const playlistUrl = await this.startTranscodeSession(url, {
            videoMode: 'encode',
            maxResolution: resolution,
            videoCodec: streamInfo?.video,
            audioCodec: streamInfo?.audio,
            audioChannels: streamInfo?.audioChannels,
            videoHeight: Number(streamInfo?.height) || undefined,
            ...this.getSelectedAudioOptions(streamInfo)
        });
        this.playHls(playlistUrl);
        this.setVolumeFromStorage();
    }

    /**
     * Stop and cleanup current transcode session
     */
    async stopTranscodeSession() {
        if (this.currentSessionId) {
            const sessionId = this.currentSessionId;
            this.currentSessionId = null;
            console.log('[WatchPage] Stopping transcode session:', sessionId);
            try {
                await fetch(NodeCastUrl.resolve(`/api/transcode/${sessionId}`), { method: 'DELETE' });
            } catch (err) {
                console.error('Failed to stop session:', err);
            }
        }
    }

    async updateTranscodeStatus(mode, text) {
        if (!this.transcodeStatusEx) return;

        this.transcodeStatusEx.className = 'transcode-status'; // Reset classes

        if (mode === 'hidden') {
            this.transcodeStatusEx.classList.add('hidden');
            return;
        }

        this.transcodeStatusEx.textContent = text || mode;
        this.transcodeStatusEx.classList.add(mode);

        // Ensure it's visible
        this.transcodeStatusEx.classList.remove('hidden');
    }

    /**
     * Get quality label from video height
     */
    getQualityLabel(height) {
        if (height >= 2160) return '4K';
        if (height >= 1440) return '1440p';
        if (height >= 1080) return '1080p';
        if (height >= 720) return '720p';
        if (height >= 480) return '480p';
        if (height > 0) return `${height}p`;
        return null;
    }

    /**
     * Explain when browser-detected playback exceeds a global cap that the
     * provider prevented the server from checking or enforcing.
     */
    updatePendingQualityCapWarning(height) {
        if (this.playbackQuality !== 'auto' || !this.settings.autoTranscode) return;

        const globalResolution = this.settings.maxResolution || '1080p';
        const globalHeight = PlaybackQuality.getHeight(globalResolution);
        if (!globalHeight || height <= globalHeight) {
            this.qualityCapPending = false;
            return;
        }
        if (!this.qualityCapPending && !this.qualityCapWarning) return;

        const limitLabel = PlaybackQuality.getLabel(globalResolution);
        const originalLabel = this.getQualityLabel(height) || 'original quality';
        this.qualityCapWarning = `${limitLabel} limit unavailable · Playing original at ${originalLabel}`;
        this.qualityCapPending = false;
        this.updateTranscodeStatus('warning', this.qualityCapWarning);
    }

    /**
     * Update quality badge display
     */
    updateQualityBadge() {
        if (!this.qualityBadgeEl) return;

        if (this.currentStreamInfo?.height > 0) {
            this.qualityBadgeEl.textContent = this.getQualityLabel(this.currentStreamInfo.height);
            this.qualityBadgeEl.classList.remove('hidden');
        } else {
            this.qualityBadgeEl.classList.add('hidden');
        }
    }

    closeQualityMenu() {
        this.qualityMenu?.classList.add('hidden');
        this.qualityBtn?.setAttribute('aria-expanded', 'false');
    }

    updateQualityMenu() {
        if (this.qualityBtn) {
            this.qualityBtn.textContent = PlaybackQuality.getLabel(this.playbackQuality);
        }
        this.qualityMenu?.querySelectorAll('.quality-option').forEach(option => {
            option.classList.toggle('active', option.dataset.quality === this.playbackQuality);
        });
    }

    applyAdaptiveQuality(value) {
        if (!this.hls || this.currentSessionId || !Array.isArray(this.hls.levels)) return false;
        if (value === 'auto') {
            this.hls.autoLevelCapping = -1;
            this.hls.currentLevel = -1;
            this.hls.nextLevel = -1;
            return true;
        }

        const level = PlaybackQuality.findAdaptiveLevel(this.hls.levels, value);
        if (level < 0) return false;
        this.hls.autoLevelCapping = level;
        this.hls.currentLevel = -1;
        this.hls.nextLevel = level;
        return true;
    }

    async changePlaybackQuality(value) {
        if (!PlaybackQuality.isValid(value) || value === this.playbackQuality || !this.sourceUrl || this.qualityChanging) {
            this.closeQualityMenu();
            return;
        }

        const previousQuality = this.playbackQuality;
        const sourceInfo = this.currentStreamInfo ? { ...this.currentStreamInfo } : null;
        const hasActivePlayback = Boolean(this.video?.currentSrc) && this.video.readyState > 0;
        const previousWasDirect = !this.currentSessionId && hasActivePlayback;
        const requestedHeight = PlaybackQuality.getHeight(value);
        const currentHeight = Number(this.currentStreamInfo?.height) || 0;
        const canKeepOriginal = previousWasDirect && (
            value === 'auto' || (currentHeight > 0 && currentHeight <= requestedHeight)
        );
        const canSwitchNatively = this.applyAdaptiveQuality(value) || canKeepOriginal;
        this.playbackQuality = value;
        this.updateQualityMenu();
        this.closeQualityMenu();

        if (canSwitchNatively) {
            this.qualityCapWarning = null;
            const directLabel = this.sourceUrl?.includes('m3u8') ? 'Direct HLS' : 'Direct Play';
            this.updateTranscodeStatus('direct', directLabel);
            return;
        }

        this.qualityChanging = true;
        const resumeAt = this.getCurrentPlaybackTime();
        try {
            this.stopHistoryTracking();
            this.saveProgress();
            await this.stopTranscodeSession();
            if (this.hls) {
                this.hls.destroy();
                this.hls = null;
            }
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
            this.currentStreamInfo = null;
            this.resumeTime = resumeAt;
            if (value !== 'auto') {
                await new Promise(resolve => setTimeout(resolve, 900));
            }
            await this.loadVideo(this.sourceUrl, {
                skipStop: true,
                skipProbe: value !== 'auto',
                qualitySourceInfo: sourceInfo
            });
        } catch (err) {
            console.warn('[WatchPage] Quality change failed; restoring the previous stream:', err.message);
            this.playbackQuality = previousQuality;
            this.updateQualityMenu();
            this.resumeTime = resumeAt;
            await new Promise(resolve => setTimeout(resolve, 900));
            await this.loadVideo(this.sourceUrl, {
                skipStop: true,
                skipProbe: previousWasDirect || previousQuality === 'auto',
                qualitySourceInfo: sourceInfo,
                forceDirectFallback: previousWasDirect || previousQuality === 'auto'
            });
            const restoredLabel = previousQuality === 'auto'
                ? 'Auto'
                : `Up to ${PlaybackQuality.getLabel(previousQuality)}`;
            this.updateTranscodeStatus('warning', `${PlaybackQuality.getLabel(value)} unavailable · Restored ${restoredLabel}`);
        } finally {
            this.startHistoryTracking();
            this.qualityChanging = false;
        }
    }

    async loadVideo(url, {
        skipStop = false,
        skipProbe = false,
        qualitySourceInfo = null,
        forceDirectFallback = false
    } = {}) {
        // Store the URL for copy functionality
        this.currentUrl = url;
        // Direct playback uses the media element's native content timeline.
        // A successful transcode session will replace this with its seek offset.
        this.playbackTimeOffset = 0;

        // Stop any existing playback
        if (!skipStop) {
            this.stop();
        } else {
            this.currentTranscodeOptions = null;
            this.seekChanging = false;
            this.progressScrubbing = false;
        }
        const knownDuration = Number(qualitySourceInfo?.duration);
        if (Number.isFinite(knownDuration) && knownDuration > 0) {
            this.sourceDuration = knownDuration;
        }
        this.qualityCapWarning = null;
        this.qualityCapPending = false;

        // Show loading spinner
        this.showLoading();

        // Get settings for proxy/transcode
        let settings = {};
        try {
            settings = await API.settings.get();
        } catch (e) {
            console.warn('Could not load settings');
        }
        this.settings = settings;

        if (!forceDirectFallback && this.playbackQuality !== 'auto' && qualitySourceInfo) {
            await this.startQualityPlayback(url, this.playbackQuality, qualitySourceInfo);
            return;
        }

        // Detect stream type
        const looksLikeHls = url.includes('.m3u8') || url.includes('m3u8');
        const isRawTs = url.includes('.ts') && !url.includes('.m3u8');
        const isDirectVideo = url.includes('.mp4') || url.includes('.mkv') || url.includes('.avi');

        // Track selection still needs stream metadata when smart transcoding is
        // disabled. A failed optional probe must never block ordinary playback.
        if (!forceDirectFallback && !settings.autoTranscode && !skipProbe) {
            try {
                const ua = settings.userAgentPreset === 'custom' ? settings.userAgentCustom : settings.userAgentPreset;
                const probeRes = await fetch(NodeCastUrl.resolve(`/api/probe?url=${encodeURIComponent(url)}&ua=${encodeURIComponent(ua || '')}`));
                const info = await probeRes.json();
                if (probeRes.ok && !info.error) {
                    this.currentStreamInfo = info;
                    this.updateQualityBadge();
                    this.applyProbeTracks(info, url);
                }
            } catch (error) {
                console.warn('[WatchPage] Optional track discovery failed:', error.message);
            }
        }

        // Priority 0: Auto Transcode (Smart) - probe first, then decide
        if (!forceDirectFallback && settings.autoTranscode && !skipProbe) {
            console.log('[WatchPage] Auto Transcode enabled. Probing stream...');
            try {
                const ua = settings.userAgentPreset === 'custom' ? settings.userAgentCustom : settings.userAgentPreset;
                const probeRes = await fetch(NodeCastUrl.resolve(`/api/probe?url=${encodeURIComponent(url)}&ua=${encodeURIComponent(ua || '')}`));
                const info = await probeRes.json();
                if (!probeRes.ok || info.error) {
                    throw new Error(info.error || `Probe request failed (${probeRes.status})`);
                }
                console.log(`[WatchPage] Probe result: video=${info.video}, audio=${info.audio}, ${info.width}x${info.height}, compatible=${info.compatible}`);

                // Store early probe info for quality display
                this.currentStreamInfo = info;
                this.updateQualityBadge();
                this.applyProbeTracks(info, url);

                const globalResolution = settings.maxResolution || '1080p';
                const globalHeight = PlaybackQuality.getHeight(globalResolution);
                if (this.playbackQuality === 'auto' && globalHeight > 0 && !(info.height > 0)) {
                    this.qualityCapPending = true;
                }
                if (this.playbackQuality === 'auto' && globalHeight > 0 && info.height > globalHeight) {
                    try {
                        await this.startQualityPlayback(url, globalResolution, info);
                        return;
                    } catch (qualityError) {
                        const label = PlaybackQuality.getLabel(globalResolution);
                        const originalLabel = this.getQualityLabel(info.height) || 'original quality';
                        console.warn(`[WatchPage] ${label} global quality cap unavailable; continuing direct playback:`, qualityError.message);
                        this.qualityCapWarning = `${label} limit unavailable · Playing original at ${originalLabel}`;
                    }
                }

                if (this.playbackQuality !== 'auto') {
                    await this.startQualityPlayback(url, this.playbackQuality, info);
                    return;
                } else if (info.needsTranscode || settings.upscaleEnabled) {
                    console.log(`[WatchPage] Auto: Using HLS transcode session (${settings.upscaleEnabled ? 'Upscaling' : 'Incompatible audio/video'})`);

                    // Heuristic: If video is h264/compat, copy video. Usage: Audio fix. 
                    // BUT: If upscaling is enabled, we MUST encode.
                    const videoMode = (info.video && info.video.includes('h264') && !settings.upscaleEnabled) ? 'copy' : 'encode';
                    const statusText = videoMode === 'copy' ? 'Transcoding (Audio)' : (settings.upscaleEnabled ? 'Upscaling' : 'Transcoding (Video)');
                    const statusMode = settings.upscaleEnabled ? 'upscaling' : 'transcoding';

                    this.updateTranscodeStatus(statusMode, statusText);
                    const playlistUrl = await this.startTranscodeSession(url, {
                        videoMode,
                        seekOffset: this.resumeTime, // Ensure seekOffset is passed
                        videoCodec: info.video,
                        audioCodec: info.audio,
                        audioChannels: info.audioChannels,
                        videoHeight: info.height,
                        ...this.getSelectedAudioOptions(info)
                    });
                    this.playHls(playlistUrl);
                    this.setVolumeFromStorage();
                    return;
                } else if (info.needsRemux) {
                    // Remux (container swap) currently doesn't use session logic, uses direct stream
                    // TODO: Move remux to session logic if seeking is needed for TS files
                    console.log('[WatchPage] Auto: Using remux (.ts container)');
                    this.updateTranscodeStatus('remuxing', 'Remux (Auto)');
                    const finalUrl = NodeCastUrl.resolve(`/api/remux?url=${encodeURIComponent(url)}`);
                    this.video.src = finalUrl;
                    this.video.play().catch(e => {
                        if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
                    });
                    this.setVolumeFromStorage();
                    return;
                }
                // Compatible - fall through to normal playback
                console.log('[WatchPage] Auto: Using normal playback (compatible)');
            } catch (err) {
                console.warn('[WatchPage] Probe failed, using normal playback:', err.message);
                this.qualityCapPending = this.playbackQuality === 'auto';
                // Continue with normal playback on probe failure
            }
        }

        if (!forceDirectFallback && this.playbackQuality !== 'auto') {
            await this.startQualityPlayback(url, this.playbackQuality);
            return;
        }

        // Priority 1: Force Video Transcode (Full) or Upscaling
        if (!forceDirectFallback && (settings.forceVideoTranscode || settings.upscaleEnabled)) {
            const statusText = settings.upscaleEnabled ? 'Upscaling' : 'Transcoding (Video)';
            const statusMode = settings.upscaleEnabled ? 'upscaling' : 'transcoding';
            console.log(`[WatchPage] ${statusText} enabled. Starting session (encode)...`);
            this.updateTranscodeStatus(statusMode, statusText);
            const playlistUrl = await this.startTranscodeSession(url, {
                videoMode: 'encode',
                seekOffset: this.resumeTime,
                ...this.getSelectedAudioOptions()
            });
            this.playHls(playlistUrl);
            this.setVolumeFromStorage();
            return;
        }

        if (!forceDirectFallback && settings.forceTranscode) {
            console.log('[WatchPage] Force Audio Transcode enabled. Starting session (copy)...');
            this.updateTranscodeStatus('transcoding', 'Transcoding (Audio)');

            // Probe to get video codec for HEVC tag handling
            let videoCodec = 'unknown';
            try {
                const ua = settings.userAgentPreset === 'custom' ? settings.userAgentCustom : settings.userAgentPreset;
                const probeRes = await fetch(NodeCastUrl.resolve(`/api/probe?url=${encodeURIComponent(url)}&ua=${encodeURIComponent(ua || '')}`));
                const info = await probeRes.json();
                videoCodec = info.video;
                this.currentStreamInfo = info;
                this.applyProbeTracks(info, url);
            } catch (e) { console.warn('Probe failed for force audio, assuming h264'); }

            const playlistUrl = await this.startTranscodeSession(url, {
                videoMode: 'copy',
                videoCodec,
                seekOffset: this.resumeTime,
                ...this.getSelectedAudioOptions()
            });
            this.playHls(playlistUrl);
            this.setVolumeFromStorage();
            return;
        }

        // Priority 2: Force Remux for raw TS streams
        if (!forceDirectFallback && settings.forceRemux && isRawTs) {
            console.log('[WatchPage] Force Remux enabled');
            this.updateTranscodeStatus('remuxing', 'Remux (Force)');
            const finalUrl = NodeCastUrl.resolve(`/api/remux?url=${encodeURIComponent(url)}`);
            this.video.src = finalUrl;
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
            });
            this.setVolumeFromStorage();
            return;
        }

        // Determine if proxy is needed
        const proxyRequiredDomains = ['pluto.tv'];
        const needsProxy = settings.forceProxy || proxyRequiredDomains.some(domain => url.includes(domain));
        const finalUrl = needsProxy ? NodeCastUrl.resolve(`/api/proxy/stream?url=${encodeURIComponent(url)}`) : url;

        console.log('[WatchPage] Playing:', { url, needsProxy, looksLikeHls });

        // Use HLS.js for HLS streams
        if (looksLikeHls && Hls.isSupported()) {
            this.updateTranscodeStatus('direct', 'Direct HLS');
            this.playHls(finalUrl);
        } else {
            // Direct playback for mp4/mkv/avi
            this.updateTranscodeStatus('direct', 'Direct Play');
            this.video.src = finalUrl;
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
            });
        }

        this.setVolumeFromStorage();
        if (this.qualityCapWarning) {
            this.updateTranscodeStatus('warning', this.qualityCapWarning);
        }
    }

    /**
     * Play HLS stream using Hls.js
     */
    playHls(url, { autoPlay = true } = {}) {
        clearTimeout(this.hlsRecoveryTimer);
        this.hlsRecoveryTimer = null;
        this.hlsRecoveryCount = 0;
        this.hlsMediaRecoveryCount = 0;

        if (this.hls) {
            this.hls.destroy();
        }

        this.hls = new Hls({
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferHole: 1,
            startLevel: -1,
            enableWorker: true,
            fragLoadingMaxRetry: 3,
            fragLoadingRetryDelay: 500,
            fragLoadingMaxRetryTimeout: 4000,
            manifestLoadingMaxRetry: 3,
            levelLoadingMaxRetry: 3,
            nudgeMaxRetry: 6,
            lowLatencyMode: false,
        });

        const activeHls = this.hls;

        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);

        this.hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (event, data) => {
            if (!this.currentSessionId) {
                this.applyHlsAudioTracks(data.audioTracks || []);
            }
        });

        this.hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (event, data) => {
            if (!this.currentSessionId) {
                this.selectedHlsAudioTrack = Number(data.id);
                this.updateAudioTracks();
            }
        });

        // Listen for subtitle track updates
        this.hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (event, data) => {
            console.log('[WatchPage] Subtitle tracks updated:', data.subtitleTracks);
            // Wait a moment for native text tracks to populate
            setTimeout(() => this.updateCaptionsTracks(), 100);
        });

        this.hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (event, data) => {
            console.log('[WatchPage] Subtitle track switched:', data);
        });

        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (!this.currentSessionId && Array.isArray(this.hls?.audioTracks)) {
                this.applyHlsAudioTracks(this.hls.audioTracks);
            }
            if (!this.currentSessionId && this.playbackQuality !== 'auto') {
                this.applyAdaptiveQuality(this.playbackQuality);
            }
            if (autoPlay) {
                this.video.play().catch(e => {
                    if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
                });
            } else {
                this.hideLoading();
                this.showOverlay();
            }
            this.renderProbeSubtitleTracks();
            this.scheduleSelectedSubtitleRestore();
        });

        this.hls.on(Hls.Events.FRAG_LOADED, () => {
            if (activeHls !== this.hls) return;
            this.hlsRecoveryCount = 0;
            this.hideLoading();
        });

        this.hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
            const height = Number(this.hls?.levels?.[data.level]?.height) || 0;
            if (height > 0) {
                this.currentStreamInfo = { ...this.currentStreamInfo, height };
                this.updateQualityBadge();
                this.updatePendingQualityCapWarning(height);
            }
        });

        this.hls.on(Hls.Events.ERROR, (event, data) => {
            if (!data.fatal || activeHls !== this.hls) return;

            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                this.hlsMediaRecoveryCount += 1;
                console.warn(`[WatchPage] Recovering from HLS media error (${this.hlsMediaRecoveryCount}/2):`, data.details);
                if (this.hlsMediaRecoveryCount === 1) {
                    activeHls.recoverMediaError();
                    return;
                }
                if (this.hlsMediaRecoveryCount === 2) {
                    activeHls.swapAudioCodec();
                    activeHls.recoverMediaError();
                    return;
                }
            }

            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                this.hlsRecoveryCount += 1;
                const manifestFailedBeforePlayback = this.video.currentTime === 0 && (
                    data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
                    data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
                );
                const canTryProxy = !NodeCastUrl.isApi(url) && Boolean(this.currentUrl);

                if (manifestFailedBeforePlayback && canTryProxy) {
                    console.warn('[WatchPage] Direct HLS manifest failed; retrying through the stream proxy.');
                    this.playHls(NodeCastUrl.resolve(`/api/proxy/stream?url=${encodeURIComponent(this.currentUrl)}`));
                    return;
                }

                if (this.hlsRecoveryCount <= 3) {
                    const retryDelay = Math.min(this.hlsRecoveryCount * 1000, 3000);
                    console.warn(`[WatchPage] HLS network interruption; reconnecting in ${retryDelay}ms (${this.hlsRecoveryCount}/3).`);
                    this.showLoading();
                    this.hlsRecoveryTimer = setTimeout(() => {
                        if (activeHls === this.hls) activeHls.startLoad();
                    }, retryDelay);
                    return;
                }

                if (canTryProxy) {
                    console.warn('[WatchPage] Direct HLS recovery was exhausted; retrying through the stream proxy.');
                    this.playHls(NodeCastUrl.resolve(`/api/proxy/stream?url=${encodeURIComponent(this.currentUrl)}`));
                    return;
                }
            }

            console.error('[WatchPage] HLS playback could not recover:', data.type, data.details);
            this.hideLoading();
            this.updateTranscodeStatus('warning', 'Playback stopped · Try again');
            activeHls.destroy();
            if (activeHls === this.hls) {
                this.hls = null;
                this.cancelProbeSubtitleLoads();
                void this.stopTranscodeSession();
            }
        });
    }

    setVolumeFromStorage() {
        // Keep the legacy storage key so upstream users retain their saved volume after upgrading.
        const savedVolume = localStorage.getItem('nodecast-volume') || '80';
        this.video.volume = parseInt(savedVolume) / 100;
        if (this.volumeSlider) this.volumeSlider.value = savedVolume;
    }

    stop() {
        clearTimeout(this.hlsRecoveryTimer);
        this.hlsRecoveryTimer = null;
        this.hlsRecoveryCount = 0;
        this.hlsMediaRecoveryCount = 0;

        // Stop history tracking and save final progress
        this.stopHistoryTracking();
        this.saveProgress();

        // Cleanup transcode session if exists. Disable window loading before
        // resetting the media element so its final seeking event cannot start
        // a new subtitle extraction after the player has been closed.
        this.subtitleLoadingEnabled = false;
        this.stopTranscodeSession();
        this.cancelProbeSubtitleLoads();
        this.updateTranscodeStatus('hidden');

        // Hide quality badge
        this.currentStreamInfo = null;
        if (this.qualityBadgeEl) {
            this.qualityBadgeEl.classList.add('hidden');
        }

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        if (this.video) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
        }
        this.playbackTimeOffset = 0;
        this.sourceDuration = 0;
        this.currentTranscodeOptions = null;
        this.seekChanging = false;
        this.progressScrubbing = false;

        this.hideNowPlaying();
    }

    // === Playback Controls ===

    togglePlay() {
        if (this.video.paused) {
            this.video.play().catch(console.error);
        } else {
            this.video.pause();
        }
    }

    async skip(seconds) {
        const duration = this.getPlaybackDuration();
        if (!Number.isFinite(duration) || duration <= 0) return;
        await this.seekToContentTime(Math.max(0, Math.min(this.getCurrentPlaybackTime() + seconds, duration)));
    }

    getCurrentPlaybackTime() {
        const mediaTime = Number(this.video?.currentTime) || 0;
        return Math.max(0, this.playbackTimeOffset + mediaTime);
    }

    getPlaybackDuration() {
        if (Number.isFinite(this.sourceDuration) && this.sourceDuration > 0) {
            return this.sourceDuration;
        }
        const mediaDuration = Number(this.video?.duration);
        if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return mediaDuration;
        return Math.max(0, this.playbackTimeOffset + mediaDuration);
    }

    previewSeek(percent) {
        const duration = this.getPlaybackDuration();
        if (!Number.isFinite(duration) || duration <= 0) return;
        this.progressScrubbing = true;
        this.timeCurrent.textContent = this.formatTime((Number(percent) / 100) * duration);
    }

    async seek(percent) {
        const duration = this.getPlaybackDuration();
        try {
            if (Number.isFinite(duration) && duration > 0) {
                await this.seekToContentTime((Number(percent) / 100) * duration);
            }
        } finally {
            this.progressScrubbing = false;
            this.updateProgress();
        }
    }

    async seekToContentTime(requestedTime) {
        if (!this.video || this.seekChanging) return;

        const duration = this.getPlaybackDuration();
        const target = Math.max(0, Math.min(Number(requestedTime) || 0, duration || 0));
        const mediaDuration = Number(this.video.duration);
        const sessionStart = this.playbackTimeOffset;
        const sessionEnd = sessionStart + (Number.isFinite(mediaDuration) ? mediaDuration : 0);
        const targetIsGenerated = !this.currentSessionId || (
            target >= sessionStart && target <= sessionEnd
        );

        if (targetIsGenerated) {
            this.video.currentTime = Math.max(0, Math.min(target - sessionStart, mediaDuration || 0));
            return;
        }

        const sessionOptions = this.currentTranscodeOptions ? { ...this.currentTranscodeOptions } : null;
        if (!sessionOptions || !this.sourceUrl) return;

        const shouldResume = !this.video.paused;
        this.seekChanging = true;
        this.showLoading();
        this.stopHistoryTracking();
        this.saveProgress();

        try {
            await this.stopTranscodeSession();
            if (this.hls) {
                this.hls.destroy();
                this.hls = null;
            }
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();

            // Starting FFmpeg exactly at end-of-file cannot produce a segment.
            const sessionTarget = duration > 0 && target >= duration
                ? Math.max(0, duration - 0.25)
                : target;
            const playlistUrl = await this.startTranscodeSession(this.sourceUrl, {
                ...sessionOptions,
                seekOffset: sessionTarget
            });
            this.playHls(playlistUrl, { autoPlay: shouldResume });
            this.setVolumeFromStorage();
        } catch (error) {
            console.warn('[WatchPage] Seek session failed:', error.message);
            this.updateTranscodeStatus('warning', 'Seek unavailable · Playback stopped');
        } finally {
            this.seekChanging = false;
            this.startHistoryTracking();
        }
    }

    toggleMute() {
        if (this.video) {
            this.video.muted = !this.video.muted;
            this.updateVolumeUI();
        }
    }

    setVolume(value) {
        if (this.video) {
            this.video.volume = value / 100;
            this.video.muted = false;
            localStorage.setItem('nodecast-volume', value);
            this.updateVolumeUI();
        }
    }

    toggleFullscreen() {
        const container = document.querySelector('.watch-video-section');
        const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;

        if (isFullscreen) {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        } else {
            if (container?.requestFullscreen) {
                container.requestFullscreen();
            } else if (container?.webkitRequestFullscreen) {
                container.webkitRequestFullscreen();
            } else if (this.video?.webkitEnterFullscreen) {
                // iOS Safari: use native video fullscreen
                this.video.webkitEnterFullscreen();
            }
        }
    }

    async togglePictureInPicture() {
        try {
            // Standard PiP API (Chrome, Edge, Firefox)
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled && this.video.readyState >= 2) {
                await this.video.requestPictureInPicture();
            }
            // Safari fallback using webkitPresentationMode
            else if (typeof this.video.webkitSetPresentationMode === 'function') {
                const mode = this.video.webkitPresentationMode;
                this.video.webkitSetPresentationMode(mode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
            }
        } catch (err) {
            if (err.name !== 'NotAllowedError') {
                console.error('Picture-in-Picture error:', err);
            }
        }
    }

    /**
     * Copy current stream URL to clipboard
     */
    copyStreamUrl() {
        if (!this.currentUrl) {
            console.warn('[WatchPage] No stream URL to copy');
            return;
        }

        let streamUrl = this.currentUrl;

        // If it's a relative URL, make it absolute
        if (streamUrl.startsWith('/')) {
            streamUrl = NodeCastUrl.absolute(streamUrl);
        }

        const showPromptFallback = () => {
            prompt('Copy this URL:', streamUrl);
        };

        // navigator.clipboard is only available in secure contexts (HTTPS/localhost)
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(streamUrl).then(() => {
                // Show brief feedback
                const btn = document.getElementById('watch-copy-url');
                if (btn) {
                    btn.textContent = '✓ Copied!';
                    setTimeout(() => {
                        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy Stream URL`;
                    }, 1500);
                }
                console.log('[WatchPage] Stream URL copied:', streamUrl);
            }).catch(() => {
                showPromptFallback();
            });
        } else {
            // Fallback for insecure contexts (HTTP)
            showPromptFallback();
        }
    }

    // === UI Updates ===

    updateProgress() {
        if (!this.video || !this.video.duration) return;

        const currentTime = this.getCurrentPlaybackTime();
        const duration = this.getPlaybackDuration();
        const percent = Number.isFinite(duration) && duration > 0
            ? (currentTime / duration) * 100
            : 0;
        if (!this.progressScrubbing) {
            this.progressSlider.value = percent;
            this.timeCurrent.textContent = this.formatTime(currentTime);
        }

        // Show "Up Next" panel early for series (like streaming services do during credits)
        // Only show if auto-play next episode is enabled
        const autoPlayEnabled = this.app?.player?.settings?.autoPlayNextEpisode;
        if (autoPlayEnabled && this.contentType === 'series' && this.seriesInfo && !this.nextEpisodeShowing && !this.nextEpisodeDismissed) {
            // Only proceed if we have reliable duration data
            if (isFinite(duration) && duration >= 180 && currentTime >= 120) {
                const timeRemaining = duration - currentTime;
                const creditsThreshold = 10; // seconds before end to show "Up Next"

                if (timeRemaining <= creditsThreshold && timeRemaining > 0) {
                    const nextEp = this.getNextEpisode();
                    if (nextEp) {
                        this.nextEpisodeShowing = true;
                        this.showNextEpisodePanel(nextEp);
                    }
                }
            }
        }
    }

    onMetadataLoaded() {
        // Detect resolution
        if (this.video && this.video.videoHeight > 0) {
            this.currentStreamInfo = {
                ...this.currentStreamInfo,
                width: this.video.videoWidth,
                height: this.video.videoHeight
            };
            if (!this.currentSessionId && Number.isFinite(this.video.duration) && this.video.duration > 0) {
                this.sourceDuration = this.video.duration;
            }
            this.updateQualityBadge();
            this.updatePendingQualityCapWarning(this.video.videoHeight);
        }

        // Handle resumption
        if (this.resumeTime > 0 && this.video) {
            const duration = this.video.duration;
            // Only resume if not near the end (95%)
            if (!duration || this.resumeTime < duration * 0.95) {
                console.log(`[WatchPage] Resuming at ${this.resumeTime}s`);
                this.video.currentTime = this.resumeTime;
            }
            this.resumeTime = 0; // Reset after use
        }
    }

    onPlay() {
        // Update play/pause button icons
        this.playPauseBtn?.querySelector('.icon-play')?.classList.add('hidden');
        this.playPauseBtn?.querySelector('.icon-pause')?.classList.remove('hidden');
        this.centerPlayBtn?.classList.remove('show');

        // Start overlay auto-hide
        this.startOverlayTimer();
    }

    onPause() {
        this.playPauseBtn?.querySelector('.icon-play')?.classList.remove('hidden');
        this.playPauseBtn?.querySelector('.icon-pause')?.classList.add('hidden');
        this.centerPlayBtn?.classList.add('show');

        // Keep overlay visible when paused
        this.showOverlay();
        clearTimeout(this.overlayTimeout);
    }

    onEnded() {
        // For series, show next episode panel if not already showing and auto-play is enabled
        const autoPlayEnabled = this.app?.player?.settings?.autoPlayNextEpisode;
        if (autoPlayEnabled && this.contentType === 'series' && this.seriesInfo && !this.nextEpisodeShowing) {
            const nextEp = this.getNextEpisode();
            if (nextEp) {
                this.nextEpisodeShowing = true;
                this.showNextEpisodePanel(nextEp);
            }
        }
    }

    onError(e) {
        // Only log actual fatal errors, not benign stream recovery events
        const error = this.video?.error;
        if (error && error.code && this.video.currentSrc) {
            console.error('[WatchPage] Video error:', error.code, error.message);
        }
    }

    updateVolumeUI() {
        const isMuted = this.video?.muted || this.video?.volume === 0;
        this.muteBtn?.querySelector('.icon-vol')?.classList.toggle('hidden', isMuted);
        this.muteBtn?.querySelector('.icon-muted')?.classList.toggle('hidden', !isMuted);
    }

    formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) {
            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // === Loading Spinner ===

    showLoading() {
        this.loadingSpinner?.classList.add('show');
        this.centerPlayBtn?.classList.remove('show');
    }

    hideLoading() {
        this.loadingSpinner?.classList.remove('show');
    }

    // === Audio and subtitles ===

    resetMediaTracks() {
        this.clearSubtitleRestoreTimers();
        this.cancelProbeSubtitleLoads();
        this.video?.querySelectorAll('track[data-nodecast-probe-track]').forEach(track => track.remove());
        this.availableAudioTracks = [];
        this.availableSubtitleTracks = [];
        this.subtitleStreamUrl = null;
        this.probeSubtitleCues = new WeakMap();
        this.probeSubtitleWindows = new WeakMap();
        this.probeSubtitleLoads = new WeakMap();
        this.selectedSubtitleStreamIndex = null;
        this.audioTrackMode = 'none';
        this.selectedAudioTrackIndex = null;
        this.selectedHlsAudioTrack = -1;
        this.audioSelectionExplicit = false;
        this.updateAudioTracks();
        this.updateCaptionsTracks();
    }

    clearSubtitleRestoreTimers() {
        for (const timer of this.subtitleRestoreTimers || []) clearTimeout(timer);
        this.subtitleRestoreTimers = [];
    }

    cancelProbeSubtitleLoads() {
        for (const controller of this.subtitleLoadControllers || []) controller.abort();
        this.subtitleLoadControllers?.clear();
        this.probeSubtitleLoads = new WeakMap();
    }

    restoreSelectedSubtitleTrack() {
        if (!Number.isInteger(this.selectedSubtitleStreamIndex) || !this.video) return false;
        const trackElement = Array.from(this.video.querySelectorAll('track[data-nodecast-probe-track]'))
            .find(element => Number(element.dataset.nodecastSubtitleIndex) === this.selectedSubtitleStreamIndex);
        if (!trackElement || !this.probeSubtitleCues.has(trackElement)) return false;
        return this.activateProbeSubtitleTrack(trackElement);
    }

    scheduleSelectedSubtitleRestore() {
        this.clearSubtitleRestoreTimers();
        if (!Number.isInteger(this.selectedSubtitleStreamIndex)) return;
        for (const delay of [0, 150, 500, 1000]) {
            this.subtitleRestoreTimers.push(setTimeout(() => {
                this.restoreSelectedSubtitleTrack();
                this.updateCaptionsTracks();
            }, delay));
        }
    }

    getLanguageName(language) {
        const code = String(language || '').trim().toLowerCase();
        if (!code || code === 'und') return '';
        try {
            return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code.toUpperCase();
        } catch {
            return code.toUpperCase();
        }
    }

    getAudioTrackLabel(track, position) {
        const parts = [];
        const title = String(track?.title || track?.name || '').trim();
        const language = this.getLanguageName(track?.language || track?.lang);
        if (title) parts.push(title);
        if (language && !parts.some(part => part.toLowerCase() === language.toLowerCase())) {
            parts.push(language);
        }
        const codec = String(track?.codec || track?.audioCodec || '').trim().toUpperCase();
        if (codec) parts.push(codec);
        const channels = Number(track?.channels) || 0;
        if (channels === 1) parts.push('Mono');
        if (channels === 2) parts.push('Stereo');
        if (channels > 2) parts.push(`${channels} channels`);
        return parts.join(' · ') || `Audio ${position + 1}`;
    }

    applyProbeTracks(info, streamUrl) {
        const probedDuration = Number(info?.duration);
        if (Number.isFinite(probedDuration) && probedDuration > 0) {
            this.sourceDuration = probedDuration;
        }
        const tracks = Array.isArray(info?.audioTracks)
            ? info.audioTracks.filter(track => Number.isInteger(Number(track.index)))
            : [];

        this.availableAudioTracks = tracks.map(track => ({
            ...track,
            index: Number(track.index)
        }));
        this.audioTrackMode = this.availableAudioTracks.length > 0 ? 'probe' : 'none';

        if (!this.availableAudioTracks.some(track => track.index === this.selectedAudioTrackIndex)) {
            const preferred = this.availableAudioTracks.find(track => track.default) || this.availableAudioTracks[0];
            this.selectedAudioTrackIndex = preferred?.index ?? null;
            this.audioSelectionExplicit = false;
        }

        this.availableSubtitleTracks = (Array.isArray(info?.subtitles) ? info.subtitles : [])
            .filter(subtitle => Number.isInteger(Number(subtitle.index)))
            .map(subtitle => ({ ...subtitle, index: Number(subtitle.index) }));
        this.subtitleStreamUrl = streamUrl;
        this.renderProbeSubtitleTracks();

        this.updateAudioTracks();
        setTimeout(() => this.updateCaptionsTracks(), 100);
    }

    renderProbeSubtitleTracks() {
        if (!this.video) return;
        // Reattaching HLS can recreate the media timeline. Cancel extraction
        // tied to the old track elements before replacing them.
        this.cancelProbeSubtitleLoads();
        this.video.querySelectorAll('track[data-nodecast-probe-track]').forEach(track => track.remove());
        if (!this.subtitleStreamUrl) {
            this.updateCaptionsTracks();
            return;
        }

        for (const subtitle of this.availableSubtitleTracks) {
            if (!Number.isInteger(Number(subtitle.index))) continue;
            const track = document.createElement('track');
            track.kind = 'subtitles';
            track.label = subtitle.title || this.getLanguageName(subtitle.language) || `Subtitle ${subtitle.index}`;
            track.srclang = subtitle.language || 'und';
            track.dataset.nodecastProbeTrack = 'true';
            track.dataset.nodecastSubtitleIndex = String(subtitle.index);
            this.video.appendChild(track);
        }

        // Embedded subtitle extraction scans the source. Do not start that
        // potentially expensive work until a language is selected. A selected
        // language is reloaded after an HLS session replacement so subtitles
        // survive seeks and audio changes.
        if (Number.isInteger(this.selectedSubtitleStreamIndex)) {
            const selectedTrack = Array.from(this.video.querySelectorAll('track[data-nodecast-probe-track]'))
                .find(track => Number(track.dataset.nodecastSubtitleIndex) === this.selectedSubtitleStreamIndex);
            if (selectedTrack) void this.loadProbeSubtitleTrack(selectedTrack, {
                windowStart: this.getSubtitleWindowStart(this.getCurrentPlaybackTime())
            });
        }

        this.updateCaptionsTracks();
    }

    parseWebVttTimestamp(value) {
        const parts = String(value || '').trim().split(':').map(Number);
        if (parts.some(part => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) return null;
        const seconds = parts.pop();
        const minutes = parts.pop();
        const hours = parts.pop() || 0;
        return (hours * 3600) + (minutes * 60) + seconds;
    }

    parseWebVtt(text) {
        const cues = [];
        const blocks = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/);
        for (const block of blocks) {
            const lines = block.split('\n').filter((line, index, all) => (
                index > 0 || line.trim() !== 'WEBVTT'
            ));
            const timingIndex = lines.findIndex(line => line.includes('-->'));
            if (timingIndex < 0) continue;
            const match = lines[timingIndex].match(/^\s*([^\s]+)\s+-->\s+([^\s]+)(?:\s+.*)?$/);
            if (!match) continue;
            const startTime = this.parseWebVttTimestamp(match[1]);
            const endTime = this.parseWebVttTimestamp(match[2]);
            if (startTime === null || endTime === null || endTime <= startTime) continue;
            const cueText = lines.slice(timingIndex + 1).join('\n').trim();
            if (cueText) cues.push({ startTime, endTime, text: cueText });
        }
        return cues;
    }

    getSubtitleWindowStart(contentTime) {
        const position = Math.max(0, Number(contentTime) || 0);
        const steppedStart = Math.floor(position / this.subtitleWindowStep) * this.subtitleWindowStep;
        return Math.max(0, steppedStart - this.subtitleWindowLookBehind);
    }

    subtitleWindowCovers(trackElement, contentTime) {
        const position = Math.max(0, Number(contentTime) || 0);
        return (this.probeSubtitleWindows.get(trackElement) || [])
            .some(window => position >= window.start && position < window.end - 5);
    }

    subtitleWindowLoaded(trackElement, windowStart) {
        const normalizedStart = Math.max(0, Number(windowStart) || 0);
        return (this.probeSubtitleWindows.get(trackElement) || [])
            .some(window => Math.abs(window.start - normalizedStart) < 0.001);
    }

    mergeProbeSubtitleCues(trackElement, cues, windowStart) {
        if (!trackElement?.isConnected || !Array.isArray(cues) || cues.length === 0) return false;
        const existing = this.probeSubtitleCues.get(trackElement) || [];
        const merged = new Map(existing.map(cue => [
            `${cue.startTime.toFixed(3)}|${cue.endTime.toFixed(3)}|${cue.text}`,
            cue
        ]));
        for (const cue of cues) {
            const shiftedCue = {
                ...cue,
                startTime: cue.startTime + windowStart,
                endTime: cue.endTime + windowStart
            };
            merged.set(
                `${shiftedCue.startTime.toFixed(3)}|${shiftedCue.endTime.toFixed(3)}|${shiftedCue.text}`,
                shiftedCue
            );
        }
        this.probeSubtitleCues.set(
            trackElement,
            Array.from(merged.values()).sort((a, b) => a.startTime - b.startTime)
        );
        return true;
    }

    ensureSelectedSubtitleWindow({ prioritize = false } = {}) {
        if (!this.subtitleLoadingEnabled || !Number.isInteger(this.selectedSubtitleStreamIndex) || !this.video) return;
        const trackElement = Array.from(this.video.querySelectorAll('track[data-nodecast-probe-track]'))
            .find(element => Number(element.dataset.nodecastSubtitleIndex) === this.selectedSubtitleStreamIndex);
        if (!trackElement) return;

        const contentTime = this.getCurrentPlaybackTime();
        if (this.subtitleWindowCovers(trackElement, contentTime)) return;

        const requestedStart = this.getSubtitleWindowStart(contentTime);
        const currentLoad = this.probeSubtitleLoads.get(trackElement);
        if (currentLoad?.windowStart === requestedStart) return;
        if (currentLoad && !prioritize) return;
        if (currentLoad && prioritize) this.cancelProbeSubtitleLoads();

        void this.loadProbeSubtitleTrack(trackElement, { windowStart: requestedStart });
    }

    async loadProbeSubtitleTrack(trackElement, { windowStart = 0 } = {}) {
        if (!this.subtitleLoadingEnabled || !trackElement?.isConnected || !this.subtitleStreamUrl) return false;
        const normalizedStart = Math.max(0, Number(windowStart) || 0);
        if (this.subtitleWindowLoaded(trackElement, normalizedStart)) {
            this.activateProbeSubtitleTrack(trackElement);
            return true;
        }

        const existingLoad = this.probeSubtitleLoads.get(trackElement);
        if (existingLoad) return existingLoad.promise;

        const streamIndex = Number(trackElement.dataset.nodecastSubtitleIndex);
        const subtitleUrl = NodeCastUrl.resolve(
            `/api/subtitle?url=${encodeURIComponent(this.subtitleStreamUrl)}&index=${streamIndex}`
            + `&start=${encodeURIComponent(normalizedStart)}&duration=${encodeURIComponent(this.subtitleWindowDuration)}`
        );
        const controller = new AbortController();
        this.subtitleLoadControllers.add(controller);

        const load = (async () => {
        try {
            const response = await fetch(subtitleUrl, {
                credentials: 'same-origin',
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`Subtitle request failed (${response.status})`);

            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let receivedCues = false;

            if (reader) {
                while (true) {
                    const { value, done } = await reader.read();
                    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r/g, '');
                    const completeBoundary = buffer.lastIndexOf('\n\n');
                    if (completeBoundary >= 0) {
                        const completeText = buffer.slice(0, completeBoundary + 2);
                        buffer = buffer.slice(completeBoundary + 2);
                        const cues = this.parseWebVtt(completeText);
                        if (this.mergeProbeSubtitleCues(trackElement, cues, normalizedStart)) {
                            receivedCues = true;
                            if (Number(trackElement.dataset.nodecastSubtitleIndex) === this.selectedSubtitleStreamIndex) {
                                this.activateProbeSubtitleTrack(trackElement);
                            }
                        }
                    }
                    if (done) break;
                }
            } else {
                buffer = await response.text();
            }

            const finalCues = this.parseWebVtt(buffer);
            if (this.mergeProbeSubtitleCues(trackElement, finalCues, normalizedStart)) {
                receivedCues = true;
            }
            if (!trackElement.isConnected || !trackElement.track) return false;
            const windows = this.probeSubtitleWindows.get(trackElement) || [];
            windows.push({
                start: normalizedStart,
                end: normalizedStart + this.subtitleWindowDuration
            });
            this.probeSubtitleWindows.set(trackElement, windows);
            trackElement.track.mode = 'hidden';
            if (Number(trackElement.dataset.nodecastSubtitleIndex) === this.selectedSubtitleStreamIndex) {
                this.activateProbeSubtitleTrack(trackElement);
                this.scheduleSelectedSubtitleRestore();
            }
            this.updateCaptionsTracks();
            return receivedCues;
        } catch (error) {
            if (error.name === 'AbortError') return false;
            console.warn('[WatchPage] Subtitle track unavailable:', error.message);
            trackElement.remove();
            this.updateCaptionsTracks();
            return false;
        } finally {
            this.subtitleLoadControllers.delete(controller);
        }
        })();

        const loadState = { promise: load, windowStart: normalizedStart };
        this.probeSubtitleLoads.set(trackElement, loadState);
        try {
            return await load;
        } finally {
            if (this.probeSubtitleLoads.get(trackElement) === loadState) {
                this.probeSubtitleLoads.delete(trackElement);
            }
        }
    }

    activateProbeSubtitleTrack(trackElement) {
        const track = trackElement?.track;
        const cues = this.probeSubtitleCues.get(trackElement) || [];
        const Cue = window.VTTCue;
        if (!track || typeof Cue !== 'function') return false;

        track.mode = 'hidden';
        for (const existingCue of Array.from(track.cues || [])) {
            track.removeCue(existingCue);
        }
        for (const cue of cues) {
            const startTime = Math.max(0, cue.startTime - this.playbackTimeOffset);
            const endTime = cue.endTime - this.playbackTimeOffset;
            if (endTime <= 0) continue;
            track.addCue(new Cue(startTime, endTime, cue.text));
        }
        track.mode = 'showing';
        return cues.length > 0;
    }

    applyHlsAudioTracks(tracks) {
        if (!Array.isArray(tracks) || tracks.length === 0) return;
        this.availableAudioTracks = tracks.map((track, index) => ({
            ...track,
            index,
            language: track.lang || track.language,
            title: track.name || track.title,
            codec: track.audioCodec || track.codec
        }));
        this.audioTrackMode = 'hls';
        const activeIndex = Number(this.hls?.audioTrack);
        this.selectedHlsAudioTrack = activeIndex >= 0 ? activeIndex : 0;
        this.updateAudioTracks();
    }

    getSelectedAudioOptions(streamInfo = this.currentStreamInfo) {
        if (this.audioTrackMode !== 'probe' || !this.audioSelectionExplicit) return {};
        const track = (streamInfo?.audioTracks || this.availableAudioTracks || [])
            .find(candidate => Number(candidate.index) === this.selectedAudioTrackIndex);
        if (!track) return {};
        return {
            audioStreamIndex: Number(track.index),
            audioCodec: track.codec || streamInfo?.audio,
            audioChannels: Number(track.channels) || streamInfo?.audioChannels || 0
        };
    }

    updateAudioTracks() {
        if (!this.audioList) return;
        this.audioList.replaceChildren();

        if (this.availableAudioTracks.length === 0) {
            const defaultOption = document.createElement('button');
            defaultOption.type = 'button';
            defaultOption.className = 'captions-option active';
            defaultOption.textContent = 'Default';
            defaultOption.disabled = true;
            this.audioList.appendChild(defaultOption);
            return;
        }

        this.availableAudioTracks.forEach((track, position) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'captions-option';
            option.textContent = this.getAudioTrackLabel(track, position);
            const isActive = this.audioTrackMode === 'hls'
                ? position === this.selectedHlsAudioTrack
                : Number(track.index) === this.selectedAudioTrackIndex;
            option.classList.toggle('active', isActive);
            option.disabled = this.audioTrackChanging;
            option.addEventListener('click', event => {
                event.stopPropagation();
                void this.selectAudioTrack(this.audioTrackMode === 'hls' ? position : Number(track.index));
            });
            this.audioList.appendChild(option);
        });
    }

    async selectAudioTrack(index) {
        if (this.audioTrackChanging) return;

        if (this.audioTrackMode === 'hls') {
            if (!this.hls || index < 0 || index >= this.availableAudioTracks.length) return;
            this.hls.audioTrack = index;
            this.selectedHlsAudioTrack = index;
            this.updateAudioTracks();
            this.closeCaptionsMenu();
            return;
        }

        const selectedTrack = this.availableAudioTracks.find(track => Number(track.index) === Number(index));
        if (!selectedTrack || Number(index) === this.selectedAudioTrackIndex) {
            this.closeCaptionsMenu();
            return;
        }

        const previousIndex = this.selectedAudioTrackIndex;
        const previousExplicit = this.audioSelectionExplicit;
        const resumeAt = this.getCurrentPlaybackTime();
        const streamInfo = this.currentStreamInfo ? { ...this.currentStreamInfo } : {};
        this.audioTrackChanging = true;
        this.selectedAudioTrackIndex = Number(index);
        this.audioSelectionExplicit = true;
        this.updateAudioTracks();
        this.closeCaptionsMenu();

        try {
            this.stopHistoryTracking();
            this.saveProgress();
            await this.stopTranscodeSession();
            if (this.hls) {
                this.hls.destroy();
                this.hls = null;
            }
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
            this.resumeTime = resumeAt;
            await new Promise(resolve => setTimeout(resolve, 250));
            await this.startSelectedAudioPlayback(streamInfo);
        } catch (error) {
            console.warn('[WatchPage] Audio track switch failed; restoring previous playback:', error.message);
            this.selectedAudioTrackIndex = previousIndex;
            this.audioSelectionExplicit = previousExplicit;
            this.resumeTime = resumeAt;
            await new Promise(resolve => setTimeout(resolve, 500));
            await this.loadVideo(this.sourceUrl, { skipStop: true });
            this.updateTranscodeStatus('warning', 'Audio track unavailable · Restored previous audio');
        } finally {
            this.audioTrackChanging = false;
            this.updateAudioTracks();
            this.startHistoryTracking();
        }
    }

    async startSelectedAudioPlayback(streamInfo) {
        const selected = this.getSelectedAudioOptions(streamInfo);
        if (!Number.isInteger(selected.audioStreamIndex)) {
            throw new Error('Selected audio stream is no longer available');
        }

        const configuredResolution = this.playbackQuality !== 'auto'
            ? this.playbackQuality
            : this.settings.maxResolution;
        const configuredHeight = PlaybackQuality.getHeight(configuredResolution);
        const sourceHeight = Number(streamInfo?.height) || 0;
        const needsResolutionEncode = configuredHeight > 0 && sourceHeight > configuredHeight;
        const canCopyVideo = String(streamInfo?.video || '').toLowerCase().includes('h264');
        const mustEncodeVideo = this.settings.forceVideoTranscode || this.settings.upscaleEnabled ||
            needsResolutionEncode || !canCopyVideo;
        const selectedTrack = this.availableAudioTracks.find(track => track.index === selected.audioStreamIndex);
        const trackLabel = this.getAudioTrackLabel(selectedTrack, this.availableAudioTracks.indexOf(selectedTrack));

        this.updateTranscodeStatus('transcoding', `Switching audio · ${trackLabel}`);
        const playlistUrl = await this.startTranscodeSession(this.sourceUrl, {
            videoMode: mustEncodeVideo ? 'encode' : 'copy',
            videoCodec: streamInfo?.video,
            videoHeight: sourceHeight || undefined,
            maxResolution: needsResolutionEncode || this.playbackQuality !== 'auto'
                ? configuredResolution
                : undefined,
            ...selected
        });
        this.currentStreamInfo = streamInfo;
        this.playHls(playlistUrl);
        this.setVolumeFromStorage();
        this.updateTranscodeStatus('transcoding', `Audio · ${trackLabel}`);
    }

    toggleCaptionsMenu() {
        if (this.captionsMenuOpen) {
            this.closeCaptionsMenu();
        } else {
            this.updateAudioTracks();
            this.updateCaptionsTracks();
            this.captionsMenu?.classList.remove('hidden');
            this.captionsMenuOpen = true;
        }
    }

    closeCaptionsMenu() {
        this.captionsMenu?.classList.add('hidden');
        this.captionsMenuOpen = false;
    }

    updateCaptionsTracks() {
        if (!this.captionsList || !this.video) return;

        const tracks = this.video.textTracks;
        this.captionsList.replaceChildren();

        const offOption = document.createElement('button');
        offOption.type = 'button';
        offOption.className = 'captions-option';
        offOption.textContent = 'Off';
        offOption.addEventListener('click', () => this.selectCaptionTrack(-1));
        this.captionsList.appendChild(offOption);

        let anyActive = false;

        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            if (track.kind === 'subtitles' || track.kind === 'captions') {
                const label = track.label || track.language || `Track ${i + 1}`;
                const probeTrack = Array.from(this.video.querySelectorAll('track[data-nodecast-probe-track]'))
                    .find(element => element.track === track);
                const isActive = track.mode === 'showing' || (
                    probeTrack && Number(probeTrack.dataset.nodecastSubtitleIndex) === this.selectedSubtitleStreamIndex
                );
                const option = document.createElement('button');
                option.type = 'button';
                option.className = 'captions-option';
                option.classList.toggle('active', isActive);
                option.textContent = label;
                option.addEventListener('click', () => this.selectCaptionTrack(i));
                this.captionsList.appendChild(option);
                if (isActive) anyActive = true;
            }
        }

        offOption.classList.toggle('active', !anyActive);
    }

    selectCaptionTrack(index) {
        if (!this.video) return;

        const tracks = this.video.textTracks;

        // A language change or Off selection supersedes any extraction that
        // has not finished yet. Keep at most one subtitle scan active.
        this.cancelProbeSubtitleLoads();

        // Disable all tracks
        for (let i = 0; i < tracks.length; i++) {
            tracks[i].mode = 'hidden';
        }

        // Enable selected track. Embedded subtitles are populated after the
        // active HLS session settles so the media engine cannot clear them.
        if (index >= 0 && index < tracks.length) {
            const probeTrack = Array.from(this.video.querySelectorAll('track[data-nodecast-probe-track]'))
                .find(element => element.track === tracks[index]);
            if (probeTrack) {
                this.selectedSubtitleStreamIndex = Number(probeTrack.dataset.nodecastSubtitleIndex);
                if (this.subtitleWindowCovers(probeTrack, this.getCurrentPlaybackTime())) {
                    this.activateProbeSubtitleTrack(probeTrack);
                    this.scheduleSelectedSubtitleRestore();
                } else {
                    void this.loadProbeSubtitleTrack(probeTrack, {
                        windowStart: this.getSubtitleWindowStart(this.getCurrentPlaybackTime())
                    });
                }
            } else {
                this.clearSubtitleRestoreTimers();
                this.selectedSubtitleStreamIndex = null;
                tracks[index].mode = 'showing';
            }
        } else {
            this.clearSubtitleRestoreTimers();
            this.selectedSubtitleStreamIndex = null;
        }

        // Update UI
        this.updateCaptionsTracks();
        this.closeCaptionsMenu();
    }

    // === Overlay Auto-Hide ===

    showOverlay() {
        this.overlay?.classList.remove('hidden');
        this.overlayVisible = true;
        this.startOverlayTimer();
    }

    hideOverlay() {
        if (!this.video?.paused) {
            this.overlay?.classList.add('hidden');
            this.overlayVisible = false;
        }
    }

    startOverlayTimer() {
        clearTimeout(this.overlayTimeout);
        this.overlayTimeout = setTimeout(() => this.hideOverlay(), 3000);
    }

    // === Keyboard Shortcuts ===

    handleKeyboard(e) {
        // Only handle when watch page is active
        const watchPage = document.getElementById('page-watch');
        if (!watchPage?.classList.contains('active')) return;

        // Don't handle if typing in input
        if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                this.togglePlay();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                this.skip(-10);
                this.showOverlay();
                break;
            case 'ArrowRight':
                e.preventDefault();
                this.skip(10);
                this.showOverlay();
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.setVolume(Math.min(100, parseInt(this.volumeSlider.value) + 10));
                this.volumeSlider.value = Math.min(100, parseInt(this.volumeSlider.value) + 10);
                this.showOverlay();
                break;
            case 'ArrowDown':
                e.preventDefault();
                this.setVolume(Math.max(0, parseInt(this.volumeSlider.value) - 10));
                this.volumeSlider.value = Math.max(0, parseInt(this.volumeSlider.value) - 10);
                this.showOverlay();
                break;
            case 'f':
                e.preventDefault();
                this.toggleFullscreen();
                break;
            case 'm':
                e.preventDefault();
                this.toggleMute();
                this.showOverlay();
                break;
            case 'Escape':
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    this.goBack();
                }
                break;
        }
    }

    // === Details Section ===

    renderDetails() {
        if (!this.content) return;

        const isChannel = this.content.type === 'channel' || !this.content.type; // Default to channel if unknown
        const fallback = isChannel ? 'img/placeholder.png' : 'img/poster-placeholder.jpg';

        this.posterEl.onerror = () => {
            this.posterEl.onerror = null;
            this.posterEl.src = fallback;
        };
        this.posterEl.src = this.content.poster || fallback;
        this.posterEl.alt = this.content.title || '';
        this.contentTitleEl.textContent = this.content.title || '';
        this.yearEl.textContent = this.content.year || '';
        this.ratingEl.textContent = this.content.rating ? `★ ${this.content.rating}` : '';
        this.descriptionEl.textContent = this.content.description || '';

        // Update play button text
        if (this.playBtnText) {
            this.playBtnText.textContent = 'Play';
        }
    }

    async checkFavorite() {
        if (!this.content) return;

        try {
            const itemId = this.contentType === 'movie' ? this.content.id : this.content.seriesId;
            const itemType = this.contentType === 'movie' ? 'movie' : 'series';
            const result = await API.favorites.check(this.content.sourceId, itemId, itemType);
            this.isFavorite = result?.isFavorite || false;
            this.updateFavoriteUI();
        } catch (e) {
            console.warn('Could not check favorite status');
        }
    }

    async toggleFavorite() {
        if (!this.content) return;

        const itemId = this.contentType === 'movie' ? this.content.id : this.content.seriesId;
        const itemType = this.contentType === 'movie' ? 'movie' : 'series';

        try {
            if (this.isFavorite) {
                await API.favorites.remove(this.content.sourceId, itemId, itemType);
                this.isFavorite = false;
            } else {
                await API.favorites.add(this.content.sourceId, itemId, itemType);
                this.isFavorite = true;
            }
            this.updateFavoriteUI();
        } catch (e) {
            console.error('Error toggling favorite:', e);
        }
    }

    updateFavoriteUI() {
        const outlineIcon = this.favoriteBtn?.querySelector('.icon-fav-outline');
        const filledIcon = this.favoriteBtn?.querySelector('.icon-fav-filled');

        outlineIcon?.classList.toggle('hidden', this.isFavorite);
        filledIcon?.classList.toggle('hidden', !this.isFavorite);
    }

    scrollToVideo() {
        document.getElementById('page-watch')?.scrollTo({ top: 0, behavior: 'smooth' });
        if (this.video?.paused) {
            this.video.play().catch(console.error);
        }
    }

    // === Recommended Movies ===

    async loadRecommended(sourceId, categoryId) {
        if (!sourceId || !categoryId) {
            this.recommendedSection?.classList.add('hidden');
            return;
        }

        try {
            const movies = await API.proxy.xtream.vodStreams(sourceId, categoryId);
            if (!movies || movies.length === 0) {
                this.recommendedSection?.classList.add('hidden');
                return;
            }

            // Filter out current movie, take first 12
            const filtered = movies
                .filter(m => m.stream_id !== this.content?.id)
                .slice(0, 12);

            this.renderRecommendedGrid(filtered, sourceId);
        } catch (e) {
            console.error('Error loading recommended:', e);
            this.recommendedSection?.classList.add('hidden');
        }
    }

    renderRecommendedGrid(movies, sourceId) {
        if (!this.recommendedGrid) return;

        this.recommendedGrid.innerHTML = movies.map(movie => `
            <div class="watch-recommended-card" data-id="${movie.stream_id}" data-source="${sourceId}">
                <img src="${movie.stream_icon || movie.cover || 'img/placeholder.png'}"
                     alt="${movie.name}" 
                     onerror="this.onerror=null;this.src='img/placeholder.png'" loading="lazy">
                <p>${movie.name}</p>
            </div>
        `).join('');

        // Click handlers
        this.recommendedGrid.querySelectorAll('.watch-recommended-card').forEach(card => {
            card.addEventListener('click', () => this.playRecommendedMovie(card.dataset.id, parseInt(card.dataset.source)));
        });
    }

    async playRecommendedMovie(streamId, sourceId) {
        try {
            // Fetch movie details
            const movies = await API.proxy.xtream.vodStreams(sourceId);
            const movie = movies?.find(m => m.stream_id == streamId);

            if (!movie) return;

            const container = movie.container_extension || 'mp4';
            const result = await API.proxy.xtream.getStreamUrl(sourceId, streamId, 'movie', container);

            if (result?.url) {
                this.play({
                    type: 'movie',
                    id: movie.stream_id,
                    title: movie.name,
                    poster: movie.stream_icon || movie.cover,
                    description: movie.plot || '',
                    year: movie.year,
                    rating: movie.rating,
                    sourceId: sourceId,
                    categoryId: movie.category_id
                }, result.url);
            }
        } catch (e) {
            console.error('Error playing recommended movie:', e);
        }
    }

    // === Series Episodes ===

    renderEpisodes() {
        if (!this.seriesInfo?.episodes || !this.seasonsContainer) return;

        const seasons = Object.keys(this.seriesInfo.episodes).sort((a, b) => parseInt(a) - parseInt(b));

        this.seasonsContainer.innerHTML = seasons.map(seasonNum => {
            const episodes = this.seriesInfo.episodes[seasonNum];
            const isCurrentSeason = parseInt(seasonNum) === parseInt(this.currentSeason);

            return `
                <div class="watch-season-group">
                    <div class="watch-season-header ${isCurrentSeason ? '' : 'collapsed'}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon">
                            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                        </svg>
                        <span class="watch-season-name">Season ${seasonNum}</span>
                        <span class="watch-season-count">${episodes.length} episodes</span>
                    </div>
                    <div class="watch-episode-list">
                        ${episodes.map(ep => {
                const isActive = parseInt(seasonNum) === parseInt(this.currentSeason) &&
                    parseInt(ep.episode_num) === parseInt(this.currentEpisode);
                return `
                                <div class="watch-episode-item ${isActive ? 'active' : ''}" 
                                     data-episode-id="${ep.id}" 
                                     data-season="${seasonNum}"
                                     data-episode="${ep.episode_num}"
                                     data-container="${ep.container_extension || 'mp4'}">
                                    <span class="watch-episode-num">E${ep.episode_num}</span>
                                    <span class="watch-episode-title">${ep.title || `Episode ${ep.episode_num}`}</span>
                                    <span class="watch-episode-duration">${ep.duration || ''}</span>
                                </div>
                            `;
            }).join('')}
                    </div>
                </div>
            `;
        }).join('');

        // Season header toggle
        this.seasonsContainer.querySelectorAll('.watch-season-header').forEach(header => {
            header.addEventListener('click', () => {
                header.classList.toggle('collapsed');
            });
        });

        // Episode click handlers
        this.seasonsContainer.querySelectorAll('.watch-episode-item').forEach(ep => {
            ep.addEventListener('click', () => this.playEpisodeFromList(ep));
        });
    }

    async playEpisodeFromList(episodeEl) {
        const episodeId = episodeEl.dataset.episodeId;
        const seasonNum = episodeEl.dataset.season;
        const episodeNum = episodeEl.dataset.episode;
        const container = episodeEl.dataset.container || 'mp4';

        try {
            const result = await API.proxy.xtream.getStreamUrl(this.content.sourceId, episodeId, 'series', container);

            if (result?.url) {
                const episodeTitle = episodeEl.querySelector('.watch-episode-title')?.textContent || `Episode ${episodeNum}`;

                this.play({
                    type: 'series',
                    id: episodeId,
                    title: this.content.title,
                    subtitle: `S${seasonNum} E${episodeNum} - ${episodeTitle}`,
                    poster: this.content.poster,
                    description: this.content.description,
                    year: this.content.year,
                    rating: this.content.rating,
                    sourceId: this.content.sourceId,
                    seriesId: this.content.seriesId,
                    seriesInfo: this.seriesInfo,
                    currentSeason: seasonNum,
                    currentEpisode: episodeNum
                }, result.url);
            }
        } catch (e) {
            console.error('Error playing episode:', e);
        }
    }

    // === Next Episode ===

    getNextEpisode() {
        if (!this.seriesInfo?.episodes || !this.currentSeason || !this.currentEpisode) return null;

        const seasons = Object.keys(this.seriesInfo.episodes).sort((a, b) => parseInt(a) - parseInt(b));
        const currentSeasonEpisodes = this.seriesInfo.episodes[this.currentSeason] || [];

        // Find next episode in current season
        const currentEpIndex = currentSeasonEpisodes.findIndex(ep =>
            parseInt(ep.episode_num) === parseInt(this.currentEpisode)
        );

        if (currentEpIndex >= 0 && currentEpIndex < currentSeasonEpisodes.length - 1) {
            return {
                ...currentSeasonEpisodes[currentEpIndex + 1],
                seasonNum: this.currentSeason
            };
        }

        // Try next season
        const currentSeasonIndex = seasons.indexOf(String(this.currentSeason));
        if (currentSeasonIndex >= 0 && currentSeasonIndex < seasons.length - 1) {
            const nextSeason = seasons[currentSeasonIndex + 1];
            const nextSeasonEpisodes = this.seriesInfo.episodes[nextSeason];
            if (nextSeasonEpisodes?.length > 0) {
                return {
                    ...nextSeasonEpisodes[0],
                    seasonNum: nextSeason
                };
            }
        }

        return null;
    }

    showNextEpisodePanel(nextEp) {
        if (!this.nextEpisodePanel) return;

        this.nextEpisodeTitle.textContent = `S${nextEp.seasonNum} E${nextEp.episode_num} - ${nextEp.title || `Episode ${nextEp.episode_num}`}`;
        this.nextEpisodePanel.classList.remove('hidden');
        this.nextEpisodePanel.nextEpisodeData = nextEp;

        // Start countdown
        this.nextEpisodeCountdown = 10;
        this.nextCountdown.textContent = this.nextEpisodeCountdown;

        this.nextEpisodeInterval = setInterval(() => {
            this.nextEpisodeCountdown--;
            this.nextCountdown.textContent = this.nextEpisodeCountdown;

            if (this.nextEpisodeCountdown <= 0) {
                this.playNextEpisode();
            }
        }, 1000);
    }

    async playNextEpisode() {
        // Save next episode data BEFORE canceling (cancel clears the data)
        const nextEp = this.nextEpisodePanel?.nextEpisodeData;

        this.cancelNextEpisode();

        if (!nextEp) return;

        try {
            const container = nextEp.container_extension || 'mp4';
            const result = await API.proxy.xtream.getStreamUrl(this.content.sourceId, nextEp.id, 'series', container);

            if (result?.url) {
                this.play({
                    type: 'series',
                    id: nextEp.id,
                    title: this.content.title,
                    subtitle: `S${nextEp.seasonNum} E${nextEp.episode_num} - ${nextEp.title || `Episode ${nextEp.episode_num}`}`,
                    poster: this.content.poster,
                    description: this.content.description,
                    year: this.content.year,
                    rating: this.content.rating,
                    sourceId: this.content.sourceId,
                    seriesId: this.content.seriesId,
                    seriesInfo: this.seriesInfo,
                    currentSeason: nextEp.seasonNum,
                    currentEpisode: nextEp.episode_num
                }, result.url);
            }
        } catch (e) {
            console.error('Error playing next episode:', e);
        }
    }

    cancelNextEpisode() {
        clearInterval(this.nextEpisodeInterval);
        this.nextEpisodePanel?.classList.add('hidden');
        this.nextEpisodeShowing = false;
        this.nextEpisodeDismissed = true; // Prevent re-triggering
        if (this.nextEpisodePanel) {
            this.nextEpisodePanel.nextEpisodeData = null;
        }
    }

    // === Navigation ===

    goBack() {
        this.stop();
        this.cancelNextEpisode();

        // Navigate to the page we came from (stored in returnPage)
        // We don't use history.back() because we used replaceHistory when navigating here
        this.app.navigateTo(this.returnPage || 'movies');
    }

    show() {
        // Called when page becomes visible
    }

    hide() {
        // Called when page becomes hidden
        // Don't stop playback here - allow background playback
        this.cancelNextEpisode();
    }
    // ============================================================
    // Watch History Tracking
    // ============================================================

    startHistoryTracking() {
        this.stopHistoryTracking(); // Clear existing if any
        this.historyInterval = setInterval(() => this.saveProgress(), 10000); // 10s
    }

    stopHistoryTracking() {
        if (this.historyInterval) {
            clearInterval(this.historyInterval);
            this.historyInterval = null;
        }
    }

    async saveProgress() {
        if (!this.content || !this.video || this.video.paused) return;

        const progress = Math.floor(this.getCurrentPlaybackTime());
        const duration = Math.floor(this.getPlaybackDuration());

        if (isNaN(progress) || isNaN(duration) || duration <= 0) return;

        try {
            const data = {
                title: this.content.title || 'Unknown Title',
                subtitle: this.content.subtitle || (this.content.type === 'movie' ? 'Movie' : 'Series'),
                poster: this.content.poster,
                sourceId: this.content.sourceId,
                containerExtension: this.containerExtension,
                // Series-specific fields for next episode functionality
                seriesId: this.content.seriesId || null,
                currentSeason: this.currentSeason || null,
                currentEpisode: this.currentEpisode || null
            };

            await window.API.request('POST', '/history', {
                id: this.content.id,
                type: this.content.type === 'movie' ? 'movie' : 'episode',
                sourceId: this.content.sourceId,
                progress,
                duration,
                data
            });
        } catch (err) {
            console.warn('[History] Failed to save progress:', err);
        }
    }
}

window.WatchPage = WatchPage;
