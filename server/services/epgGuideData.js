const { getDb } = require('../db/sqlite');

const GUIDE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PROGRAMME_SPAN_MS = 7 * 24 * 60 * 60 * 1000;

const NOW_PLAYING_SQL = `
    SELECT channel_id AS channelId, start_time, end_time, title
    FROM epg_programs
    WHERE source_id = ?
      AND start_time >= ?
      AND start_time <= ?
      AND end_time > ?
`;

const FULL_GUIDE_SQL = `
    SELECT channel_id AS channelId, start_time, end_time, title, description
    FROM epg_programs
    WHERE source_id = ?
      AND start_time >= ?
      AND start_time < ?
      AND end_time > ?
`;

function normalizeSourceId(value) {
    const sourceId = Number(value);
    if (!Number.isSafeInteger(sourceId) || sourceId < 1) {
        throw new TypeError('Invalid source id');
    }
    return sourceId;
}

function getStoredChannels(db, sourceId, { includeData = false } = {}) {
    const dataColumn = includeData ? ', data' : '';
    return db.prepare(`
        SELECT item_id AS id, name, stream_icon AS icon${dataColumn}
        FROM playlist_items
        WHERE source_id = ? AND type = 'epg_channel'
    `).all(sourceId);
}

function buildFallbackChannels(programmes) {
    return [...new Set(programmes.map(programme => programme.channelId))]
        .map(id => ({ id, name: id }));
}

function getNowPlaying(sourceIdValue, now = Date.now()) {
    const sourceId = normalizeSourceId(sourceIdValue);
    const db = getDb();
    const rows = db.prepare(NOW_PLAYING_SQL).all(
        sourceId,
        now - MAX_PROGRAMME_SPAN_MS,
        now,
        now
    );

    // Providers occasionally return overlapping entries. Keep one deterministic,
    // most-recently-started row per channel so the response remains bounded.
    const byChannel = new Map();
    for (const row of rows) {
        const existing = byChannel.get(row.channelId);
        if (!existing || row.start_time > existing.start_time) {
            byChannel.set(row.channelId, row);
        }
    }

    const programmes = [...byChannel.values()].map(row => ({
        channelId: row.channelId,
        start: row.start_time,
        stop: row.end_time,
        title: row.title
    }));
    const storedChannels = getStoredChannels(db, sourceId);

    return {
        channels: storedChannels.length > 0
            ? storedChannels
            : buildFallbackChannels(programmes),
        programmes
    };
}

function getFullGuide(sourceIdValue, now = Date.now()) {
    const sourceId = normalizeSourceId(sourceIdValue);
    const db = getDb();
    const windowStart = now - GUIDE_WINDOW_MS;
    const windowEnd = now + GUIDE_WINDOW_MS;
    const rows = db.prepare(FULL_GUIDE_SQL).all(
        sourceId,
        windowStart - MAX_PROGRAMME_SPAN_MS,
        windowEnd,
        windowStart
    );

    // Keep the established full-guide response contract: ISO timestamps and
    // descriptions remain available to the guide details view.
    const programmes = rows.map(row => ({
        channelId: row.channelId,
        start: new Date(row.start_time).toISOString(),
        stop: new Date(row.end_time).toISOString(),
        title: row.title,
        description: row.description
    }));
    const storedChannels = getStoredChannels(db, sourceId, { includeData: true });

    return {
        channels: storedChannels.length > 0
            ? storedChannels
            : buildFallbackChannels(programmes),
        programmes
    };
}

module.exports = {
    FULL_GUIDE_SQL,
    GUIDE_WINDOW_MS,
    MAX_PROGRAMME_SPAN_MS,
    NOW_PLAYING_SQL,
    getFullGuide,
    getNowPlaying,
    normalizeSourceId
};
