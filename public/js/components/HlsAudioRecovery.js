/** Chromium can retain an invalid audio decoder state across HLS ad discontinuities. */
class HlsAudioRecovery {
    constructor(hls, video, events, isCurrent, options = {}) {
        this.hls = hls;
        this.video = video;
        this.events = events;
        this.isCurrent = isCurrent;
        const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
        this.chromium = options.chromium ?? /(?:Chrome|Chromium|Edg)\//.test(userAgent);
        this.now = options.now || (() => Date.now());
        this.setTimer = options.setTimer || ((action, delay) => setTimeout(action, delay));
        this.clearTimer = options.clearTimer || (handle => clearTimeout(handle));
        this.beforeRecovery = options.beforeRecovery;
        this.lastCC = null;
        this.lastRecovery = -Infinity;
        this.attempts = [];
        this.pendingBoundary = false;
        this.disposed = false;

        this.onFragment = (event, data) => {
            if (!this.active() || !data?.frag || data.frag.sn === 'initSegment' ||
                (data.frag.type && data.frag.type !== 'main')) return;
            const cc = data.frag.cc;
            if (!Number.isInteger(cc) || cc === this.lastCC) return;
            const previous = this.lastCC;
            this.lastCC = cc;
            if (previous === null || !this.chromium || this.video.seeking || this.onAttached) return;
            this.pendingBoundary = true;
            this.onPlaying();
        };
        this.onPlaying = () => {
            if (!this.active() || !this.pendingBoundary || this.video.paused || this.video.ended) return;
            this.pendingBoundary = false;
            this.requestRecovery('audio discontinuity');
        };
        this.onDestroy = () => this.dispose();
        this.onManifest = () => {
            if (!this.active()) return;
            this.lastCC = null;
            this.pendingBoundary = false;
            this.cancelRecovery();
        };
        hls.on(events.FRAG_CHANGED, this.onFragment);
        hls.on(events.DESTROYING, this.onDestroy);
        hls.on(events.MANIFEST_LOADING, this.onManifest);
        video.addEventListener?.('playing', this.onPlaying);
    }

    active() {
        return !this.disposed && this.isCurrent();
    }

    requestMediaError(data, mediaErrorType) {
        // hls.js already handles ordinary stalls and buffer-hole nudges.
        return data.type === mediaErrorType && (data.fatal || data.details === 'bufferAppendError') &&
            this.requestRecovery('media error', { retryAfterCooldown: Boolean(data.fatal) });
    }

    togglePendingPlayback() {
        if (!this.active() || !this.onAttached) return false;
        this.resumeAfterAttach = !this.resumeAfterAttach;
        return true;
    }

    requestRecovery(reason, { retryAfterCooldown = false } = {}) {
        if (!this.active()) return false;
        if (this.timer !== undefined || this.onAttached) return true;
        const now = this.now();
        this.attempts = this.attempts.filter(time => now - time < 30000);
        if (this.attempts.length >= 3) return false;
        const delay = Math.max(0, 2000 - (now - this.lastRecovery));
        if (delay && !retryAfterCooldown) return false;

        // Let HLS finish dispatching the fragment/error event before detaching its media.
        this.timer = this.setTimer(() => {
            this.timer = undefined;
            if (!this.active() || this.video.ended) return;
            const position = this.video.currentTime;
            this.resumeAfterAttach = !this.video.paused;
            const restoreCaptions = this.beforeRecovery?.();
            this.previousStartPosition = this.hls.config.startPosition;
            if (Number.isFinite(position) && position >= 0) this.hls.config.startPosition = position;
            this.lastRecovery = this.now();
            this.attempts.push(this.lastRecovery);
            const onAttached = () => {
                if (this.onAttached !== onAttached) return;
                const resume = this.resumeAfterAttach;
                this.cancelRecovery();
                if (!this.active()) return;
                restoreCaptions?.();
                if (resume) this.video.play().catch(() => {});
                else this.video.pause();
            };
            this.onAttached = onAttached;
            this.hls.on(this.events.MEDIA_ATTACHED, onAttached);
            this.attachTimer = this.setTimer(() => this.cancelRecovery(), 5000);
            console.info(`[HLS] Refreshing media decoder: ${reason}`);
            try {
                this.hls.recoverMediaError();
            } catch (error) {
                this.cancelRecovery();
                console.warn('[HLS] Media decoder could not be refreshed:', error.name);
            }
        }, delay);
        return true;
    }

    cancelRecovery() {
        this.clearTimer(this.timer);
        this.timer = undefined;
        this.clearTimer(this.attachTimer);
        this.attachTimer = undefined;
        if (this.onAttached) {
            this.hls.off(this.events.MEDIA_ATTACHED, this.onAttached);
            this.hls.config.startPosition = this.previousStartPosition;
            this.onAttached = null;
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.cancelRecovery();
        this.hls.off(this.events.FRAG_CHANGED, this.onFragment);
        this.hls.off(this.events.DESTROYING, this.onDestroy);
        this.hls.off(this.events.MANIFEST_LOADING, this.onManifest);
        this.video.removeEventListener?.('playing', this.onPlaying);
    }
}

if (typeof window !== 'undefined') window.HlsAudioRecovery = HlsAudioRecovery;
if (typeof module !== 'undefined') module.exports = HlsAudioRecovery;
