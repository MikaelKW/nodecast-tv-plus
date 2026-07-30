'use strict';

const MAX_HISTORY_ITEMS_PER_USER = 500;
const MAX_HISTORY_METADATA_BYTES = 32 * 1024;
const MAX_HISTORY_ID_LENGTH = 512;
const MAX_MEDIA_SECONDS = 10 * 365 * 24 * 60 * 60;
const ALLOWED_HISTORY_TYPES = new Set(['movie', 'episode']);

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function normalizeText(value, name, { required = false } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw badRequest(`${name} is required`);
        return null;
    }

    const normalized = String(value);
    if (normalized.length > MAX_HISTORY_ID_LENGTH) {
        throw badRequest(`${name} is too long`);
    }
    return normalized;
}

function normalizeSeconds(value, name) {
    if (value === undefined || value === null || value === '') return 0;
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized < 0 || normalized > MAX_MEDIA_SECONDS) {
        throw badRequest(`${name} must be a valid non-negative playback time`);
    }
    return Math.floor(normalized);
}

function normalizeSourceId(value) {
    if (value === undefined || value === null || value === '') return null;
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized) || normalized <= 0) {
        throw badRequest('sourceId must be a positive integer');
    }
    return normalized;
}

function normalizeHistoryPayload(body = {}) {
    const itemId = normalizeText(body.id, 'id', { required: true });
    const itemType = normalizeText(body.type, 'type', { required: true });
    if (!ALLOWED_HISTORY_TYPES.has(itemType)) {
        throw badRequest('type must be movie or episode');
    }

    if (body.data !== undefined && (
        body.data === null
        || typeof body.data !== 'object'
        || Array.isArray(body.data)
    )) {
        throw badRequest('data must be an object');
    }

    let serializedData;
    try {
        serializedData = JSON.stringify(body.data || {});
    } catch {
        throw badRequest('data must be JSON serializable');
    }
    if (Buffer.byteLength(serializedData, 'utf8') > MAX_HISTORY_METADATA_BYTES) {
        throw badRequest(`data must not exceed ${MAX_HISTORY_METADATA_BYTES} bytes`);
    }

    return {
        itemId,
        itemType,
        parentId: normalizeText(body.parentId, 'parentId'),
        sourceId: normalizeSourceId(body.sourceId),
        progress: normalizeSeconds(body.progress, 'progress'),
        duration: normalizeSeconds(body.duration, 'duration'),
        serializedData
    };
}

function pruneHistory(db, userId) {
    return db.prepare(`
        DELETE FROM watch_history
        WHERE user_id = ?
          AND id IN (
              SELECT id
              FROM watch_history
              WHERE user_id = ?
              ORDER BY updated_at DESC, id DESC
              LIMIT -1 OFFSET ?
          )
    `).run(userId, userId, MAX_HISTORY_ITEMS_PER_USER);
}

module.exports = {
    MAX_HISTORY_ITEMS_PER_USER,
    MAX_HISTORY_METADATA_BYTES,
    normalizeHistoryPayload,
    pruneHistory
};
