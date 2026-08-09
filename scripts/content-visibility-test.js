const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const projectRoot = path.join(__dirname, '..');
const sourceId = 1;
const categoryCount = 200;
const channelsPerCategory = 500;
const channelCount = categoryCount * channelsPerCategory;

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
        if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}.`);
        try {
            const response = await fetch(`${baseUrl}/api/health`);
            if (response.ok) return;
        } catch {
            // Server is still starting.
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('Server did not become ready.');
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

function seedCatalogue(dataDirectory) {
    process.env.NODECAST_DATA_DIR = dataDirectory;
    const { getDb } = require('../server/db/sqlite');
    const db = getDb();
    const insertCategory = db.prepare(`
        INSERT INTO categories (id, source_id, category_id, type, name)
        VALUES (?, ?, ?, 'live', ?)
    `);
    const insertChannel = db.prepare(`
        INSERT INTO playlist_items
            (id, source_id, item_id, type, name, category_id, stream_url, data)
        VALUES (?, ?, ?, 'live', ?, ?, ?, '{}')
    `);

    db.transaction(() => {
        for (let categoryIndex = 0; categoryIndex < categoryCount; categoryIndex += 1) {
            const categoryId = `category-${categoryIndex}`;
            insertCategory.run(`${sourceId}:${categoryId}`, sourceId, categoryId, `Category ${categoryIndex}`);
            for (let channelIndex = 0; channelIndex < channelsPerCategory; channelIndex += 1) {
                const itemId = `${categoryIndex}-${channelIndex}`;
                insertChannel.run(
                    `${sourceId}:${itemId}`,
                    sourceId,
                    itemId,
                    `Channel ${itemId}`,
                    categoryId,
                    `http://127.0.0.1.invalid/${itemId}`
                );
            }
        }
    })();
    db.close();
}

async function applyVisibility(baseUrl, cookie, body) {
    const started = performance.now();
    const response = await fetch(`${baseUrl}/api/channels/visibility/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(body)
    });
    const elapsedMs = performance.now() - started;
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    return { elapsedMs, payload: JSON.parse(responseText) };
}

async function run() {
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-content-visibility-'));
    const dataDirectory = path.join(testRoot, 'data');
    await fs.mkdir(dataDirectory, { recursive: true });
    let child;

    try {
        seedCatalogue(dataDirectory);
        const port = await getFreePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath, ['server/index.js'], {
            cwd: projectRoot,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                NODECAST_DATA_DIR: dataDirectory,
                PORT: String(port),
                JWT_SECRET: crypto.randomBytes(48).toString('hex'),
                SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
                TOTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
                OIDC_ISSUER_URL: '',
                OIDC_CLIENT_ID: '',
                OIDC_CLIENT_SECRET: ''
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        await waitForServer(baseUrl, child);

        const password = crypto.randomBytes(24).toString('base64url');
        const setup = await fetch(`${baseUrl}/api/auth/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'VisibilityAdmin',
                password,
                passwordConfirmation: password
            })
        });
        assert.equal(setup.status, 201);
        const cookie = (setup.headers.get('set-cookie') || '').split(';', 1)[0];
        assert.ok(cookie);

        const hideResult = await applyVisibility(baseUrl, cookie, {
            sourceId,
            contentType: 'channels',
            visible: false,
            overrides: [{ itemType: 'channel', itemId: '0-0', hidden: false }]
        });
        assert.equal(hideResult.payload.overrideCount, 1);
        assert.ok(hideResult.elapsedMs < 5000, `Hide-all exception took ${hideResult.elapsedMs.toFixed(1)}ms.`);

        let db = new Database(path.join(dataDirectory, 'content.db'), { readonly: true });
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM playlist_items WHERE type = 'live' AND is_hidden = 0").get().count, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM categories WHERE type = 'live' AND is_hidden = 0").get().count, 1);
        db.close();

        const showResult = await applyVisibility(baseUrl, cookie, {
            sourceId,
            contentType: 'channels',
            visible: true,
            overrides: [{ itemType: 'group', itemId: 'category-0', hidden: true }]
        });
        assert.equal(showResult.payload.overrideCount, 1);
        assert.ok(showResult.elapsedMs < 5000, `Show-all exception took ${showResult.elapsedMs.toFixed(1)}ms.`);

        db = new Database(path.join(dataDirectory, 'content.db'), { readonly: true });
        assert.equal(
            db.prepare("SELECT COUNT(*) AS count FROM playlist_items WHERE type = 'live' AND is_hidden = 0").get().count,
            channelCount - channelsPerCategory
        );
        assert.equal(db.prepare("SELECT is_hidden FROM categories WHERE category_id = 'category-0'").get().is_hidden, 1);
        db.close();

        console.log(
            `Content visibility test passed: ${channelCount} channels; `
            + `hide ${hideResult.elapsedMs.toFixed(1)}ms, show ${showResult.elapsedMs.toFixed(1)}ms.`
        );
    } finally {
        await stopServer(child);
        await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
