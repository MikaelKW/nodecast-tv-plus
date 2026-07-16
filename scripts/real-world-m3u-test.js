const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const playlistUrl = process.env.M3U_TEST_URL || 'https://iptv-org.github.io/iptv/categories/sports.m3u';
const testRoot = path.join(projectRoot, '.test-data', `real-world-${process.pid}`);

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

async function waitForServer(baseUrl, child) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Application exited with code ${child.exitCode}`);
        try {
            const response = await fetch(`${baseUrl}/api/version`);
            if (response.ok) return;
        } catch { /* Server is still starting. */ }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Application did not start within 30 seconds');
}

async function stopServer(child) {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5_000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

async function request(baseUrl, route, options = {}, cookie = '') {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(`${baseUrl}${route}`, { ...options, headers });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${route} returned ${response.status}: ${body?.error || 'unknown error'}`);
    return { response, body };
}

async function run() {
    const relative = path.relative(projectRoot, testRoot);
    assert(relative.startsWith('.test-data') && !relative.startsWith('..'), 'Unsafe test directory');
    await fs.mkdir(path.join(testRoot, 'data'), { recursive: true });

    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let output = '';
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(port),
            JWT_SECRET: crypto.randomBytes(48).toString('hex'),
            SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
            NODECAST_DATA_DIR: path.join(testRoot, 'data'),
            NODECAST_CACHE_DIR: path.join(testRoot, 'cache'),
            NODECAST_DISABLE_BACKGROUND_JOBS: 'true'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });

    try {
        await waitForServer(baseUrl, child);
        const password = crypto.randomBytes(24).toString('base64url');
        const setup = await request(baseUrl, '/api/auth/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'real-world-test-admin',
                password,
                passwordConfirmation: password
            })
        });
        const cookie = setup.response.headers.get('set-cookie')?.split(';')[0];
        assert(cookie, 'Setup did not return an authentication cookie');

        const created = await request(baseUrl, '/api/sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'm3u', name: 'IPTV-org Sports Test', url: playlistUrl })
        }, cookie);
        const sourceId = created.body.id;

        const deadline = Date.now() + 120_000;
        let status;
        while (Date.now() < deadline) {
            const statuses = await request(baseUrl, '/api/sources/status', {}, cookie);
            status = statuses.body.find(item => item.source_id === sourceId && item.type === 'all');
            if (status?.status === 'success') break;
            if (status?.status === 'error') throw new Error(`M3U synchronization failed: ${status.error}`);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.equal(status?.status, 'success', 'M3U synchronization timed out');

        const imported = await request(baseUrl, `/api/proxy/m3u/${sourceId}`, {}, cookie);
        assert(imported.body.channels.length > 0, 'The playlist imported no channels');
        assert(imported.body.groups.length > 0, 'The playlist imported no groups');
        assert(imported.body.channels.every(channel => channel.name && channel.url), 'Imported channel data is incomplete');

        console.log(`Real-world M3U test passed: ${imported.body.channels.length} channels in ${imported.body.groups.length} groups.`);
        console.log(`Playlist: ${playlistUrl}`);
    } catch (error) {
        console.error(output);
        throw error;
    } finally {
        await stopServer(child);
        await fs.rm(testRoot, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
