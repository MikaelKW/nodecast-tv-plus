const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { redactText, redactUrl, validateHttpUrl } = require('../server/services/urlSecurity');
const { normalizeBasePath, withBasePath } = require('../server/config/basePath');
const cache = require('../server/services/cache');
const { classifyIp } = require('../server/services/outboundSecurity');
const { DEFAULT_PROXY_TRUST, configuredProxyTrust } = require('../server/config/proxyTrust');
const { ConcurrencyLimiter } = require('../server/services/concurrencyLimiter');
const { signMediaUrl, verifyMediaSignature } = require('../server/services/mediaAccess');
const {
    parseBoundedInteger,
    SlidingWindowLimiter,
    SingleFlight
} = require('../server/services/requestControls');
const {
    MAX_HISTORY_METADATA_BYTES,
    normalizeHistoryPayload
} = require('../server/services/historyPolicy');

assert.equal(validateHttpUrl('https://example.com/live.m3u8?token=secret'), 'https://example.com/live.m3u8?token=secret');
assert.equal(validateHttpUrl(' http://192.168.1.20:8080/stream '), 'http://192.168.1.20:8080/stream');

for (const unsafeUrl of [
    'file:///etc/passwd',
    'concat:https://example.com/a|https://example.com/b',
    'data:text/plain,secret',
    'pipe:0',
    '/var/lib/nodecast/file.ts',
    'http://127.0.0.1/private',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'https://example.com/stream\nInjected-Header: value'
]) {
    assert.throws(() => validateHttpUrl(unsafeUrl), /HTTP|HTTPS|invalid|protected/i);
}

assert.equal(
    redactUrl('https://user:password@example.com:8443/private/path?token=secret'),
    'https://example.com:8443/…'
);
assert.equal(redactUrl('file:///private/file'), '[unsupported URL]');
assert.equal(
    redactText('Request failed for https://user:password@example.com/live?token=secret'),
    'Request failed for [redacted URL]'
);

const projectRoot = path.join(__dirname, '..');
const missingSecrets = spawnSync(process.execPath, ['-e', "require('./server/config/security')"], {
    cwd: projectRoot,
    env: {
        ...process.env,
        NODE_ENV: 'production',
        JWT_SECRET: '',
        SESSION_SECRET: ''
    },
    encoding: 'utf8'
});

assert.notEqual(missingSecrets.status, 0, 'Production startup must fail without secrets.');
assert.match(missingSecrets.stderr, /JWT_SECRET must be set/);

const validProductionSecrets = {
    ...process.env,
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(64),
    SESSION_SECRET: 'b'.repeat(64)
};
const optionalTotpKey = spawnSync(process.execPath, ['-e', "require('./server/config/security')"], {
    cwd: projectRoot,
    env: { ...validProductionSecrets, TOTP_ENCRYPTION_KEY: '' },
    encoding: 'utf8'
});
assert.equal(optionalTotpKey.status, 0, 'Existing deployments must start without enabling TOTP.');

const invalidTotpKey = spawnSync(process.execPath, ['-e', "require('./server/config/security')"], {
    cwd: projectRoot,
    env: { ...validProductionSecrets, TOTP_ENCRYPTION_KEY: 'short' },
    encoding: 'utf8'
});
assert.notEqual(invalidTotpKey.status, 0, 'An unsafe configured TOTP key must fail startup.');
assert.match(invalidTotpKey.stderr, /TOTP_ENCRYPTION_KEY must be a unique value/);

assert.equal(normalizeBasePath('nodecast/'), '/nodecast');
assert.equal(normalizeBasePath('/media/nodecast'), '/media/nodecast');
assert.equal(withBasePath('/api/version', '/nodecast'), '/nodecast/api/version');
for (const unsafeBasePath of ['//example.com', '/nodecast?next=/', '/nodecast#fragment', '/../admin', '/node cast']) {
    assert.equal(normalizeBasePath(unsafeBasePath), '', `Unsafe base path accepted: ${unsafeBasePath}`);
}
assert.equal(normalizeBasePath(`/${'a'.repeat(2048)}`), '');

assert.equal(cache.validateSourceId(1), '1');
assert.equal(cache.validateSourceId('42'), '42');
for (const unsafeSourceId of ['../..', '1/../../', '0', '-1', '1.5', 'source']) {
    assert.throws(() => cache.validateSourceId(unsafeSourceId), /Invalid cache source ID/);
}

