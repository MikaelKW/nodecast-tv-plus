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

async function startServer(dataDirectory, port, secrets) {
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            NODECAST_DATA_DIR: dataDirectory,
            PORT: String(port),
            ...secrets,
            OIDC_ISSUER_URL: '',
            OIDC_CLIENT_ID: '',
            OIDC_CLIENT_SECRET: ''
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    await waitForServer(`http://127.0.0.1:${port}`, child);
    return child;
}

async function syncNewProviderItems(dataDirectory) {
    const script = `
        const syncService = require('./server/services/syncService');
        (async () => {
            await syncService.saveCategories(1, 'live', [
                { category_id: 'category-new', category_name: 'New Category' }
            ]);
            await syncService.saveStreams(1, 'live', [
                { stream_id: 'new-existing-category', name: 'New Existing Category Channel', category_id: 'category-0' },
                { stream_id: 'new-category-channel', name: 'New Category Channel', category_id: 'category-new' }
            ], { skipPurge: true });
        })().then(() => process.exit(0)).catch(error => {
            console.error(error);
            process.exit(1);
        });
    `;
    const child = spawn(process.execPath, ['-e', script], {
        cwd: projectRoot,
        env: { ...process.env, NODECAST_DATA_DIR: dataDirectory },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const exitCode = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(exitCode, 0, stderr);
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

async function applyBulkVisibility(baseUrl, cookie, action, items) {
    const response = await fetch(`${baseUrl}/api/channels/${action}/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ items })
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
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
        const secrets = {
            JWT_SECRET: crypto.randomBytes(48).toString('hex'),
            SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
            TOTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex')
        };
        child = await startServer(dataDirectory, port, secrets);

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

        // Recreate the separate-save path used when one channel is enabled
        // after a previous Hide All operation. The parent category must be
        // restored too or Live TV will filter out the checked channel.
        await applyVisibility(baseUrl, cookie, {
            sourceId,
            contentType: 'channels',
            visible: false,
            overrides: []
        });
        await applyBulkVisibility(baseUrl, cookie, 'show', [{
            sourceId,
            itemType: 'channel',
            itemId: '0-0'
        }]);

        db = new Database(path.join(dataDirectory, 'content.db'), { readonly: true });
        assert.equal(db.prepare("SELECT is_hidden FROM playlist_items WHERE item_id = '0-0'").get().is_hidden, 0);
        assert.equal(db.prepare("SELECT is_hidden FROM categories WHERE category_id = 'category-0'").get().is_hidden, 0);
        db.close();

        const visibleStreamsResponse = await fetch(
            `${baseUrl}/api/proxy/xtream/${sourceId}/live_streams`,
            { headers: { Cookie: cookie } }
        );
        assert.equal(visibleStreamsResponse.status, 200);
        const visibleStreams = await visibleStreamsResponse.json();
        assert.equal(visibleStreams.length, 1);
        assert.equal(visibleStreams[0].stream_id, '0-0');

        await applyBulkVisibility(baseUrl, cookie, 'hide', [{
            sourceId,
            itemType: 'channel',
            itemId: '0-0'
        }]);
        db = new Database(path.join(dataDirectory, 'content.db'), { readonly: true });
        assert.equal(db.prepare("SELECT is_hidden FROM categories WHERE category_id = 'category-0'").get().is_hidden, 1);
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

        // Reapply the real production pattern, then simulate a restart sync
        // that discovers provider items which were not present at save time.
        await applyVisibility(baseUrl, cookie, {
            sourceId,
            contentType: 'channels',
            visible: false,
            overrides: [{ itemType: 'channel', itemId: '0-0', hidden: false }]
        });
        await stopServer(child);
        child = null;
        await syncNewProviderItems(dataDirectory);

        db = new Database(path.join(dataDirectory, 'content.db'), { readonly: true });
        assert.equal(
            db.prepare("SELECT is_hidden FROM playlist_items WHERE item_id = 'new-existing-category'").get().is_hidden,
            1
        );
        assert.equal(
            db.prepare("SELECT is_hidden FROM playlist_items WHERE item_id = 'new-category-channel'").get().is_hidden,
            1
        );
        assert.equal(
            db.prepare("SELECT is_hidden FROM categories WHERE category_id = 'category-new'").get().is_hidden,
            1
        );
        assert.equal(
            db.prepare("SELECT COUNT(*) AS count FROM playlist_items WHERE type = 'live' AND is_hidden = 0").get().count,
            1
        );
        db.close();

        child = await startServer(dataDirectory, port, secrets);
        const streamsResponse = await fetch(
            `${baseUrl}/api/proxy/xtream/${sourceId}/live_streams?includeHidden=true`,
            { headers: { Cookie: cookie } }
        );
        assert.equal(streamsResponse.status, 200);
        const streams = await streamsResponse.json();
        assert.equal(streams.filter(stream => !stream.is_hidden).length, 1);
        assert.equal(streams.find(stream => stream.stream_id === '0-0')?.is_hidden, 0);
        assert.equal(streams.find(stream => stream.stream_id === 'new-existing-category')?.is_hidden, 1);

        console.log(
            `Content visibility test passed: ${channelCount} channels plus restart-sync additions; `
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
