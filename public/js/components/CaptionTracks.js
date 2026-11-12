/** Subtitle choices belong to the current source, not the browser's lifetime track list. */
class CaptionTracks {
    constructor(video, onChange = () => {}) {
        this.video = video;
        this.onChange = onChange;
        this.hls = null;
        this.probe = null;
        this.remoteTracks = [];
        this.timeOffset = 0;
        this.remoteCueTimes = new WeakMap();
        this.hlsTracks = new Map();
        this.retired = new Set();
        this.generation = 0;
        this.selectionRevision = 0;
        this.video.textTracks?.addEventListener('change', onChange);
        this.video.textTracks?.addEventListener('addtrack', onChange);
        this.video.textTracks?.addEventListener('removetrack', onChange);
        this.video.addEventListener?.('loadedmetadata', onChange);
    }

    static isCaption(track) {
        return track.kind === 'subtitles' || track.kind === 'captions';
    }

    disableNativeTracks() {
        for (const track of Array.from(this.video.textTracks || [])) {
            if (CaptionTracks.isCaption(track)) track.mode = 'disabled';
        }
    }

    removeRemoteTracks() {
        for (const element of this.remoteTracks) element.remove();
        this.remoteTracks = [];
    }

    retireNativeTracks() {
        for (const track of Array.from(this.video.textTracks || [])) {
            if (!CaptionTracks.isCaption(track)) continue;
            track.mode = 'hidden';
            for (const cue of Array.from(track.cues || [])) track.removeCue(cue);
            track.mode = 'disabled';
        }
        this.removeRemoteTracks();
        for (const key of this.hlsTracks.keys()) this.removeHlsTrack(key);
        // addTextTrack tracks cannot be removed, and their addtrack event may arrive after reset.
        this.retired = new Set(Array.from(this.video.textTracks || []));
    }

    reset() {
        this.generation++;
        this.hls = null;
        this.probe = null;
        this.pendingRemoteSelection = null;
        this.timeOffset = 0;
        this.retireNativeTracks();
        this.onChange();
    }

    setProbe(info, url) {
        this.probe = { subtitles: info?.subtitles || [], url };
    }

    setTimeOffset(offset) {
        this.timeOffset = Number.isFinite(Number(offset)) ? Math.max(0, Number(offset)) : 0;
        for (const element of this.remoteTracks) this.alignRemoteCues(element);
    }

    alignRemoteCues(element) {
        const track = element.track, mode = track.mode;
        if (!track.cues?.length) return;
        track.mode = 'hidden';
        for (const cue of Array.from(track.cues || [])) {
            if (!this.remoteCueTimes.has(cue)) this.remoteCueTimes.set(cue, { start: cue.startTime, end: cue.endTime });
            const original = this.remoteCueTimes.get(cue);
            cue.startTime = Math.max(0, original.start - this.timeOffset);
            cue.endTime = Math.max(0, original.end - this.timeOffset);
        }
        track.mode = mode;
    }

    prepareMediaRecovery() {
        const tracks = Array.from(this.hlsTracks, ([key, entry]) => ({ key, entry,
            cues: Array.from(entry.element.track.cues || []), mode: entry.element.track.mode }));
        const hasRemoteTracks = this.remoteTracks.length > 0;
        if (!hasRemoteTracks && !tracks.length) return;
        const selected = this.remoteTracks.findIndex(element => element.track.mode === 'showing');
        const generation = this.generation, revision = this.selectionRevision;
        return () => {
            if (this.generation !== generation) return;
            // HLS detachment clears all native cues, including our owned caption tracks.
            for (const { key, entry, cues, mode } of tracks) {
                if (this.hlsTracks.get(key) !== entry) continue;
                this.appendHlsCues(entry, cues);
                if (this.selectionRevision === revision) entry.element.track.mode = mode;
            }
            if (hasRemoteTracks) {
                const remoteSelection = this.selectionRevision === revision ? selected :
                    this.remoteTracks.findIndex(element => element.track.mode === 'showing');
                this.removeRemoteTracks();
                this.addRemoteTracks();
                if (remoteSelection >= 0 && this.remoteTracks[remoteSelection]) this.remoteTracks[remoteSelection].track.mode = 'showing';
            }
            this.onChange();
        };
    }

    useNative({ allowProbe = true } = {}) {
        this.generation++;
        this.hls = null;
        if (allowProbe) this.addRemoteTracks();
        this.onChange();
    }

