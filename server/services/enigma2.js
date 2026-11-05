'use strict';

const SERVICE_REFERENCE = /^[0-9a-f]{1,8}(?::[0-9a-f]{1,8}){9}:?$/i;
function invalid(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}
function parseZapDelay(value = 1500) {
    if (!['string', 'number'].includes(typeof value) || String(value).trim() === '' ||
        !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 10000) {
        throw invalid('Zap delay must be an integer from 0 to 10000 milliseconds');
    }
    return Number(value);
}
function parseZapOptions(body, type, create = false) {
    if (type !== 'm3u') {
        if (body.zapBeforeStreaming !== undefined || body.zapDelay !== undefined) throw invalid('Zap settings require an M3U source');
        return {};
    }
    const result = {};
    if (body.zapBeforeStreaming !== undefined && typeof body.zapBeforeStreaming !== 'boolean') throw invalid('Zap before streaming must be true or false');
    if (create || body.zapBeforeStreaming !== undefined) result.zapBeforeStreaming = body.zapBeforeStreaming ?? false;
    if (create || body.zapDelay !== undefined) result.zapDelay = parseZapDelay(body.zapDelay);
    return result;
}
function serviceReference(item) {
    let pathReference = '';
    try { pathReference = decodeURIComponent(new URL(item.stream_url).pathname.split('/').filter(Boolean).at(-1) || ''); }
    catch { /* Only a validated imported reference may be used. */ }
    if (SERVICE_REFERENCE.test(pathReference)) return pathReference;
    if (SERVICE_REFERENCE.test(String(item.stream_id))) return String(item.stream_id);
    throw invalid('Channel does not contain a valid Enigma2 service reference');
}
module.exports = { parseZapDelay, parseZapOptions, serviceReference };
