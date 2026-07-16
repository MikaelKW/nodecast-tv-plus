const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const password = crypto.randomBytes(24).toString('base64url');

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
            // The server may still be starting.
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Server did not become ready within ${timeoutMs}ms.`);
}

async function stopServer(child) {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

async function startServer(dataDirectory) {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let output = '';
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            NODECAST_DATA_DIR: dataDirectory,
            PORT: String(port),
            JWT_SECRET: crypto.randomBytes(48).toString('hex'),
            SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
            OIDC_ISSUER_URL: '',
            OIDC_CLIENT_ID: '',
            OIDC_CLIENT_SECRET: '',
            OIDC_AUTH_URL: '',
            OIDC_TOKEN_URL: '',
            OIDC_USERINFO_URL: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    await waitForServer(baseUrl, child);
    return { baseUrl, child, getOutput: () => output };
}

async function request(baseUrl, route, { method = 'GET', body, cookie } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json();
    return { response, payload };
}

function getCookie(response) {
    return (response.headers.get('set-cookie') || '').split(';', 1)[0];
}

async function run() {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-username-case-'));
    let server;

    try {
        server = await startServer(dataDirectory);

        const mismatch = await request(server.baseUrl, '/api/auth/setup', {
            method: 'POST',
            body: {
                username: 'MobileUser',
                password,
                passwordConfirmation: `${password}-different`
            }
        });
        assert.equal(mismatch.response.status, 400);
        assert.equal(mismatch.payload.error, 'Passwords do not match');

        const stillRequired = await request(server.baseUrl, '/api/auth/setup-required');
        assert.equal(stillRequired.payload.setupRequired, true);

        const setup = await request(server.baseUrl, '/api/auth/setup', {
            method: 'POST',
            body: { username: 'MobileUser', password, passwordConfirmation: password }
        });
        assert.equal(setup.response.status, 201);
        assert.equal(setup.payload.user.username, 'MobileUser');
        const adminCookie = getCookie(setup.response);
        assert.ok(adminCookie, 'Initial setup must issue an authentication cookie.');

        for (const username of ['mobileuser', 'MOBILEUSER', 'MoBiLeUsEr']) {
            const login = await request(server.baseUrl, '/api/auth/login', {
                method: 'POST',
                body: { username, password }
            });
            assert.equal(login.response.status, 200, `${username} must authenticate.`);
            assert.equal(login.payload.user.username, 'MobileUser');
            assert.ok(getCookie(login.response), 'Successful login must issue an authentication cookie.');
        }

        const duplicate = await request(server.baseUrl, '/api/auth/users', {
            method: 'POST',
            cookie: adminCookie,
            body: { username: 'mObIlEuSeR', password, passwordConfirmation: password, role: 'viewer' }
        });
        assert.equal(duplicate.response.status, 409);
        assert.equal(duplicate.payload.error, 'Username already exists');

        const missingConfirmation = await request(server.baseUrl, '/api/auth/users', {
            method: 'POST',
            cookie: adminCookie,
            body: { username: 'MissingConfirmation', password, role: 'viewer' }
        });
        assert.equal(missingConfirmation.response.status, 400);
        assert.equal(missingConfirmation.payload.error, 'Password confirmation required');

        const mismatchedConfirmation = await request(server.baseUrl, '/api/auth/users', {
            method: 'POST',
            cookie: adminCookie,
            body: {
                username: 'MismatchedConfirmation',
                password,
                passwordConfirmation: `${password}-different`,
                role: 'viewer'
            }
        });
        assert.equal(mismatchedConfirmation.response.status, 400);
        assert.equal(mismatchedConfirmation.payload.error, 'Passwords do not match');

        const viewer = await request(server.baseUrl, '/api/auth/users', {
            method: 'POST',
            cookie: adminCookie,
            body: { username: 'ViewerAccount', password, passwordConfirmation: password, role: 'viewer' }
        });
        assert.equal(viewer.response.status, 201);

        const conflictingUpdate = await request(server.baseUrl, `/api/auth/users/${viewer.payload.id}`, {
            method: 'PUT',
            cookie: adminCookie,
            body: { username: 'MOBILEUSER' }
        });
        assert.equal(conflictingUpdate.response.status, 409);
        assert.equal(conflictingUpdate.payload.error, 'Username already exists');

        const caseOnlyUpdate = await request(server.baseUrl, `/api/auth/users/${setup.payload.user.id}`, {
            method: 'PUT',
            cookie: adminCookie,
            body: { username: 'mobileuser' }
        });
        assert.equal(caseOnlyUpdate.response.status, 200);
        assert.equal(caseOnlyUpdate.payload.username, 'mobileuser');

        await stopServer(server.child);
        server = null;

        const databasePath = path.join(dataDirectory, 'db.json');
        const database = JSON.parse(await fs.readFile(databasePath, 'utf8'));
        const existing = database.users.find(user => user.username === 'mobileuser');
        database.users.push({
            ...existing,
            id: database.nextId++,
            username: 'MOBILEUSER',
            role: 'viewer'
        });
        await fs.writeFile(databasePath, JSON.stringify(database, null, 2));

        server = await startServer(dataDirectory);
        for (const username of ['mobileuser', 'MOBILEUSER']) {
            const exactLegacyLogin = await request(server.baseUrl, '/api/auth/login', {
                method: 'POST',
                body: { username, password }
            });
            assert.equal(exactLegacyLogin.response.status, 200, 'Legacy collisions must retain exact-case access.');
            assert.equal(exactLegacyLogin.payload.user.username, username);
        }

        const ambiguousLogin = await request(server.baseUrl, '/api/auth/login', {
            method: 'POST',
            body: { username: 'MoBiLeUsEr', password }
        });
        assert.equal(ambiguousLogin.response.status, 401, 'Ambiguous mixed-case usernames must fail closed.');
        assert.equal(ambiguousLogin.payload.error, 'Invalid credentials');

        console.log('Case-insensitive username authentication test passed.');
    } catch (error) {
        if (server) console.error(server.getOutput());
        throw error;
    } finally {
        if (server) await stopServer(server.child);
        await fs.rm(dataDirectory, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
