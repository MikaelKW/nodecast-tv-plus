/**
 * EPG (XMLTV) Parser (Streaming)
 * Parses XMLTV format EPG data and extracts channel/programme information using streaming XML parser
 */

const sax = require('sax');
const zlib = require('zlib');
const { Readable } = require('stream');

function createValidatedCalendarDate(year, month, day, hour, minute, second) {
    if (
        month < 1 || month > 12 ||
        day < 1 || day > 31 ||
        hour < 0 || hour > 23 ||
        minute < 0 || minute > 59 ||
        second < 0 || second > 59
    ) {
        return null;
    }

    // setUTCFullYear avoids Date.UTC's special handling of years 0-99.
    const calendarDate = new Date(0);
    calendarDate.setUTCFullYear(year, month - 1, day);
    calendarDate.setUTCHours(hour, minute, second, 0);

    // Date normalizes impossible calendar values (for example February 30),
    // so compare every component before accepting it.
    if (
        calendarDate.getUTCFullYear() !== year ||
        calendarDate.getUTCMonth() !== month - 1 ||
        calendarDate.getUTCDate() !== day ||
        calendarDate.getUTCHours() !== hour ||
        calendarDate.getUTCMinutes() !== minute ||
        calendarDate.getUTCSeconds() !== second
    ) {
        return null;
    }

    return calendarDate;
}

function parseTimezoneOffset(timezone) {
    if (!timezone || timezone.toUpperCase() === 'Z') return 0;

    const normalized = timezone.replace(':', '');
    const offsetHours = Number(normalized.slice(1, 3));
    const offsetRemainder = Number(normalized.slice(3, 5));
    if (offsetHours > 23 || offsetRemainder > 59) return null;

    const total = (offsetHours * 60) + offsetRemainder;
    return normalized[0] === '-' ? -total : total;
}

/**
 * Parse an XMLTV date/time. XMLTV permits YYYYMMDDHHmmss or a shorter
 * initial precision (for example YYYYMMDDHHmm, YYYYMMDDHH, or YYYYMMDD).
 * Missing components use the earliest value in that precision and UTC is
 * assumed when no numeric offset is provided.
 * @param {string} dateStr - XMLTV format date string
 * @returns {Date|null}
 */
function parseXmltvDate(dateStr) {
    if (!dateStr) return null;

    const value = String(dateStr).trim();
    const match = value.match(/^(\d{4}(?:\d{2}){0,5})\s*(Z|[+-]\d{4})?$/i);
    if (!match) {
        // Preserve the existing compatibility fallback for explicit ISO 8601
        // timestamps without accepting arbitrary host-dependent date strings.
        const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/i);
        if (!isoMatch) return null;

        const [, year, month, day, hour, minute, second = '0', timezone] = isoMatch;
        if (!createValidatedCalendarDate(
            Number(year),
            Number(month),
            Number(day),
            Number(hour),
            Number(minute),
            Number(second)
        ) || parseTimezoneOffset(timezone) === null) return null;

        const isoDate = new Date(value);
        return Number.isNaN(isoDate.getTime()) ? null : isoDate;
    }

    const digits = match[1];
    const timezone = match[2]?.toUpperCase();
    const year = Number(digits.slice(0, 4));
    const month = digits.length >= 6 ? Number(digits.slice(4, 6)) : 1;
    const day = digits.length >= 8 ? Number(digits.slice(6, 8)) : 1;
    const hour = digits.length >= 10 ? Number(digits.slice(8, 10)) : 0;
    const minute = digits.length >= 12 ? Number(digits.slice(10, 12)) : 0;
    const second = digits.length >= 14 ? Number(digits.slice(12, 14)) : 0;

    const calendarDate = createValidatedCalendarDate(year, month, day, hour, minute, second);
    const offsetMinutes = parseTimezoneOffset(timezone);
    if (!calendarDate || offsetMinutes === null) return null;

    return new Date(calendarDate.getTime() - (offsetMinutes * 60 * 1000));
}

/**
 * Parse XMLTV content (Stream or String)
 * @param {Readable|string} input - XMLTV content as Stream or String
 * @returns {Promise<{ channels: Array, programmes: Array }>}
 */
