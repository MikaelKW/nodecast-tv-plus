const path = require('node:path');
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');

test('subtitle presentation uses responsive text and a transparent outlined cue', async ({ page }) => {
    const stylesheet = fs.readFileSync(path.resolve(__dirname, '../../public/css/main.css'), 'utf8');
    await page.setContent(`
        <style>${stylesheet}</style>
        <video id="watch-video"></video>
    `);

    const cueRule = await page.evaluate(() => {
        for (const stylesheet of Array.from(document.styleSheets)) {
            for (const rule of Array.from(stylesheet.cssRules || [])) {
                if (rule.selectorText === 'video::cue') {
                    return {
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
        return null;
    });

    expect(cueRule).toEqual({
        backgroundColor: 'transparent',
        fontSize: 'clamp(20px, 2.1vw, 42px)',
        fontFamily: 'Inter, \"Segoe UI\", Arial, sans-serif',
        fontWeight: '500',
        lineHeight: '1.3',
        textShadow: expect.stringContaining('rgb(0, 0, 0)')
    });
});

test('subtitle refresh preserves existing WebKit cues and overlapping dialogue', async ({ page }) => {
    await page.setContent(`
        <video id="watch-video"></video>
        <div id="watch-captions-list"></div>
    `);
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

    expect(result.mode).toBe('showing');
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
