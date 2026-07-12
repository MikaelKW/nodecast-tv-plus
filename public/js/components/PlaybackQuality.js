/**
 * Shared helpers for session-only playback quality controls.
 */
const PlaybackQuality = (() => {
    const resolutionHeights = Object.freeze({
        '4k': 2160,
        '1080p': 1080,
        '720p': 720,
        '480p': 480
    });

    function isValid(value) {
        return value === 'auto' || Object.prototype.hasOwnProperty.call(resolutionHeights, value);
    }

    function getHeight(value) {
        return resolutionHeights[value] || 0;
    }

    function getLabel(value) {
        if (value === 'auto') return 'Auto';
        if (value === '4k') return '4K';
        return value;
    }

    function findAdaptiveLevel(levels, value) {
        const cap = getHeight(value);
        if (!Array.isArray(levels) || levels.length < 2 || !cap) return -1;

        return levels
            .map((level, index) => ({
                index,
                height: Number(level?.height) || 0,
                bitrate: Number(level?.bitrate) || 0
            }))
            .filter(level => level.height > 0 && level.height <= cap)
            .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate)[0]?.index ?? -1;
    }

    return { isValid, getHeight, getLabel, findAdaptiveLevel };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlaybackQuality;
}
