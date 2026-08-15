const { getDb, catalogueRevisions } = require('../db/sqlite');

const SCHEMA_VERSION = 1;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAX_SEARCH_LENGTH = 200;
const UNCATEGORIZED_ID = '__uncategorized__';

function invalidRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function parseLimit(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_PAGE_SIZE;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
        throw invalidRequest(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    }
    return parsed;
}

function encodeCursor(row) {
    return Buffer.from(JSON.stringify({ name: row.name, itemId: row.item_id }))
        .toString('base64url');
}

function decodeCursor(value) {
    if (!value) return null;
    if (typeof value !== 'string' || value.length > 2048) {
        throw invalidRequest('Invalid catalogue cursor');
    }

    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (typeof parsed.name !== 'string' || typeof parsed.itemId !== 'string') {
            throw new Error('Invalid cursor shape');
        }
        return parsed;
    } catch {
        throw invalidRequest('Invalid catalogue cursor');
    }
}

function escapeLike(value) {
    return value.replace(/[\\%_]/g, character => `\\${character}`);
}

function parseData(value) {
    try {
        return JSON.parse(value || '{}');
    } catch {
        return {};
    }
}

function formatLiveChannel(row) {
    const data = parseData(row.data);
    return {
        ...data,
        stream_id: row.item_id,
        name: row.name,
        stream_icon: row.stream_icon,
        category_id: row.category_id,
        container_extension: row.container_extension,
        epg_channel_id: data.epg_channel_id || data.tvgId || null
    };
}

function getLiveSummary(sourceId) {
    const db = getDb();
    const revision = catalogueRevisions.get(sourceId);
    const rows = db.prepare(`
        SELECT
            CASE
                WHEN c.category_id IS NULL THEN '${UNCATEGORIZED_ID}'
                ELSE c.category_id
            END AS category_id,
            COALESCE(c.name, 'Uncategorized') AS category_name,
            COUNT(*) AS item_count
        FROM playlist_items p
        LEFT JOIN categories c
            ON c.source_id = p.source_id
           AND c.type = p.type
           AND c.category_id = p.category_id
        WHERE p.source_id = ?
          AND p.type = 'live'
          AND p.is_hidden = 0
          AND COALESCE(c.is_hidden, 0) = 0
        GROUP BY
            CASE
                WHEN c.category_id IS NULL THEN '${UNCATEGORIZED_ID}'
                ELSE c.category_id
            END,
            COALESCE(c.name, 'Uncategorized')
        ORDER BY category_name COLLATE NOCASE, category_id
    `).all(sourceId);

    return {
        schemaVersion: SCHEMA_VERSION,
        revision: revision.revision,
        updatedAt: revision.updated_at,
        sourceId,
        contentType: 'live',
        totalChannels: rows.reduce((total, row) => total + row.item_count, 0),
        groups: rows.map(row => ({
            id: String(row.category_id),
            name: row.category_name,
            count: row.item_count
        }))
    };
}

function getLiveChannelPage(sourceId, options = {}) {
    const db = getDb();
    const limit = parseLimit(options.limit);
    const cursor = decodeCursor(options.cursor);
    const categoryId = options.categoryId === undefined || options.categoryId === null
        ? null
        : String(options.categoryId);
    const query = options.query === undefined || options.query === null
        ? ''
        : String(options.query).trim();

    if (query.length > MAX_SEARCH_LENGTH) {
        throw invalidRequest(`query must contain at most ${MAX_SEARCH_LENGTH} characters`);
    }

    const where = [
        'p.source_id = ?',
        "p.type = 'live'",
        'p.is_hidden = 0',
        'COALESCE(c.is_hidden, 0) = 0'
    ];
    const params = [sourceId];

    if (categoryId === UNCATEGORIZED_ID) {
        where.push('c.category_id IS NULL');
    } else if (categoryId) {
        where.push('p.category_id = ?');
        params.push(categoryId);
    }

    if (query) {
        const pattern = `%${escapeLike(query)}%`;
        where.push("p.name LIKE ? ESCAPE '\\' COLLATE NOCASE");
        params.push(pattern);
    }

    if (cursor) {
        where.push(`(
            p.name COLLATE NOCASE > ? COLLATE NOCASE
            OR (p.name COLLATE NOCASE = ? COLLATE NOCASE AND p.item_id > ?)
        )`);
        params.push(cursor.name, cursor.name, cursor.itemId);
    }

    params.push(limit + 1);
    const rows = db.prepare(`
        SELECT
            p.item_id,
            p.name,
            p.category_id,
            p.stream_icon,
            p.container_extension,
            p.data
        FROM playlist_items p
        LEFT JOIN categories c
            ON c.source_id = p.source_id
           AND c.type = p.type
           AND c.category_id = p.category_id
        WHERE ${where.join('\n          AND ')}
        ORDER BY p.name COLLATE NOCASE, p.item_id
        LIMIT ?
    `).all(...params);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const revision = catalogueRevisions.get(sourceId);

    return {
        schemaVersion: SCHEMA_VERSION,
        revision: revision.revision,
        sourceId,
        contentType: 'live',
        categoryId,
        query,
        items: pageRows.map(formatLiveChannel),
        hasMore,
        nextCursor: hasMore ? encodeCursor(pageRows[pageRows.length - 1]) : null
    };
}

module.exports = {
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    UNCATEGORIZED_ID,
    getLiveSummary,
    getLiveChannelPage
};
