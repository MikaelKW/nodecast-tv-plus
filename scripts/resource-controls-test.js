'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function waitForServer(baseUrl, child, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited before becoming ready (code ${child.exitCode}).`);
        }
        try {
            const response = await fetch(`${baseUrl}/api/version`);
            if (response.ok) return;
        } catch {
            // Startup is still in progress.
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Server did not become ready in time.');
}

async function stopServer(child) {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

async function run() {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-resource-controls-'));
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let output = '';
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            NODECAST_DATA_DIR: dataDirectory,
            NODECAST_CACHE_DIR: path.join(dataDirectory, 'cache'),
            NODECAST_DISABLE_BACKGROUND_JOBS: 'true',
            PORT: String(port),
            JWT_SECRET: crypto.randomBytes(48).toString('hex'),
            SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
            OIDC_ISSUER_URL: '',
            OIDC_CLIENT_ID: '',
            OIDC_CLIENT_SECRET: '',
            DISABLE_LOCAL_AUTH: '',
            OIDC_AUTO_REDIRECT: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });

    try {
        await waitForServer(baseUrl, child);
        const password = crypto.randomBytes(24).toString('base64url');
        const setup = await fetch(`${baseUrl}/api/auth/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'resource-controls-admin',
                password,
                passwordConfirmation: password
            })
        });
        assert.equal(setup.status, 201);
        const cookie = (setup.headers.get('set-cookie') || '').split(';', 1)[0];
        assert.ok(cookie);
        const headers = { Cookie: cookie, 'Content-Type': 'application/json' };

        for (const limit of ['-1', '0', '101', '1.5', 'unbounded']) {
            const history = await fetch(`${baseUrl}/api/history?limit=${limit}`, { headers });
            assert.equal(history.status, 400, `Unsafe history limit accepted: ${limit}`);
            const recent = await fetch(`${baseUrl}/api/channels/recent?type=movie&limit=${limit}`, { headers });
            assert.equal(recent.status, 400, `Unsafe recent-content limit accepted: ${limit}`);
        }

        const validHistory = await fetch(`${baseUrl}/api/history`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                id: 'controlled-movie',
                type: 'movie',
                sourceId: 1,
                progress: 12,
                duration: 120,
                data: { title: 'Controlled movie' }
            })
        });
        assert.equal(validHistory.status, 200);

        const history = await fetch(`${baseUrl}/api/history?limit=1`, { headers });
        assert.equal(history.status, 200);
        const historyItems = await history.json();
        assert.equal(historyItems.length, 1);
        assert.equal(historyItems[0].item_id, 'controlled-movie');

        const invalidType = await fetch(`${baseUrl}/api/history`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ id: 'channel-1', type: 'channel' })
        });
        assert.equal(invalidType.status, 400);

        const oversizedMetadata = await fetch(`${baseUrl}/api/history`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                id: 'oversized',
                type: 'movie',
                data: { value: 'x'.repeat(33 * 1024) }
            })
        });
        assert.equal(oversizedMetadata.status, 400);

        console.log('Resource-control regression tests passed.');
    } catch (error) {
        console.error(output);
        throw error;
    } finally {
        await stopServer(child);
        await fs.rm(dataDirectory, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