    addRemoteTracks() {
        if (this.remoteTracks.length || !this.probe) return;
        for (const subtitle of this.probe.subtitles) {
            const element = document.createElement('track');
            element.kind = 'subtitles';
            element.label = subtitle.title || subtitle.language || 'Subtitles';
            element.srclang = subtitle.language || '';
            element.src = NodeCastUrl.resolve(`/api/subtitle?url=${encodeURIComponent(this.probe.url)}&index=${subtitle.index}`);
            element.addEventListener('load', () => {
                if (this.remoteTracks.includes(element)) this.alignRemoteCues(element);
            });
            this.remoteTracks.push(element);
            this.video.appendChild(element);
        }
        const selected = this.remoteTracks[this.pendingRemoteSelection];
        this.pendingRemoteSelection = null;
        if (selected) selected.track.mode = 'showing';
    }

    captureRemoteSelection() {
        this.pendingRemoteSelection = this.remoteTracks.findIndex(element => element.track.mode === 'showing');
    }

    bindHls(hls, events) {
        const selected = this.remoteTracks.findIndex(element => element.track.mode === 'showing');
        if (selected >= 0) this.pendingRemoteSelection = selected;
        this.generation++;
        this.hls = hls;
        this.manifestReady = false;
        this.retireNativeTracks();
        const refresh = () => { if (this.hls === hls) this.onChange(); };
        hls.on(events.SUBTITLE_TRACKS_UPDATED, (event, data) => {
            if (this.hls !== hls) return;
            // Own removable DOM tracks so HLS cannot route cues to an orphan with the same label.
            const keys = new Set();
            (data?.subtitleTracks || hls.subtitleTracks || []).forEach((track, index) => {
                const key = track.default ? 'default' : `subtitles${index}`;
                keys.add(key);
                const entry = this.hlsTracks.get(key);
                if (entry && entry.subtitle?.url !== track.url) {
                    this.removeHlsTrack(key);
                }
                this.addHlsTrack(key, track.name, track.lang, track);
                this.hlsTracks.get(key).subtitle = track;
            });
            for (const [key, entry] of this.hlsTracks) {
                if (entry.subtitle && !keys.has(key)) this.removeHlsTrack(key);
            }
            // Never extract a second copy of subtitles already supplied by the manifest.
            if (hls.subtitleTracks?.length) this.removeRemoteTracks();
            this.syncHlsModes();
            refresh();
        });
        hls.on(events.SUBTITLE_TRACK_SWITCH, () => {
            if (this.hls !== hls) return;
            this.syncHlsModes();
            refresh();
        });
        hls.on(events.NON_NATIVE_TEXT_TRACKS_FOUND, (event, data) => {
            if (this.hls !== hls) return;
            for (const track of data.tracks) {
                if (track._id) this.addHlsTrack(track._id, track.label, track.closedCaptions?.lang);
            }
            refresh();
        });
        hls.on(events.CUES_PARSED, (event, data) => {
            if (this.hls !== hls) return;
            const entry = this.hlsTracks.get(data.track);
            if (!entry) return;
            // Loading an HTML track clears pre-existing cues. Buffer early CEA cues until load.
            if (entry.element.readyState !== 2) entry.pending.push(...data.cues);
            else this.appendHlsCues(entry, data.cues);
        });
        hls.on(events.MANIFEST_PARSED, (event, data) => {
            if (this.hls !== hls) return;
            this.manifestReady = true;
            // The active group getter may still be empty during MANIFEST_PARSED.
            // Use the manifest data to avoid briefly adding an extracted duplicate.
            if (!data?.subtitleTracks?.length && !hls.subtitleTracks?.length) this.addRemoteTracks();
            refresh();
        });
        refresh();
    }

    addHlsTrack(key, label, language, subtitle = null) {
        if (this.hlsTracks.has(key)) return;
        const element = document.createElement('track');
        element.kind = subtitle ? 'subtitles' : 'captions';
        element.label = label || 'Captions';
        element.srclang = language || '';
        element.src = URL.createObjectURL(new Blob(['WEBVTT\n\n'], { type: 'text/vtt' }));
        const entry = { element, subtitle, pending: [] };
        this.hlsTracks.set(key, entry);
        element.addEventListener('load', () => {
            if (this.hlsTracks.get(key) !== entry) return;
            this.appendHlsCues(entry, entry.pending);
            entry.pending = [];
            if (element.track.mode === 'hidden') element.track.mode = 'disabled';
        });
        this.video.appendChild(element);
        element.track.mode = 'hidden';
    }

    removeHlsTrack(key) {
        const entry = this.hlsTracks.get(key);
        if (!entry) return;
        this.hlsTracks.delete(key);
        entry.element.remove();
        URL.revokeObjectURL(entry.element.src);
    }

