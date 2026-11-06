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
        this.beforeRecovery = options.beforeRecovery;
        this.lastCC = null;
        this.lastRecovery = -Infinity;
        this.attempts = [];
        this.pendingBoundary = false;
        this.disposed = false;

        this.onFragment = (event, data) => {
            if (!this.active() || !data?.frag || data.frag.sn === 'initSegment') return;
            const cc = data.frag.cc;
            if (!Number.isInteger(cc) || cc === this.lastCC) return;
            const previous = this.lastCC;
            this.lastCC = cc;
            if (previous === null || !this.chromium) return;
            this.pendingBoundary = true;
            this.onPlaying();
        };
        this.onPlaying = () => {
            if (!this.active() || !this.pendingBoundary || this.video.paused) return;
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

    requestRecovery(reason) {
        if (!this.active()) return false;
        if (this.timer !== undefined || this.onAttached) return true;
        const now = this.now();
        this.attempts = this.attempts.filter(time => now - time < 30000);
        if (now - this.lastRecovery < 2000 || this.attempts.length >= 3) return false;

        // Let HLS finish dispatching the fragment/error event before detaching its media.
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (!this.active()) return;
            const position = this.video.currentTime;
            const resume = !this.video.paused && !this.video.ended;
            const restoreCaptions = this.beforeRecovery?.();
            this.previousStartPosition = this.hls.config.startPosition;
            if (Number.isFinite(position) && position >= 0) this.hls.config.startPosition = position;
            this.lastRecovery = this.now();
            this.attempts.push(this.lastRecovery);
            this.onAttached = () => {
                if (!this.active() || !this.onAttached) return;
                this.hls.off(this.events.MEDIA_ATTACHED, this.onAttached);
                this.onAttached = null;
                this.hls.config.startPosition = this.previousStartPosition;
                if (!this.active()) return;
                restoreCaptions?.();
                if (resume) this.video.play().catch(() => {});
                else this.video.pause();
            };
            this.hls.on(this.events.MEDIA_ATTACHED, this.onAttached);
            console.info(`[HLS] Refreshing media decoder: ${reason}`);
            this.hls.recoverMediaError();
        }, 0);
        return true;
    }

    cancelRecovery() {
        clearTimeout(this.timer);
        this.timer = undefined;
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
