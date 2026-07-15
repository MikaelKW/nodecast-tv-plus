const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { redactText, redactUrl, validateHttpUrl } = require('../server/services/urlSecurity');
const { normalizeBasePath, withBasePath } = require('../server/config/basePath');

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

console.log('Security tests passed.');
