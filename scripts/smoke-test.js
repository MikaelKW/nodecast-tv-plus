const assert = require('node:assert/strict');
const net = require('node:net');
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

async function waitForResponse(url, child, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;

    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited before becoming ready (code ${child.exitCode}).`);
        }

        try {
            const response = await fetch(url);
            if (response.ok) return response;
            lastError = new Error(`Server returned HTTP ${response.status}.`);
        } catch (error) {
            lastError = error;
        }

        await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error(`Server did not become ready within ${timeoutMs}ms: ${lastError?.message || 'unknown error'}`);
}

async function stopServer(child) {
    if (child.exitCode !== null) return;

    child.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000))
    ]);

    if (child.exitCode === null) {
        child.kill('SIGKILL');
    }
}

async function run() {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let output = '';

    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(port),
            JWT_SECRET: 'ci-smoke-test-jwt-secret-not-for-production',
            SESSION_SECRET: 'ci-smoke-test-session-secret-not-for-production',
            OIDC_ISSUER_URL: '',
            OIDC_CLIENT_ID: '',
            OIDC_CLIENT_SECRET: '',
            OIDC_AUTH_URL: '',
            OIDC_TOKEN_URL: '',
            OIDC_USERINFO_URL: '',
            DISABLE_LOCAL_AUTH: '',
            OIDC_AUTO_REDIRECT: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });

    try {
        const versionResponse = await waitForResponse(`${baseUrl}/api/version`, child);
        const version = await versionResponse.json();
        const packageVersion = require('../package.json').version;
        assert.equal(version.version, packageVersion);

        const setupResponse = await fetch(`${baseUrl}/api/auth/setup-required`);
        assert.equal(setupResponse.status, 200);
        const setup = await setupResponse.json();
        assert.equal(typeof setup.setupRequired, 'boolean');

        const oidcStatusResponse = await fetch(`${baseUrl}/api/auth/oidc/status`);
        assert.equal(oidcStatusResponse.status, 200);
        assert.deepEqual(await oidcStatusResponse.json(), {
            enabled: false,
            localAuthEnabled: true,
            autoRedirect: false
        });

        for (const protectedPath of [
            '/api/sources',
            '/api/settings',
            '/api/proxy/image?url=https://example.com/logo.png',
            '/api/transcode?url=file:///etc/passwd'
        ]) {
            const protectedResponse = await fetch(`${baseUrl}${protectedPath}`);
            assert.equal(protectedResponse.status, 401, `${protectedPath} must require authentication.`);
        }

        const crossSiteResponse = await fetch(`${baseUrl}/api/auth/logout`, {
            method: 'POST',
            headers: { Origin: 'https://attacker.example' }
        });
        assert.equal(crossSiteResponse.status, 403, 'Cross-site state-changing requests must be blocked.');

        const homeResponse = await fetch(baseUrl);
        assert.equal(homeResponse.status, 200);
        assert.match(await homeResponse.text(), /NodeCast TV Plus/);

        console.log(`Smoke test passed on port ${port}.`);
    } catch (error) {
        console.error(output);
        throw error;
    } finally {
        await stopServer(child);
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
