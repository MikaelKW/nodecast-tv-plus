const MAX_MEDIA_STREAM_INDEX = 1024;

function parseOptionalStreamIndex(value, fieldName = 'streamIndex') {
    if (value === undefined || value === null || value === '') return null;

    const normalized = typeof value === 'string' ? value.trim() : value;
    const index = typeof normalized === 'number'
        ? normalized
        : (/^\d+$/.test(normalized) ? Number(normalized) : Number.NaN);

    if (!Number.isInteger(index) || index < 0 || index > MAX_MEDIA_STREAM_INDEX) {
        throw new Error(`${fieldName} must be an integer between 0 and ${MAX_MEDIA_STREAM_INDEX}`);
    }

    return index;
}

module.exports = {
    MAX_MEDIA_STREAM_INDEX,
    parseOptionalStreamIndex
};
