'use strict';

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
        if (child.exitCode !== null) {
            throw new Error(`Server exited before becoming ready (code ${child.exitCode}).`);
        }
        try {
            if (await require('./helpers/applicationReadiness').isApplicationReady(baseUrl)) return;
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

// Recreates the watch_history table and record keys written by v2.7.2 and
// earlier releases, where the identity was only `userId:itemId`.
function seedLegacyDatabase(dataDirectory) {
    const db = new Database(path.join(dataDirectory, 'content.db'));
    db.exec(`
        CREATE TABLE watch_history (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            source_id INTEGER,
            item_type TEXT NOT NULL,
            item_id TEXT NOT NULL,
            parent_id TEXT,
            progress INTEGER DEFAULT 0,
            duration INTEGER DEFAULT 0,
            updated_at INTEGER NOT NULL,
            data JSON
        );
    `);
    const insert = db.prepare(`
        INSERT INTO watch_history (id, user_id, source_id, item_type, item_id, progress, duration, updated_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    insert.run('1:500', 1, 9001, 'movie', '500', 300, 6000, now - 5000,
        JSON.stringify({ title: 'Legacy movie', sourceId: 9001 }));
    insert.run('1:501', 1, 9001, 'episode', '501', 400, 2400, now - 4000,
        JSON.stringify({ title: 'Legacy episode', sourceId: 9001 }));
    // Saved before source_id existed: the source only survives in metadata.
    insert.run('1:502', 1, null, 'movie', '502', 50, 6000, now - 3000,
        JSON.stringify({ title: 'Legacy metadata source', sourceId: 9002 }));
    insert.run('1:local:1', 1, null, 'movie', 'local:1', 60, 6000, now - 2000,
        JSON.stringify({ title: 'Legacy without source' }));
    insert.run('2:500', 2, 9001, 'movie', '500', 900, 6000, now - 1000,
        JSON.stringify({ title: 'Other account movie', sourceId: 9001 }));
    db.close();
}

function readStoredIds(dataDirectory) {
    const db = new Database(path.join(dataDirectory, 'content.db'), { readonly: true });
    try {
        return db.prepare('SELECT id FROM watch_history ORDER BY id').all().map(row => row.id);
    } finally {
        db.close();
    }
}

async function run() {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-watch-history-'));
    const jwtSecret = crypto.randomBytes(48).toString('hex');
    const sessionSecret = crypto.randomBytes(48).toString('hex');
    let output = '';
    let child = null;
    let baseUrl = '';

    async function startServer() {
        const port = await getFreePort();
        baseUrl = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath, ['server/index.js'], {
            cwd: projectRoot,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                NODECAST_DATA_DIR: dataDirectory,
                NODECAST_CACHE_DIR: path.join(dataDirectory, 'cache'),
                NODECAST_DISABLE_BACKGROUND_JOBS: 'true',
                PORT: String(port),
                JWT_SECRET: jwtSecret,
                SESSION_SECRET: sessionSecret,
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
        await waitForServer(baseUrl, child);
    }

    async function login(username, password) {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        assert.equal(response.status, 200);
        const cookie = (response.headers.get('set-cookie') || '').split(';', 1)[0];
        assert.ok(cookie);
        return { Cookie: cookie, 'Content-Type': 'application/json' };
    }

    async function save(headers, body) {
        const response = await fetch(`${baseUrl}/api/history`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        assert.equal(response.status, 200, await response.text());
    }

    async function list(headers) {
        const response = await fetch(`${baseUrl}/api/history?limit=100`, { headers });
        assert.equal(response.status, 200);
        return response.json();
    }

    async function remove(headers, itemId, query = '') {
        return fetch(`${baseUrl}/api/history/${encodeURIComponent(itemId)}${query}`, {
            method: 'DELETE',
            headers
        });
    }

    function find(history, { id, type, sourceId = null }) {
        const matches = history.filter(entry => entry.item_id === String(id)
            && entry.item_type === type
            && entry.source_id === sourceId);
        assert.ok(matches.length <= 1, `Duplicate history records for ${type} ${id}`);
        return matches[0];
    }

    try {
        seedLegacyDatabase(dataDirectory);
        await startServer();

        const adminPassword = crypto.randomBytes(24).toString('base64url');
        const setup = await fetch(`${baseUrl}/api/auth/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'history-admin',
                password: adminPassword,
                passwordConfirmation: adminPassword
            })
        });
        assert.equal(setup.status, 201);
        const admin = await login('history-admin', adminPassword);
        const adminMe = await (await fetch(`${baseUrl}/api/auth/me`, { headers: admin })).json();
        assert.equal(adminMe.id, 1, 'The seeded legacy records belong to the first account');

        const viewerPassword = crypto.randomBytes(24).toString('base64url');
        const createViewer = await fetch(`${baseUrl}/api/auth/users`, {
            method: 'POST',
            headers: admin,
            body: JSON.stringify({
                username: 'history-viewer',
                password: viewerPassword,
                passwordConfirmation: viewerPassword,
                role: 'viewer'
            })
        });
        assert.equal(createViewer.status, 201);
        assert.equal((await createViewer.json()).id, 2);
        const viewer = await login('history-viewer', viewerPassword);

        // Upgrade: unambiguous legacy records keep their progress and metadata
        // under the new identity and remain reachable by later saves.
        let history = await list(admin);
        assert.equal(history.length, 4);
        assert.equal(find(history, { id: 500, type: 'movie', sourceId: 9001 }).progress, 300);
        assert.equal(find(history, { id: 501, type: 'episode', sourceId: 9001 }).data.title, 'Legacy episode');
        assert.equal(find(history, { id: 502, type: 'movie', sourceId: 9002 }).progress, 50,
            'A legacy record without source_id adopts the source kept in its metadata');
        assert.equal(find(history, { id: 'local:1', type: 'movie' }).progress, 60);
        assert.equal((await list(viewer)).length, 1);
        assert.deepEqual(readStoredIds(dataDirectory), [
            '1:9001:episode:501',
            '1:9001:movie:500',
            '1:9002:movie:502',
            '1:none:movie:local:1',
            '2:9001:movie:500'
        ]);

        await save(admin, { id: '500', type: 'movie', sourceId: 9001, progress: 310, duration: 6000, data: { title: 'Legacy movie' } });
        await save(admin, { id: '502', type: 'movie', sourceId: '9002', progress: 55, duration: 6000, data: { title: 'Legacy metadata source' } });
        history = await list(admin);
        assert.equal(history.length, 4, 'Saving a migrated item must update it instead of adding a duplicate');
        assert.equal(find(history, { id: 500, type: 'movie', sourceId: 9001 }).progress, 310);
        assert.equal(find(history, { id: 502, type: 'movie', sourceId: 9002 }).progress, 55);

        // A movie and an episode with the same provider ID, saved in both orders.
        const orders = [
            { id: '77', first: 'movie', second: 'episode' },
            { id: '78', first: 'episode', second: 'movie' }
        ];
        for (const { id, first, second } of orders) {
            await save(admin, { id, type: first, sourceId: 9001, progress: 120, duration: 6000, data: { title: `${first} ${id}` } });
            await save(admin, { id, type: second, sourceId: 9001, progress: 600, duration: 2400, data: { title: `${second} ${id}` } });
            history = await list(admin);
            const firstRecord = find(history, { id, type: first, sourceId: 9001 });
            const secondRecord = find(history, { id, type: second, sourceId: 9001 });
            assert.deepEqual(
                [firstRecord.progress, firstRecord.duration, firstRecord.data.title],
                [120, 6000, `${first} ${id}`]
            );
            assert.deepEqual(
                [secondRecord.progress, secondRecord.duration, secondRecord.data.title],
                [600, 2400, `${second} ${id}`]
            );

            // Repeated periodic and final-position saves update only their own record.
            for (const progress of [130, 140, 150]) {
                await save(admin, { id, type: first, sourceId: 9001, progress, duration: 6000, data: { title: `${first} ${id}` } });
            }
            history = await list(admin);
            assert.equal(find(history, { id, type: first, sourceId: 9001 }).progress, 150);
            assert.equal(find(history, { id, type: second, sourceId: 9001 }).progress, 600);
        }

        // The same provider ID from different sources.
        await save(admin, { id: '77', type: 'movie', sourceId: 9002, progress: 45, duration: 5000, data: { title: 'Second source' } });
        history = await list(admin);
        assert.equal(find(history, { id: 77, type: 'movie', sourceId: 9001 }).data.title, 'movie 77');
        assert.equal(find(history, { id: 77, type: 'movie', sourceId: 9001 }).progress, 150);
        assert.equal(find(history, { id: 77, type: 'movie', sourceId: 9002 }).progress, 45);

        // Content saved without a source has its own stable identity.
        await save(admin, { id: 'local-1', type: 'movie', progress: 10, duration: 100 });
        await save(admin, { id: 'local-1', type: 'movie', progress: 20, duration: 100 });
        await save(admin, { id: 'local-1', type: 'movie', sourceId: 9001, progress: 70, duration: 100 });
        history = await list(admin);
        assert.equal(find(history, { id: 'local-1', type: 'movie' }).progress, 20);
        assert.equal(find(history, { id: 'local-1', type: 'movie', sourceId: 9001 }).progress, 70);
        assert.equal(history.length, 11);

        // Accounts stay isolated under the same source, type and provider ID.
        await save(viewer, { id: '77', type: 'movie', sourceId: 9001, progress: 999, duration: 6000, data: { title: 'Viewer movie' } });
        history = await list(admin);
        assert.equal(find(history, { id: 77, type: 'movie', sourceId: 9001 }).progress, 150);
        assert.equal((await remove(viewer, '78', '?type=movie&sourceId=9001')).status, 404);
        assert.equal((await list(admin)).length, 11);

        // Deletion targets one identity and leaves records sharing the ID.
        assert.equal((await remove(admin, '77')).status, 400, 'Deletion requires the content type');
        assert.equal((await remove(admin, '77', '?type=channel&sourceId=9001')).status, 400);
        assert.equal((await remove(admin, '77', '?type=movie&sourceId=0')).status, 400);
        assert.equal((await remove(admin, '77', '?type=episode&sourceId=9001')).status, 200);
        assert.equal((await remove(admin, '77', '?type=episode&sourceId=9001')).status, 404);
        assert.equal((await remove(admin, 'local-1', '?type=movie')).status, 200);
        assert.equal((await remove(admin, 'local:1', '?type=movie')).status, 200);
        assert.equal((await remove(admin, '501', '?type=episode&sourceId=9001')).status, 200);
        history = await list(admin);
        assert.equal(history.length, 7);
        assert.equal(find(history, { id: 77, type: 'episode', sourceId: 9001 }), undefined);
        assert.equal(find(history, { id: 77, type: 'movie', sourceId: 9001 }).progress, 150);
        assert.equal(find(history, { id: 77, type: 'movie', sourceId: 9002 }).progress, 45);
        assert.equal(find(history, { id: 'local-1', type: 'movie' }), undefined);
        assert.equal(find(history, { id: 'local-1', type: 'movie', sourceId: 9001 }).progress, 70);
        assert.equal(find((await list(viewer)), { id: 77, type: 'movie', sourceId: 9001 }).progress, 999);

        // Restarting runs the migration again without changing current records.
        const storedBeforeRestart = readStoredIds(dataDirectory);
        await stopServer(child);
        await startServer();
        const adminAfterRestart = await login('history-admin', adminPassword);
        assert.deepEqual(readStoredIds(dataDirectory), storedBeforeRestart);
        const progressById = entries => entries.map(entry => [entry.id, entry.progress]).sort();
        assert.deepEqual(progressById(await list(adminAfterRestart)), progressById(history));

        // A legacy record written again by an older release after the upgrade
        // is folded into the current record when it holds newer progress.
        await stopServer(child);
        const db = new Database(path.join(dataDirectory, 'content.db'));
        db.prepare(`
            INSERT INTO watch_history (id, user_id, source_id, item_type, item_id, progress, duration, updated_at, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('1:500', 1, 9001, 'movie', '500', 333, 6000, Date.now() + 60000, JSON.stringify({ title: 'Legacy movie' }));
        db.close();
        await startServer();
        const adminAfterRewrite = await login('history-admin', adminPassword);
        history = await list(adminAfterRewrite);
        assert.equal(history.length, 7);
        assert.equal(find(history, { id: 500, type: 'movie', sourceId: 9001 }).progress, 333);
        assert.ok(!readStoredIds(dataDirectory).includes('1:500'));

        console.log('Watch-history identity regression tests passed.');
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