assert.equal(classifyIp('8.8.8.8'), 'public');
assert.equal(classifyIp('10.0.0.1'), 'private');
assert.equal(classifyIp('127.0.0.1'), 'loopback');
assert.equal(classifyIp('169.254.169.254'), 'protected');
assert.equal(classifyIp('::ffff:169.254.169.254'), 'protected');
assert.equal(classifyIp('fd00::1'), 'private');

const signatureTestTime = 1_700_000_000_000;
const signedMedia = signMediaUrl('https://media.example.com/segment.ts', signatureTestTime);
assert.equal(
    verifyMediaSignature(
        'https://media.example.com/segment.ts',
        signedMedia.token,
        signedMedia.expiresAt,
        signatureTestTime + 1
    ),
    true
);
assert.equal(
    verifyMediaSignature(
        'https://media.example.com/different.ts',
        signedMedia.token,
        signedMedia.expiresAt,
        signatureTestTime + 1
    ),
    false
);

assert.equal(configuredProxyTrust(''), DEFAULT_PROXY_TRUST);
assert.equal(configuredProxyTrust('false'), false);
assert.equal(configuredProxyTrust('1'), 1);
assert.equal(configuredProxyTrust('true'), DEFAULT_PROXY_TRUST);
assert.throws(() => configuredProxyTrust('100'), /between 0 and 10/);

const concurrency = new ConcurrencyLimiter({ globalLimit: 2, perIdentityLimit: 1 });
const releaseFirst = concurrency.acquire('first');
assert.equal(typeof releaseFirst, 'function');
assert.equal(concurrency.acquire('first'), null);
const releaseSecond = concurrency.acquire('second');
assert.equal(typeof releaseSecond, 'function');
assert.equal(concurrency.acquire('third'), null);
releaseFirst();
releaseSecond();
assert.equal(typeof concurrency.acquire('third'), 'function');

assert.equal(parseBoundedInteger(undefined, {
    defaultValue: 12,
    min: 1,
    max: 100
}), 12);
assert.equal(parseBoundedInteger('100', {
    defaultValue: 12,
    min: 1,
    max: 100
}), 100);
for (const unsafeLimit of ['-1', '0', '101', '1.5', 'unbounded']) {
    assert.throws(() => parseBoundedInteger(unsafeLimit, {
        name: 'limit',
        defaultValue: 12,
        min: 1,
        max: 100
    }), /limit must be an integer between 1 and 100/);
}

const normalizedHistory = normalizeHistoryPayload({
    id: 'movie-1',
    type: 'movie',
    sourceId: 1,
    progress: 12.9,
    duration: 120,
    data: { title: 'Controlled history item' }
});
assert.equal(normalizedHistory.progress, 12);
assert.equal(normalizedHistory.itemType, 'movie');
assert.throws(
    () => normalizeHistoryPayload({ id: 'movie-1', type: 'channel' }),
    /type must be movie or episode/
);
assert.throws(
    () => normalizeHistoryPayload({
        id: 'movie-1',
        type: 'movie',
        data: { oversized: 'x'.repeat(MAX_HISTORY_METADATA_BYTES) }
    }),
    /data must not exceed/
);

const requestLimiter = new SlidingWindowLimiter({ limit: 2, windowMs: 1000 });
assert.equal(requestLimiter.consume('viewer', 1000).allowed, true);
assert.equal(requestLimiter.consume('viewer', 1001).allowed, true);
assert.equal(requestLimiter.consume('viewer', 1002).allowed, false);
assert.equal(requestLimiter.consume('viewer', 2001).allowed, true);

const singleFlight = new SingleFlight();
let upstreamCalls = 0;
let releaseUpstream;
const blockedUpstream = new Promise(resolve => { releaseUpstream = resolve; });
const firstFlight = singleFlight.run('same-provider-request', async () => {
    upstreamCalls += 1;
    await blockedUpstream;
    return { authenticated: true };
});
const secondFlight = singleFlight.run('same-provider-request', async () => {
    upstreamCalls += 1;
    return { authenticated: false };
});
assert.equal(firstFlight, secondFlight);
releaseUpstream();
Promise.all([firstFlight, secondFlight]).then(results => {
    assert.equal(upstreamCalls, 1);
    assert.deepEqual(results, [{ authenticated: true }, { authenticated: true }]);
    console.log('Security tests passed.');
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