    appendHlsCues(entry, cues) {
        const track = entry.element.track;
        const mode = track.mode;
        track.mode = 'hidden';
        const keys = new Set();
        const key = cue => `${cue.startTime}:${cue.endTime}:${cue.text}:${cue.line}:${cue.position}:${cue.align}:${cue.size}:${cue.id}`;
        const live = entry.subtitle?.details?.live || this.hls?.levels?.[this.hls.currentLevel]?.details?.live;
        for (const cue of Array.from(track.cues || [])) {
            if (live && cue.endTime < this.video.currentTime - 60) track.removeCue(cue);
            else keys.add(key(cue));
        }
        for (const cue of cues) {
            if (!keys.has(key(cue))) { track.addCue(cue); keys.add(key(cue)); }
        }
        track.mode = mode;
    }

    syncHlsModes() {
        this.disableNativeTracks();
        const subtitle = this.hls?.subtitleTracks?.[this.hls.subtitleTrack];
        if (!subtitle || this.hls.subtitleDisplay === false) return;
        for (const entry of this.hlsTracks.values()) {
            if (entry.subtitle === subtitle) entry.element.track.mode = 'showing';
        }
    }

    choices() {
        const hls = this.hls;
        const generation = this.generation;
        const choices = [];
        if (hls && !this.manifestReady) return choices;
        if (hls?.subtitleTracks?.length) {
            hls.subtitleTracks.forEach((track, index) => {
                const suffix = [];
                if (track.forced) suffix.push('Forced');
                const characteristics = track.attrs?.CHARACTERISTICS || '';
                if (characteristics.includes('public.accessibility.describes-music-and-sound')) suffix.push('SDH');
                const name = track.name || track.lang || `Track ${index + 1}`;
                choices.push({ label: suffix.length ? `${name} (${suffix.join(', ')})` : name,
                    active: hls.subtitleDisplay !== false && hls.subtitleTrack === index,
                    select: () => {
                        if (this.hls !== hls || hls.subtitleTracks[index] !== track) return;
                        this.selectionRevision++;
                        this.disableNativeTracks();
                        hls.subtitleDisplay = true;
                        hls.subtitleTrack = index;
                        this.syncHlsModes();
                    } });
            });
        }

        const elements = new Set(Array.from(this.video.querySelectorAll?.('track') || [], element => element.track));
        const hlsSubtitles = new Set(Array.from(this.hlsTracks.values()).filter(entry => entry.subtitle).map(entry => entry.element.track));
        for (const track of Array.from(this.video.textTracks || [])) {
            if (!CaptionTracks.isCaption(track)) continue;
            if (hlsSubtitles.has(track)) continue;
            // Ignore tracks left over from earlier sources; retain current DOM/native tracks.
            if (this.retired.has(track) && !track.cues?.length && !elements.has(track)) continue;
            choices.push({ label: track.label || track.language || `Track ${choices.length + 1}`,
                active: track.mode === 'showing', select: () => {
                    if (this.generation !== generation) return;
                    this.off();
                    track.mode = 'showing';
                    const remote = this.remoteTracks.find(element => element.track === track);
                    if (remote) this.alignRemoteCues(remote);
                } });
        }
        const counts = new Map();
        for (const choice of choices) counts.set(choice.label, (counts.get(choice.label) || 0) + 1);
        const positions = new Map();
        for (const choice of choices) {
            if (counts.get(choice.label) <= 1) continue;
            const position = (positions.get(choice.label) || 0) + 1;
            positions.set(choice.label, position);
            choice.label += ` (Track ${position})`;
        }
        return choices;
    }

    off() {
        this.selectionRevision++;
        if (this.hls) {
            this.hls.subtitleTrack = -1;
            this.hls.subtitleDisplay = false;
        }
        this.disableNativeTracks();
    }

    render(list, onSelect) {
        const choices = this.choices();
        list.replaceChildren();
        const append = (label, active, select) => {
            const button = document.createElement('button');
            button.className = 'captions-option';
            button.textContent = label;
            if (active) button.classList.add('active');
            button.onclick = event => {
                event.stopPropagation();
                select();
                this.onChange();
                onSelect();
            };
            list.appendChild(button);
        };
        append('Off', !choices.some(choice => choice.active), () => this.off());
        for (const choice of choices) append(choice.label, choice.active, choice.select);
    }
}

if (typeof window !== 'undefined') window.CaptionTracks = CaptionTracks;
if (typeof module !== 'undefined') module.exports = CaptionTracks;