function parse(input) {
    return new Promise((resolve, reject) => {
        const channels = [];
        const programmes = [];

        const saxStream = sax.createStream(true, { trim: true, normalize: true }); // strict mode

        let currentTag = null;
        let currentObject = null;
        let textBuffer = '';
        let currentProgrammeHasValidTimestamps = true;
        let skippedProgrammes = 0;

        saxStream.on('error', function (e) {
            // clear the error
            this._parser.error = null;
            this._parser.resume();
            console.warn('XML Parse Warning:', e.message);
        });

        saxStream.on('opentag', function (node) {
            currentTag = node.name;
            const attr = node.attributes;

            if (currentTag === 'channel') {
                currentObject = {
                    id: attr.id,
                    name: null, // Will be populated by display-name tag
                    icon: null,
                    url: null
                };
            } else if (currentTag === 'programme') {
                const start = parseXmltvDate(attr.start);
                const stop = parseXmltvDate(attr.stop);
                currentProgrammeHasValidTimestamps = Boolean(start) && (!attr.stop || Boolean(stop));
                currentObject = {
                    channelId: attr.channel,
                    start,
                    stop,
                    title: null,
                    subtitle: null,
                    description: null,
                    category: [],
                    icon: null,
                    date: null,
                    episodeNum: null
                };
            } else if (currentTag === 'icon') {
                if (currentObject) {
                    currentObject.icon = attr.src;
                }
            }
            textBuffer = '';
        });

        saxStream.on('text', function (text) {
            textBuffer += text;
        });

        saxStream.on('cdata', function (text) {
            textBuffer += text;
        });

        saxStream.on('closetag', function (tagName) {
            if (tagName === 'channel') {
                if (currentObject) channels.push(currentObject);
                currentObject = null;
            } else if (tagName === 'programme') {
                if (currentObject && currentProgrammeHasValidTimestamps) {
                    programmes.push(currentObject);
                } else if (currentObject) {
                    skippedProgrammes++;
                }
                currentObject = null;
            } else if (currentObject) {
                // Handle properties within objects
                switch (tagName) {
                    case 'display-name': // channel name
                        if (!currentObject.name) currentObject.name = textBuffer;
                        break;
                    case 'url': // channel url
                        currentObject.url = textBuffer;
                        break;
                    case 'title':
                        currentObject.title = textBuffer;
                        break;
                    case 'sub-title':
                        currentObject.subtitle = textBuffer;
                        break;
                    case 'desc':
                        currentObject.description = textBuffer;
                        break;
                    case 'category':
                        if (textBuffer && currentObject.category) currentObject.category.push(textBuffer);
                        break;
                    case 'date':
                        currentObject.date = textBuffer;
                        break;
                    case 'episode-num':
                        // Prefer system "xmltv_ns" or just take text
                        // Complex episode parsing logic can go here if needed
                        currentObject.episodeNum = textBuffer;
                        break;
                }
            }
        });

        saxStream.on('end', function () {
            resolve({ channels, programmes, skippedProgrammes });
        });

        // Handle input type
        if (typeof input === 'string') {
            const inputStream = Readable.from([input]);
            inputStream.pipe(saxStream);
        } else {
            input.pipe(saxStream);
        }
    });
}

/**
 * Get programmes for a specific channel
 */
function getProgrammesForChannel(programmes, channelId) {
    return programmes.filter(p => p.channelId === channelId);
}

/**
 * Get current and upcoming programmes for a channel
 */
function getCurrentAndUpcoming(programmes, channelId, count = 5) {
    const now = new Date();
    const channelProgrammes = getProgrammesForChannel(programmes, channelId);

    // Sort by start time
    channelProgrammes.sort((a, b) => a.start - b.start);

    // Find current and upcoming
    const current = channelProgrammes.find(p => p.start <= now && p.stop > now);
    const upcoming = channelProgrammes
        .filter(p => p.start > now)
        .slice(0, count);

    return { current, upcoming };
}

/**
 * Fetch and parse XMLTV from URL
 */
async function fetchAndParse(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch EPG: ${response.status} ${response.statusText}`);
    }

    let stream;
    if (response.body && typeof response.body.pipe === 'function') {
        stream = response.body;
    } else if (response.body) {
        stream = Readable.fromWeb(response.body);
    } else {
        stream = Readable.from([]);
    }

    // Check for GZIP
    // Note: We can't easily check for magic bytes on a stream without buffering.
    // We'll rely on response headers or file extension mostly, or try to peek.
    // For now, let's assume if content-encoding is gzip OR url ends in .gz

    // However, undici/fetch usually handles 'Content-Encoding: gzip' automatically transparently.
    // We only need to manually gunzip if the server serves it as application/octet-stream but it's actually gzipped, 
    // or if it's a .gz file download.

    // A robust way for streams is checking magic bytes, but that requires peeking.
    // Simplified approach: try to pipe through gunzip if the URL indicates it.

    const isGzipped = url.endsWith('.gz') || (response.headers.get('content-type') || '').includes('gzip');

    if (isGzipped) {
        const gunzip = zlib.createGunzip();
        stream.pipe(gunzip);
        return parse(gunzip);
    }

    // In the previous version we read magic bytes. 
    // To support that with streams we'd need a peek stream.
    // For now let's trust the transparent decompression of fetch or the URL.

    return parse(stream);
}

/**
 * Streaming EPG parser that yields batches of programmes (memory-efficient)
 * Channels are collected and returned with the first batch, then programmes are yielded in batches.
 * 
 * @param {string} url - XMLTV URL
 * @param {number} batchSize - Number of programmes per batch (default: 1000)
 * @yields {{ channels: Array|null, programmes: Array, isLast: boolean }}
 */
async function* fetchAndParseStreaming(url, batchSize = 1000) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch EPG: ${response.status} ${response.statusText}`);
    }

    let stream;
    if (response.body && typeof response.body.pipe === 'function') {
        stream = response.body;
    } else if (response.body) {
        stream = Readable.fromWeb(response.body);
    } else {
        stream = Readable.from([]);
    }

    const isGzipped = url.endsWith('.gz') || (response.headers.get('content-type') || '').includes('gzip');

    if (isGzipped) {
        const gunzip = zlib.createGunzip();
        stream.pipe(gunzip);
        stream = gunzip;
    }

    // Use async iterator pattern with SAX
    yield* parseStreaming(stream, batchSize);
}

