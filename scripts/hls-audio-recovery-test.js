const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const HlsAudioRecovery = require('../public/js/components/HlsAudioRecovery');

const events = {
    FRAG_CHANGED: 'frag-changed', DESTROYING: 'destroying',
    MANIFEST_LOADING: 'manifest-loading', MEDIA_ATTACHED: 'media-attached'
};

function fixture({ chromium = true, paused = false } = {}) {
    let time = 0, current = true, captions = 0, id = 0;
    const timers = new Map();
    const positions = [];
    const video = Object.assign(new EventTarget(), {
        paused, ended: false, seeking: false, currentTime: 23.5, playCalls: 0, pauseCalls: 0,
        async play() { this.playCalls++; this.paused = false; },
        pause() { this.pauseCalls++; this.paused = true; }
    });
    const hls = Object.assign(new EventEmitter(), {
        config: { startPosition: -1 },
        recoverMediaError() {
            positions.push(this.config.startPosition);
            video.paused = true;
        }
    });
    const recovery = new HlsAudioRecovery(hls, video, events, () => current, {
        chromium,
        now: () => time,
        setTimer: (action, delay) => { timers.set(++id, { action, at: time + delay }); return id; },
        clearTimer: handle => timers.delete(handle),
        beforeRecovery: () => () => { captions++; }
    });
    const advance = delta => {
        const end = time + delta;
        for (;;) {
            const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            timers.delete(next[0]);
            time = next[1].at;
            next[1].action();
        }
        time = end;
    };
    const frag = (cc, options = {}) => hls.emit(events.FRAG_CHANGED, null, { frag: { cc, sn: 1, type: 'main', ...options } });
    const attach = () => hls.emit(events.MEDIA_ATTACHED);
    const mediaError = (fatal, details) => recovery.requestMediaError({ type: 'media', fatal, details }, 'media');
    return { video, hls, recovery, positions, advance, frag, attach, mediaError,
        captionRestores: () => captions, replace: () => { current = false; } };
}

{
    const f = fixture();
    f.frag(4);
    f.frag(5, { sn: 'initSegment' });
    f.frag(5, { type: 'audio' });
    f.advance(0);
    assert.equal(f.positions.length, 0);
    f.frag(5);
    f.frag(5);
    assert.equal(f.mediaError(true), true);
    f.advance(0);
    assert.deepEqual(f.positions, [23.5]);
    f.attach();
    assert.equal(f.hls.config.startPosition, -1);
    assert.equal(f.video.playCalls, 1);
    assert.equal(f.captionRestores(), 1);
    f.frag(5);
    f.advance(2000);
    assert.equal(f.positions.length, 1);
}

{
    const f = fixture({ paused: true });
    f.frag(1);
    f.frag(2);
    f.advance(0);
    assert.equal(f.positions.length, 0, 'A discontinuity must not restart paused playback.');
    f.video.paused = false;
    f.video.dispatchEvent(new Event('playing'));
    f.advance(0);
    assert.equal(f.positions.length, 1);
    assert.equal(f.recovery.togglePendingPlayback(), true);
    f.attach();
    assert.equal(f.video.playCalls, 0);
    assert.equal(f.video.pauseCalls, 1, 'A pause during attachment must win over the earlier resume intent.');
}

{
    const f = fixture({ chromium: false, paused: true });
    f.frag(1);
    f.frag(2);
    f.advance(0);
    assert.equal(f.positions.length, 0);
    assert.equal(f.mediaError(false, 'bufferStalledError'), false);
    for (let i = 0; i < 3; i++) {
        assert.equal(f.mediaError(true), true);
        assert.equal(f.mediaError(true), true);
        f.advance(i ? 2000 : 0);
        f.attach();
    }
    assert.equal(f.mediaError(true), false);
    assert.equal(f.positions.length, 3);
    assert.equal(f.video.playCalls, 0);
    f.advance(30000);
    assert.equal(f.mediaError(true), true);
}

{
    const f = fixture();
    f.frag(1);
    f.frag(2);
    f.replace();
    f.advance(0);
    assert.equal(f.positions.length, 0);
    f.hls.emit(events.DESTROYING);
    assert.equal(f.hls.listenerCount(events.FRAG_CHANGED), 0);
}

{
    const f = fixture();
    f.mediaError(true);
    f.advance(0);
    f.replace();
    f.attach();
    assert.equal(f.hls.config.startPosition, -1);
    assert.equal(f.captionRestores(), 0);
    assert.equal(f.video.playCalls, 0);
}

{
    const f = fixture();
    f.mediaError(true);
    f.advance(0);
    f.advance(5000);
    assert.equal(f.hls.listenerCount(events.MEDIA_ATTACHED), 0);
    assert.equal(f.hls.config.startPosition, -1);
    f.attach();
    assert.equal(f.captionRestores(), 0);
    f.mediaError(true);
    f.hls.emit(events.MANIFEST_LOADING);
    f.advance(0);
    assert.equal(f.positions.length, 1);
}

console.log('HLS recovery timing, limits, pause intent, position, caption restoration and cancellation tests passed.');
