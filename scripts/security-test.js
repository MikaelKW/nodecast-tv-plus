const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { redactText, redactUrl, validateHttpUrl } = require('../server/services/urlSecurity');

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

console.log('Security tests passed.');
