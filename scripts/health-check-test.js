const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const packageVersion = require('../package.json').version;

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

async function waitForHealthy(url, child, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited before becoming healthy (code ${child.exitCode}).`);
        }
        try {
            const response = await fetch(url);
            if (response.ok) return response;
        } catch {
            // Startup is still in progress.
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Server did not become healthy in time.');
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

async function startServer(dataDirectory, basePath = '') {
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
            NODECAST_BASE_PATH: basePath,
            PORT: String(port),
            JWT_SECRET: crypto.randomBytes(48).toString('hex'),
            SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
            OIDC_ISSUER_URL: '',
            OIDC_CLIENT_ID: '',
            OIDC_CLIENT_SECRET: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    return { baseUrl, child, getOutput: () => output };
}

async function run() {
    const rootData = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-health-root-'));
    const subpathData = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-health-subpath-'));
    let server;

    try {
        server = await startServer(rootData);
        const rootHealth = await waitForHealthy(`${server.baseUrl}/api/health`, server.child);
        assert.deepEqual(await rootHealth.json(), { status: 'ok', version: packageVersion });

        await fs.writeFile(path.join(rootData, 'db.json'), '{not-valid-json');
        const unavailable = await fetch(`${server.baseUrl}/api/health`);
        assert.equal(unavailable.status, 503);
        assert.deepEqual(await unavailable.json(), { status: 'unavailable', version: packageVersion });

        await stopServer(server.child);
        server = await startServer(subpathData, '/nodecast');
        const subpathHealth = await waitForHealthy(`${server.baseUrl}/nodecast/api/health`, server.child);
        assert.deepEqual(await subpathHealth.json(), { status: 'ok', version: packageVersion });

        console.log('Application health check test passed.');
    } catch (error) {
        if (server) console.error(server.getOutput());
        throw error;
    } finally {
        if (server) await stopServer(server.child);
        await fs.rm(rootData, { recursive: true, force: true });
        await fs.rm(subpathData, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