/**
 * Parse XMLTV as streaming async generator
 * @param {Readable} input - XMLTV stream
 * @param {number} batchSize - Number of programmes per batch
 * @yields {{ channels: Array|null, programmes: Array, isLast: boolean }}
 */
async function* parseStreaming(input, batchSize = 1000) {
    const channels = [];
    let programmeBatch = [];
    let channelsYielded = false;

    // We need to convert SAX events to an async iterator
    // This requires collecting events and yielding when batch is full

    const saxStream = sax.createStream(true, { trim: true, normalize: true });

    let currentTag = null;
    let currentObject = null;
    let textBuffer = '';
    let resolveNext = null;
    let pendingBatch = null;
    let ended = false;
    let error = null;
    let currentProgrammeHasValidTimestamps = true;
    let skippedProgrammes = 0;

    saxStream.on('error', function (e) {
        this._parser.error = null;
        this._parser.resume();
        console.warn('XML Parse Warning:', e.message);
    });

    saxStream.on('opentag', function (node) {
        currentTag = node.name;
        const attr = node.attributes;

        if (currentTag === 'channel') {
            currentObject = {
                id: attr.id,
                name: null,
                icon: null,
                url: null
            };
        } else if (currentTag === 'programme') {
            const start = parseXmltvDate(attr.start);
            const stop = parseXmltvDate(attr.stop);
            currentProgrammeHasValidTimestamps = Boolean(start) && (!attr.stop || Boolean(stop));
            currentObject = {
                channelId: attr.channel,
                start,
                stop,
                title: null,
                subtitle: null,
                description: null,
                category: [],
                icon: null,
                date: null,
                episodeNum: null
            };
        } else if (currentTag === 'icon') {
            if (currentObject) {
                currentObject.icon = attr.src;
            }
        }
        textBuffer = '';
    });

    saxStream.on('text', function (text) {
        textBuffer += text;
    });

    saxStream.on('cdata', function (text) {
        textBuffer += text;
    });

    saxStream.on('closetag', function (tagName) {
        if (tagName === 'channel') {
            if (currentObject) channels.push(currentObject);
            currentObject = null;
        } else if (tagName === 'programme') {
            if (currentObject && currentProgrammeHasValidTimestamps) {
                programmeBatch.push(currentObject);

                // Check if we should yield a batch
                if (programmeBatch.length >= batchSize) {
                    const batch = {
                        channels: !channelsYielded ? channels : null,
                        programmes: programmeBatch,
                        skippedProgrammes,
                        isLast: false
                    };
                    channelsYielded = true;
                    programmeBatch = [];
                    skippedProgrammes = 0;

                    if (resolveNext) {
                        resolveNext(batch);
                        resolveNext = null;
                    } else {
                        pendingBatch = batch;
                    }
                }
            } else if (currentObject) {
                skippedProgrammes++;
            }
            currentObject = null;
        } else if (currentObject) {
            switch (tagName) {
                case 'display-name':
                    if (!currentObject.name) currentObject.name = textBuffer;
                    break;
                case 'url':
                    currentObject.url = textBuffer;
                    break;
                case 'title':
                    currentObject.title = textBuffer;
                    break;
                case 'sub-title':
                    currentObject.subtitle = textBuffer;
                    break;
                case 'desc':
                    currentObject.description = textBuffer;
                    break;
                case 'category':
                    if (textBuffer && currentObject.category) currentObject.category.push(textBuffer);
                    break;
                case 'date':
                    currentObject.date = textBuffer;
                    break;
                case 'episode-num':
                    currentObject.episodeNum = textBuffer;
                    break;
            }
        }
    });

    saxStream.on('end', function () {
        ended = true;
        // Yield final batch
        const batch = {
            channels: !channelsYielded ? channels : null,
            programmes: programmeBatch,
            skippedProgrammes,
            isLast: true
        };
        if (resolveNext) {
            resolveNext(batch);
            resolveNext = null;
        } else {
            pendingBatch = batch;
        }
    });

    saxStream.on('error', function (e) {
        error = e;
        if (resolveNext) {
            resolveNext(null);
        }
    });

    // Start piping
    input.pipe(saxStream);

    // Yield batches as they become available
    while (!ended || pendingBatch) {
        if (pendingBatch) {
            const batch = pendingBatch;
            pendingBatch = null;
            yield batch;
            if (batch.isLast) break;
        } else if (!ended) {
            // Wait for next batch
            const batch = await new Promise(resolve => {
                resolveNext = resolve;
            });
            if (batch) {
                yield batch;
                if (batch.isLast) break;
            }
        }
    }

    if (error) {
        throw error;
    }
}

module.exports = {
    parse,
    parseXmltvDate,
    fetchAndParse,
    fetchAndParseStreaming,
    parseStreaming,
    getProgrammesForChannel,
    getCurrentAndUpcoming
};

