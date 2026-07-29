/**
 * File-based Cache Service
 * Stores cached data as JSON files in data/cache/
 */

const fs = require('fs');
const path = require('path');

// Cache directory
const cacheDir = path.resolve(__dirname, '..', '..', 'data', 'cache');
const CACHE_TYPES = new Set(['epg', 'm3u', 'xtream']);

function validateType(type) {
    if (!CACHE_TYPES.has(type)) {
        throw new Error('Invalid cache type');
    }
    return type;
}

function validateSourceId(sourceId) {
    const normalized = String(sourceId);
    if (!/^[1-9]\d*$/.test(normalized)) {
        throw new Error('Invalid cache source ID');
    }
    return normalized;
}

function containedPath(...parts) {
    const resolved = path.resolve(cacheDir, ...parts);
    if (resolved !== cacheDir && !resolved.startsWith(`${cacheDir}${path.sep}`)) {
        throw new Error('Invalid cache path');
    }
    return resolved;
}

// Ensure cache directories exist
function ensureCacheDir(type, sourceId) {
    const dir = containedPath(validateType(type), validateSourceId(sourceId));
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// Get cache file path
function getCachePath(type, sourceId, key) {
    const dir = ensureCacheDir(type, sourceId);
    // Sanitize key for filename
    const safeKey = String(key || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dir, `${safeKey}.json`);
}

/**
 * Get cached data if not expired
 * @param {string} type - Cache type (epg, m3u, xtream)
 * @param {number|string} sourceId - Source ID
 * @param {string} key - Cache key (e.g., action name)
 * @param {number} maxAgeMs - Maximum age in milliseconds
 * @returns {any|null} - Cached data or null if expired/missing
 */
function get(type, sourceId, key, maxAgeMs) {
    try {
        const cachePath = getCachePath(type, sourceId, key);

        if (!fs.existsSync(cachePath)) {
            return null;
        }

        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        const age = Date.now() - cached.timestamp;

        if (age > maxAgeMs) {
            return null; // Expired
        }

        return cached.data;
    } catch (err) {
        console.warn('Cache read failed:', err.message);
        return null;
    }
}

/**
 * Store data in cache
 * @param {string} type - Cache type
 * @param {number|string} sourceId - Source ID
 * @param {string} key - Cache key
 * @param {any} data - Data to cache
 */
function set(type, sourceId, key, data) {
    try {
        const cachePath = getCachePath(type, sourceId, key);
        const cached = {
            timestamp: Date.now(),
            data: data
        };
        fs.writeFileSync(cachePath, JSON.stringify(cached));
    } catch (err) {
        console.error('Cache write failed:', err.message);
    }
}

/**
 * Clear specific cache entry
 */
function clear(type, sourceId, key) {
    try {
        const cachePath = getCachePath(type, sourceId, key);
        if (fs.existsSync(cachePath)) {
            fs.unlinkSync(cachePath);
        }
    } catch (err) {
        console.warn(`Cache clear error:`, err.message);
    }
}

/**
 * Clear all cache for a source
 */
function clearSource(sourceId) {
    const safeSourceId = validateSourceId(sourceId);
    try {
        const types = ['epg', 'm3u', 'xtream'];
        for (const type of types) {
            const dir = containedPath(type, safeSourceId);
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true });
            }
        }
    } catch (err) {
        console.warn(`Cache clear source error:`, err.message);
    }
}

/**
 * Clear all cache
 */
function clearAll() {
    try {
        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true });
        }
    } catch (err) {
        console.warn(`Cache clear all error:`, err.message);
    }
}

/**
 * Get cache info for debugging
 */
function getInfo(type, sourceId, key) {
    try {
        const cachePath = getCachePath(type, sourceId, key);
        if (!fs.existsSync(cachePath)) {
            return null;
        }
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        const stats = fs.statSync(cachePath);
        return {
            timestamp: cached.timestamp,
            age: Date.now() - cached.timestamp,
            size: stats.size
        };
    } catch (err) {
        return null;
    }
}

module.exports = {
    get,
    set,
    clear,
    clearSource,
    clearAll,
    getInfo,
    validateSourceId
};
