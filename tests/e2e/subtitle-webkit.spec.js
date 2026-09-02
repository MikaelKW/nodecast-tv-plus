const path = require('node:path');
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');

test('subtitle presentation uses the same responsive typography for the HTML overlay and native fallback', async ({ page }) => {
    const stylesheet = fs.readFileSync(path.resolve(__dirname, '../../public/css/main.css'), 'utf8');
    await page.setContent(`
        <style>${stylesheet}</style>
        <video id="watch-video"></video>
        <div class="watch-subtitle-overlay">
            <div class="watch-subtitle-stack">Controlled subtitle</div>
        </div>
    `);

    const presentation = await page.evaluate(() => {
        let cueRule = null;
        for (const stylesheet of Array.from(document.styleSheets)) {
            for (const rule of Array.from(stylesheet.cssRules || [])) {
                if (rule.selectorText === 'video::cue') {
                    cueRule = {
                        backgroundColor: rule.style.backgroundColor,
                        fontSize: rule.style.fontSize,
                        fontFamily: rule.style.fontFamily,
                        fontWeight: rule.style.fontWeight,
                        lineHeight: rule.style.lineHeight,
                        textShadow: rule.style.textShadow
                    };
                }
            }
        }
        const overlayStyle = getComputedStyle(document.querySelector('.watch-subtitle-stack'));
        return {
            cueRule,
            overlay: {
                backgroundColor: overlayStyle.backgroundColor,
                fontSize: overlayStyle.fontSize,
                fontFamily: overlayStyle.fontFamily,
                fontWeight: overlayStyle.fontWeight,
                lineHeight: overlayStyle.lineHeight,
                textShadow: overlayStyle.textShadow
            }
        };
    });

    expect(presentation.cueRule).toEqual({
        backgroundColor: 'transparent',
        fontSize: 'clamp(20px, 2.1vw, 42px)',
        fontFamily: 'Inter, \"Segoe UI\", Arial, sans-serif',
        fontWeight: '500',
        lineHeight: '1.3',
        textShadow: expect.stringContaining('rgb(0, 0, 0)')
    });
    expect(presentation.overlay.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(presentation.overlay.fontFamily).toBe('Inter, "Segoe UI", Arial, sans-serif');
    expect(presentation.overlay.fontWeight).toBe('500');
    expect(presentation.overlay.textShadow).toContain('rgb(0, 0, 0)');
});

test('subtitle refresh preserves existing WebKit cues and overlapping dialogue', async ({ page }) => {
    await page.setContent(`
        <div>
            <video id="watch-video"></video>
            <div class="watch-subtitle-overlay hidden" id="watch-subtitle-overlay">
                <div class="watch-subtitle-stack" id="watch-subtitle-stack"></div>
            </div>
        </div>
        <div id="watch-captions-list"></div>
    `);
    await page.addScriptTag({
        path: path.resolve(__dirname, '../../public/js/components/SubtitlePreferences.js')
    });
    await page.addScriptTag({
        path: path.resolve(__dirname, '../../public/js/pages/WatchPage.js')
    });

    const result = await page.evaluate(() => {
        const watch = new window.WatchPage({});
        const trackElement = document.createElement('track');
        trackElement.kind = 'subtitles';
        trackElement.label = 'English';
        trackElement.srclang = 'eng';
        trackElement.dataset.nodecastProbeTrack = 'true';
        trackElement.dataset.nodecastSubtitleIndex = '3';
        watch.video.appendChild(trackElement);

        watch.selectedSubtitleStreamIndex = 3;
        watch.probeSubtitleCues.set(trackElement, [
            { startTime: 0.5, endTime: 6, text: 'First controlled speaker' },
            { startTime: 2, endTime: 6, text: 'Second controlled speaker' },
            { startTime: 2, endTime: 6, text: '[Controlled background sound]' }
        ]);
        watch.activateProbeSubtitleTrack(trackElement);

        const initialCues = Array.from(trackElement.track.cues || []);
        watch.setSubtitleMediaTimeOffset(1.4);
        const offsetCues = Array.from(trackElement.track.cues || []);
        watch.mergeProbeSubtitleCues(trackElement, [
            { startTime: 2, endTime: 6, text: 'Second controlled speaker' },
            { startTime: 6, endTime: 9, text: 'Later controlled cue\ncontinued' }
        ]);
        watch.activateProbeSubtitleTrack(trackElement);

        const refreshedCues = Array.from(trackElement.track.cues || []);
        return {
            mode: trackElement.track.mode,
            texts: refreshedCues.map(cue => cue.text),
            lines: refreshedCues.map(cue => cue.line),
            lineAligns: refreshedCues.map(cue => cue.lineAlign),
            snapToLines: refreshedCues.map(cue => cue.snapToLines),
            initialCount: initialCues.length,
            refreshedCount: refreshedCues.length,
            initialStart: initialCues[0].startTime,
            offsetStart: offsetCues[0].startTime,
            rebuiltForOffset: initialCues[0] !== offsetCues[0],
            preservedExistingObjects: offsetCues.every((cue, index) => refreshedCues[index] === cue)
        };
    });

    expect(result.mode).toBe('hidden');
    expect(result.initialCount).toBe(3);
    expect(result.refreshedCount).toBe(4);
    expect(result.lines).toEqual([74, 81, 88, 88]);
    expect(result.lineAligns).toEqual(['end', 'end', 'end', 'end']);
    expect(result.snapToLines).toEqual([false, false, false, false]);
    expect(result.initialStart).toBeCloseTo(0.5, 3);
    expect(result.offsetStart).toBeCloseTo(1.9, 3);
    expect(result.rebuiltForOffset).toBe(true);
    expect(result.preservedExistingObjects).toBe(true);
    expect(result.texts).toContain('First controlled speaker');
    expect(result.texts).toContain('Second controlled speaker');
    expect(result.texts).toContain('[Controlled background sound]');
});

test('HTML subtitle overlay renders active cues safely and uses native cues only for browser-controlled surfaces', async ({ page }) => {
    await page.setContent(`
        <div id="video-container">
            <video id="watch-video"></video>
            <div class="watch-subtitle-overlay hidden" id="watch-subtitle-overlay">
                <div class="watch-subtitle-stack" id="watch-subtitle-stack"></div>
            </div>
        </div>
        <div id="watch-captions-list"></div>
    `);
    await page.addScriptTag({
        path: path.resolve(__dirname, '../../public/js/components/SubtitlePreferences.js')
    });
    await page.addScriptTag({
        path: path.resolve(__dirname, '../../public/js/pages/WatchPage.js')
    });

    const result = await page.evaluate(() => {
        const container = document.getElementById('video-container');
        const video = document.getElementById('watch-video');
        Object.defineProperty(container, 'clientWidth', { configurable: true, value: 1000 });
        Object.defineProperty(container, 'clientHeight', { configurable: true, value: 1000 });
        Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 });
        Object.defineProperty(video, 'videoHeight', { configurable: true, value: 1080 });

        let cueChangeHandler = null;
        const track = {
            mode: 'disabled',
            activeCues: [
                { startTime: 2, endTime: 6, text: 'First controlled speaker\ncontinued' },
                { startTime: 2, endTime: 6, text: '[Controlled background sound]' }
            ],
            addEventListener(type, handler) {
                if (type === 'cuechange') cueChangeHandler = handler;
            },
            removeEventListener() {}
        };

        const watch = new window.WatchPage({});
        watch.setActiveSubtitleTrack(track);
        const initial = {
            mode: track.mode,
            hidden: watch.subtitleOverlay.classList.contains('hidden'),
            texts: Array.from(watch.subtitleStack.children, element => element.textContent),
            left: watch.subtitleOverlay.style.left,
            top: watch.subtitleOverlay.style.top,
            width: watch.subtitleOverlay.style.width,
            height: watch.subtitleOverlay.style.height
        };

        watch.setNativeSubtitleContext('ios-fullscreen', true);
        const native = {
            mode: track.mode,
            hidden: watch.subtitleOverlay.classList.contains('hidden')
        };

        track.activeCues = [{
            startTime: 7,
            endTime: 9,
            text: '<img src=x onerror="window.subtitleInjected=true">Safe text'
        }];
        watch.setNativeSubtitleContext('ios-fullscreen', false);
        cueChangeHandler();
        const returned = {
            mode: track.mode,
            hidden: watch.subtitleOverlay.classList.contains('hidden'),
            text: watch.subtitleStack.textContent,
            containsImage: Boolean(watch.subtitleStack.querySelector('img')),
            injected: Boolean(window.subtitleInjected)
        };

        watch.setActiveSubtitleTrack(null);
        return {
            initial,
            native,
            returned,
            off: {
                previousTrackMode: track.mode,
                hidden: watch.subtitleOverlay.classList.contains('hidden'),
                childCount: watch.subtitleStack.childElementCount
            }
        };
    });

    expect(result.initial).toEqual({
        mode: 'hidden',
        hidden: false,
        texts: ['First controlled speaker\ncontinued', '[Controlled background sound]'],
        left: '0px',
        top: '218.75px',
        width: '1000px',
        height: '562.5px'
    });
    expect(result.native).toEqual({ mode: 'showing', hidden: true });
    expect(result.returned).toEqual({
        mode: 'hidden',
        hidden: false,
        text: '<img src=x onerror="window.subtitleInjected=true">Safe text',
        containsImage: false,
        injected: false
    });
    expect(result.off).toEqual({ previousTrackMode: 'hidden', hidden: true, childCount: 0 });
});
