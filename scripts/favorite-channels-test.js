const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

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
        if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}.`);
        try {
            const response = await fetch(`${baseUrl}/api/health`);
            if (response.ok) return;
        } catch {
            // The server is still starting.
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
    const db = new Database(path.join(dataDirectory, 'content.db'));
    db.exec(`
        CREATE TABLE categories (
            id TEXT PRIMARY KEY,
            source_id INTEGER NOT NULL,
            category_id TEXT NOT NULL,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            parent_id TEXT,
            is_hidden INTEGER DEFAULT 0,
            data JSON
        );
        CREATE TABLE playlist_items (
            id TEXT PRIMARY KEY,
            source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            category_id TEXT,
            parent_id TEXT,
            stream_icon TEXT,
            stream_url TEXT,
            container_extension TEXT,
            rating REAL,
            year TEXT,
            added_at TEXT,
            is_hidden INTEGER DEFAULT 0,
            is_favorite INTEGER DEFAULT 0,
            data JSON
        );
    `);
    const category = db.prepare(`
        INSERT INTO categories (id, source_id, category_id, type, name, is_hidden)
        VALUES (?, ?, ?, 'live', ?, ?)
    `);
    category.run('1:visible', 1, 'visible', 'Visible Group', 0);
    category.run('1:hidden', 1, 'hidden', 'Hidden Group', 1);

    const channel = db.prepare(`
        INSERT INTO playlist_items
            (id, source_id, item_id, type, name, category_id, stream_icon, stream_url, is_hidden, data)
        VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?)
    `);
    channel.run(
        '1:visible-channel', 1, 'visible-channel', 'Visible Favorite', 'visible',
        'https://images.invalid/visible.png', 'http://streams.invalid/visible.ts', 0,
        JSON.stringify({ tvgId: 'visible-epg' })
    );
    channel.run(
        '1:hidden-channel', 1, 'hidden-channel', 'Hidden Favorite', 'visible',
        null, 'http://streams.invalid/hidden.ts', 1, '{}'
    );
    channel.run(
        '1:hidden-group-channel', 1, 'hidden-group-channel', 'Hidden Group Favorite', 'hidden',
        null, 'http://streams.invalid/hidden-group.ts', 0, '{}'
    );
    channel.run(
        '1:alpha', 1, 'alpha', 'Alpha Channel', 'visible',
        null, 'http://streams.invalid/alpha.ts', 0, '{}'
    );
    channel.run(
        '1:beta', 1, 'beta', 'beta Channel', 'visible',
        null, null, 0, JSON.stringify({ stream_url: 'http://streams.invalid/beta.ts' })
    );
    channel.run(
        '1:gamma', 1, 'gamma', 'Gamma Channel', 'visible',
        null, 'http://streams.invalid/gamma.ts', 0, '{}'
    );
    channel.run(
        '1:uncategorized', 1, 'uncategorized', 'Uncategorized Channel', null,
        null, 'http://streams.invalid/uncategorized.ts', 0, '{}'
    );
    db.close();
}

async function requestFavorite(baseUrl, cookie, itemId) {
    const response = await fetch(`${baseUrl}/api/favorites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ sourceId: 1, itemId, itemType: 'channel' })
    });
    assert.equal(response.status, 200, await response.text());
}

async function requestJson(url, cookie, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {}),
            Cookie: cookie
        }
    });
    const text = await response.text();
    assert.equal(response.status, options.expectedStatus || 200, text);
    return text ? JSON.parse(text) : null;
}

