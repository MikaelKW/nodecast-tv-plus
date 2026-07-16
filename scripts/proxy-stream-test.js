const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
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

function waitFor(predicate, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            if (predicate()) return resolve();
            if (Date.now() >= deadline) return reject(new Error('Timed out waiting for the expected state.'));
            setTimeout(check, 25);
        };
        check();
    });
}

async function readBody(response) {
    const chunks = [];
    const reader = response.body.getReader();
    while (true) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks);
}

async function run() {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-proxy-stream-'));
    const sourcePort = await getFreePort();
    const appPort = await getFreePort();
    const sourceBaseUrl = `http://127.0.0.1:${sourcePort}`;
    const appBaseUrl = `http://127.0.0.1:${appPort}`;
    let binaryUpstreamComplete = false;
    let disconnectedUpstreamClosed = false;

    const sourceServer = http.createServer((request, response) => {
        if (request.url === '/binary') {
            response.writeHead(200, { 'Content-Type': 'video/mp2t' });
            let sent = 0;
            const timer = setInterval(() => {
                sent += 1;
                response.write(Buffer.alloc(32 * 1024, sent));
                if (sent === 6) {
                    clearInterval(timer);
                    binaryUpstreamComplete = true;
                    response.end();
                }
            }, 125);
            return;
        }

        if (request.url === '/range') {
            assert.equal(request.headers.range, 'bytes=2-5');
            response.writeHead(206, {
                'Content-Type': 'video/mp4',
                'Content-Length': '4',
                'Content-Range': 'bytes 2-5/10',
                'Accept-Ranges': 'bytes'
            });
            response.end('2345');
            return;
        }

        if (request.url === '/playlist.m3u8') {
            response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            response.write('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n');
            setTimeout(() => response.end('#EXTINF:4,\nsegment.ts\n'), 50);
            return;
        }

        if (request.url === '/oversized.m3u8') {
            response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            response.end(`#EXTM3U\n${'x'.repeat(5 * 1024 * 1024)}`);
            return;
        }

        if (request.url === '/disconnect') {
            response.writeHead(200, { 'Content-Type': 'video/mp2t' });
            const timer = setInterval(() => response.write(Buffer.alloc(16 * 1024)), 50);
            response.on('close', () => {
                clearInterval(timer);
                disconnectedUpstreamClosed = true;
            });
            return;
        }

        response.writeHead(404);
        response.end();
    });

    await new Promise((resolve, reject) => {
        sourceServer.once('error', reject);
        sourceServer.listen(sourcePort, '127.0.0.1', resolve);
    });

    let output = '';
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            NODECAST_DATA_DIR: dataDirectory,
            NODECAST_CACHE_DIR: path.join(dataDirectory, 'cache'),
            NODECAST_DISABLE_BACKGROUND_JOBS: 'true',
            ALLOW_LOCAL_MEDIA_URLS: 'true',
            PORT: String(appPort),
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
        await waitForServer(appBaseUrl, child);
        const setupPassword = crypto.randomBytes(24).toString('base64url');
        const setup = await fetch(`${appBaseUrl}/api/auth/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'proxy-test-admin',
                password: setupPassword,
                passwordConfirmation: setupPassword
            })
        });
        assert.equal(setup.status, 201);
        const cookie = (setup.headers.get('set-cookie') || '').split(';', 1)[0];
        assert.ok(cookie);

        const proxy = target => `${appBaseUrl}/api/proxy/stream?url=${encodeURIComponent(target)}`;

        const binaryResponse = await fetch(proxy(`${sourceBaseUrl}/binary`), { headers: { Cookie: cookie } });
        assert.equal(binaryResponse.status, 200);
        const binaryReader = binaryResponse.body.getReader();
        const firstBinaryChunk = await binaryReader.read();
        assert.equal(firstBinaryChunk.done, false);
        assert.equal(binaryUpstreamComplete, false, 'Binary playback must start before the upstream response completes.');
        let binaryBytes = firstBinaryChunk.value.byteLength;
        while (true) {
            const result = await binaryReader.read();
            if (result.done) break;
            binaryBytes += result.value.byteLength;
        }
        assert.equal(binaryBytes, 6 * 32 * 1024);

        const rangeResponse = await fetch(proxy(`${sourceBaseUrl}/range`), {
            headers: { Cookie: cookie, Range: 'bytes=2-5' }
        });
        assert.equal(rangeResponse.status, 206);
        assert.equal(rangeResponse.headers.get('content-range'), 'bytes 2-5/10');
        assert.equal(rangeResponse.headers.get('accept-ranges'), 'bytes');
        assert.equal(await rangeResponse.text(), '2345');

        const manifestResponse = await fetch(proxy(`${sourceBaseUrl}/playlist.m3u8`), { headers: { Cookie: cookie } });
        assert.equal(manifestResponse.status, 200);
        const manifest = await manifestResponse.text();
        assert.match(manifest, /#EXTM3U/);
        assert.ok(manifest.includes(`url=${encodeURIComponent(`${sourceBaseUrl}/key.bin`)}`));
        assert.ok(manifest.includes(`url=${encodeURIComponent(`${sourceBaseUrl}/segment.ts`)}`));

        const oversizedResponse = await fetch(proxy(`${sourceBaseUrl}/oversized.m3u8`), { headers: { Cookie: cookie } });
        assert.equal(oversizedResponse.status, 502);
        assert.deepEqual(await oversizedResponse.json(), { error: 'HLS manifest exceeds the proxy size limit' });

        const disconnectResponse = await fetch(proxy(`${sourceBaseUrl}/disconnect`), { headers: { Cookie: cookie } });
        const disconnectReader = disconnectResponse.body.getReader();
        await disconnectReader.read();
        await disconnectReader.cancel();
        await waitFor(() => disconnectedUpstreamClosed);

        console.log('Proxy streaming regression test passed.');
    } catch (error) {
        console.error(output);
        throw error;
    } finally {
        await stopServer(child);
        await new Promise(resolve => sourceServer.close(resolve));
        await fs.rm(dataDirectory, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
