const RESOLUTION_HEIGHTS = Object.freeze({
    '4k': 2160,
    '1080p': 1080,
    '720p': 720,
    '480p': 480
});

function parseMaxResolutionOverride(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !Object.hasOwn(RESOLUTION_HEIGHTS, value)) {
        throw new TypeError('maxResolution must be one of: 4k, 1080p, 720p, 480p');
    }
    return value;
}

module.exports = {
    RESOLUTION_HEIGHTS,
    parseMaxResolutionOverride
};
