'use strict';

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const zlib = require('node:zlib');
const { validateHttpUrl } = require('./urlSecurity');

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function securityError(message) {
    const error = new Error(message);
    error.statusCode = 403;
    return error;
}

function normalizedHost(value) {
    try {
        return new URL(validateHttpUrl(value)).host.toLowerCase();
    } catch {
        return String(value || '').trim().toLowerCase();
    }
}

function ipv4Number(address) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
        return null;
    }
    return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inIpv4Range(value, base, prefix) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (base & mask);
}

function classifyIpv4(address) {
    const value = ipv4Number(address);
    if (value === null) return 'protected';

    const ranges = [
        ['0.0.0.0', 8, 'protected'],
        ['10.0.0.0', 8, 'private'],
        ['100.64.0.0', 10, 'private'],
        ['127.0.0.0', 8, 'loopback'],
        ['169.254.0.0', 16, 'protected'],
        ['172.16.0.0', 12, 'private'],
        ['192.0.0.0', 24, 'protected'],
        ['192.0.2.0', 24, 'protected'],
        ['192.168.0.0', 16, 'private'],
        ['198.18.0.0', 15, 'private'],
        ['198.51.100.0', 24, 'protected'],
        ['203.0.113.0', 24, 'protected'],
        ['224.0.0.0', 4, 'protected'],
        ['240.0.0.0', 4, 'protected']
    ];

    for (const [baseAddress, prefix, classification] of ranges) {
        if (inIpv4Range(value, ipv4Number(baseAddress), prefix)) return classification;
    }
    return 'public';
}

function mappedIpv4(address) {
    const lower = address.toLowerCase();
    if (!lower.startsWith('::ffff:')) return null;
    const suffix = lower.slice('::ffff:'.length);
    if (net.isIPv4(suffix)) return suffix;
    const groups = suffix.split(':');
    if (groups.length !== 2 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    const high = parseInt(groups[0], 16);
    const low = parseInt(groups[1], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function classifyIp(address) {
    if (net.isIPv4(address)) return classifyIpv4(address);
    if (!net.isIPv6(address)) return 'protected';

    const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
    const mapped = mappedIpv4(lower);
    if (mapped) return classifyIpv4(mapped);
    if (lower === '::' || lower === '::1') return 'loopback';
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return 'protected';
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return 'private';
    if (lower.startsWith('ff')) return 'protected';
    if (lower.startsWith('2001:db8:') || lower.startsWith('2001:2:')) return 'protected';
    return 'public';
}

function isExplicitlyAllowed(parsed, allowPrivateHosts) {
    const allowed = new Set((allowPrivateHosts || []).map(normalizedHost).filter(Boolean));
    return allowed.has(parsed.host.toLowerCase());
}

async function resolveSafeOutboundTarget(value, {
    fieldName = 'URL',
    allowPrivateHosts = []
} = {}) {
    let validated;
    try {
        validated = validateHttpUrl(value, fieldName);
    } catch (error) {
        if (/protected local or metadata address/i.test(error.message)) {
            throw securityError(`${fieldName} points to a protected network destination`);
        }
        throw error;
    }
    const parsed = new URL(validated);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    const allowPrivate = isExplicitlyAllowed(parsed, allowPrivateHosts);
    const allowLoopback = process.env.ALLOW_LOCAL_MEDIA_URLS === 'true' && allowPrivate;

    if (hostname === 'metadata.google.internal') {
        throw securityError(`${fieldName} points to a protected network destination`);
    }
    if (hostname === 'fd00:ec2::254') {
        throw securityError(`${fieldName} points to a protected network destination`);
    }

    let addresses;
    if (net.isIP(hostname)) {
        addresses = [{ address: hostname, family: net.isIP(hostname) }];
    } else {
        try {
            addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        } catch {
            const error = new Error(`${fieldName} host could not be resolved`);
            error.statusCode = 502;
            throw error;
        }
    }

    if (!addresses.length) {
        const error = new Error(`${fieldName} host could not be resolved`);
        error.statusCode = 502;
        throw error;
    }

    for (const { address } of addresses) {
        const classification = classifyIp(address);
        if (classification === 'public') continue;
        if (classification === 'private' && allowPrivate) continue;
        if (classification === 'loopback' && allowLoopback) continue;
        throw securityError(`${fieldName} points to a protected network destination`);
    }

    return {
        address: addresses[0].address,
        family: addresses[0].family || net.isIP(addresses[0].address),
        parsed,
        url: parsed.toString()
    };
}

async function assertSafeOutboundUrl(value, policy = {}) {
    return (await resolveSafeOutboundTarget(value, policy)).url;
}

function responseHeaders(headers) {
    return {
        get(name) {
            const value = headers[String(name).toLowerCase()];
            if (Array.isArray(value)) return value.join(', ');
            return value === undefined ? null : String(value);
        }
    };
}

function performPinnedRequest(target, options = {}) {
    return new Promise((resolve, reject) => {
        const transport = target.parsed.protocol === 'https:' ? https : http;
        const request = transport.request(target.parsed, {
            method: options.method || 'GET',
            headers: options.headers,
            signal: options.signal,
            family: target.family,
            lookup(_hostname, _options, callback) {
                callback(null, target.address, target.family);
            }
        }, response => {
            const rawHeaders = { ...response.headers };
            const encoding = String(rawHeaders['content-encoding'] || '').toLowerCase();
            let body = response;
            if (encoding === 'gzip') body = response.pipe(zlib.createGunzip());
            else if (encoding === 'deflate') body = response.pipe(zlib.createInflate());
            else if (encoding === 'br') body = response.pipe(zlib.createBrotliDecompress());
            if (body !== response) {
                delete rawHeaders['content-encoding'];
                delete rawHeaders['content-length'];
            }
            body.cancel = async () => {
                body.destroy();
                response.destroy();
            };
            const headers = responseHeaders(rawHeaders);
            const status = response.statusCode || 0;
            resolve({
                body,
                headers,
                ok: status >= 200 && status < 300,
                status,
                statusText: http.STATUS_CODES[status] || '',
                url: target.url,
                async text() {
                    const chunks = [];
                    for await (const chunk of body) chunks.push(Buffer.from(chunk));
                    return Buffer.concat(chunks).toString('utf8');
                },
                async json() {
                    return JSON.parse(await this.text());
                }
            });
        });
        request.once('error', reject);
        if (options.body !== undefined && options.body !== null) request.write(options.body);
        request.end();
    });
}

async function fetchWithPolicy(value, options = {}, policy = {}) {
    let currentUrl = value;
    let currentOptions = { ...options, redirect: 'manual' };

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
        const target = await resolveSafeOutboundTarget(currentUrl, policy);
        const response = await performPinnedRequest(target, currentOptions);
        if (!REDIRECT_STATUSES.has(response.status)) return response;

        const location = response.headers.get('location');
        if (!location) return response;
        if (redirectCount === MAX_REDIRECTS) {
            await response.body?.cancel();
            throw securityError('Outbound request exceeded the redirect limit');
        }

        currentUrl = new URL(location, target.url).toString();
        await response.body?.cancel();
        if (response.status === 303) {
            currentOptions = { ...currentOptions, method: 'GET', body: undefined };
        }
    }

    throw securityError('Outbound request exceeded the redirect limit');
}

module.exports = {
    assertSafeOutboundUrl,
    classifyIp,
    fetchWithPolicy
};