async function run() {
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-favorite-channels-'));
    const dataDirectory = path.join(testRoot, 'data');
    await fs.mkdir(dataDirectory, { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(path.join(dataDirectory, 'db.json'), JSON.stringify({
        sources: [{
            id: 1,
            name: 'Favorite Channel Test',
            type: 'm3u',
            url: 'http://127.0.0.1.invalid/playlist.m3u',
            enabled: true,
            contentVisibility: { live: true, movies: false, series: false },
            created_at: now,
            updated_at: now
        }],
        hiddenItems: [],
        favorites: [],
        settings: {},
        users: [],
        nextId: 2
    }));
    seedCatalogue(dataDirectory);

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
            TOTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
            OIDC_ISSUER_URL: '',
            OIDC_CLIENT_ID: '',
            OIDC_CLIENT_SECRET: ''
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
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
                username: 'FavoriteAdmin',
                password,
                passwordConfirmation: password
            })
        });
        assert.equal(setup.status, 201, await setup.text());
        const cookie = (setup.headers.get('set-cookie') || '').split(';', 1)[0];
        assert.ok(cookie);

        await requestFavorite(baseUrl, cookie, 'visible-channel');
        await requestFavorite(baseUrl, cookie, 'm3u_1_beta');
        await requestFavorite(baseUrl, cookie, 'hidden-channel');
        await requestFavorite(baseUrl, cookie, 'hidden-group-channel');

        const response = await fetch(`${baseUrl}/api/favorites/channels`, {
            headers: { Cookie: cookie }
        });
        const responseText = await response.text();
        assert.equal(response.status, 200, responseText);
        const channels = JSON.parse(responseText);
        assert.equal(channels.length, 2);
        assert.deepEqual(channels, [
            {
                favoriteId: channels[0].favoriteId,
                id: 'm3u_1_beta',
                streamId: 'beta',
                name: 'beta Channel',
                tvgId: null,
                tvgLogo: null,
                url: 'http://streams.invalid/beta.ts',
                groupId: 'm3u_1_visible',
                groupTitle: 'Visible Group',
                sourceId: 1,
                sourceType: 'm3u'
            },
            {
                favoriteId: channels[1].favoriteId,
                id: 'm3u_1_visible-channel',
                streamId: 'visible-channel',
                name: 'Visible Favorite',
                tvgId: 'visible-epg',
                tvgLogo: 'https://images.invalid/visible.png',
                url: 'http://streams.invalid/visible.ts',
                groupId: 'm3u_1_visible',
                groupTitle: 'Visible Group',
                sourceId: 1,
                sourceType: 'm3u'
            }
        ]);

        const summary = await requestJson(
            `${baseUrl}/api/proxy/catalogue/1/live/summary`,
            cookie
        );
        assert.equal(summary.schemaVersion, 1);
        assert.equal(summary.revision, 0);
        assert.equal(summary.totalChannels, 5);
        assert.deepEqual(summary.groups, [
            { id: '__uncategorized__', name: 'Uncategorized', count: 1 },
            { id: 'visible', name: 'Visible Group', count: 4 }
        ]);

        const firstPage = await requestJson(
            `${baseUrl}/api/proxy/catalogue/1/live/channels?limit=2`,
            cookie
        );
        assert.deepEqual(firstPage.items.map(item => item.stream_id), ['alpha', 'beta']);
        assert.equal(firstPage.hasMore, true);
        assert.ok(firstPage.nextCursor);

        const secondPage = await requestJson(
            `${baseUrl}/api/proxy/catalogue/1/live/channels?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
            cookie
        );
        assert.deepEqual(secondPage.items.map(item => item.stream_id), ['gamma', 'uncategorized']);
        assert.equal(secondPage.hasMore, true);

        const groupPage = await requestJson(
            `${baseUrl}/api/proxy/catalogue/1/live/channels?category_id=visible&limit=10`,
            cookie
        );
        assert.deepEqual(
            groupPage.items.map(item => item.stream_id),
            ['alpha', 'beta', 'gamma', 'visible-channel']
        );

        const searchPage = await requestJson(
            `${baseUrl}/api/proxy/catalogue/1/live/channels?query=favorite&limit=10`,
            cookie
        );
        assert.deepEqual(searchPage.items.map(item => item.stream_id), ['visible-channel']);

        const literalWildcardSearch = await requestJson(
            `${baseUrl}/api/proxy/catalogue/1/live/channels?query=${encodeURIComponent('%')}&limit=10`,
            cookie
        );
        assert.equal(literalWildcardSearch.items.length, 0);

        await requestJson(`${baseUrl}/api/proxy/catalogue/1/live/channels?limit=501`, cookie, {
            expectedStatus: 400
        });
        await requestJson(`${baseUrl}/api/proxy/catalogue/1/live/channels?cursor=invalid`, cookie, {
            expectedStatus: 400
        });

        const legacyStreams = await requestJson(
            `${baseUrl}/api/proxy/xtream/1/live_streams`,
            cookie
        );
        assert.equal(legacyStreams.length, 5);

        await requestJson(`${baseUrl}/api/channels/hide`, cookie, {
            method: 'POST',
            body: JSON.stringify({ sourceId: 1, itemType: 'channel', itemId: 'alpha' })
        });
        const revisedSummary = await requestJson(
            `${baseUrl}/api/proxy/catalogue/1/live/summary`,
            cookie
        );
        assert.equal(revisedSummary.revision, 1);
        assert.equal(revisedSummary.totalChannels, 4);

        console.log('Targeted favorites and revisioned catalogue contract tests passed.');
    } catch (error) {
        console.error(output);
        throw error;
    } finally {
        await stopServer(child);
        await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
