'use strict';

// Internal storage identity only. Provider IDs in API responses, playback URLs,
// favourites and visibility requests remain unchanged.
function catalogueId(sourceId, type, providerId) {
    return `${sourceId}:${type}:${providerId}`;
}

module.exports = { catalogueId };
