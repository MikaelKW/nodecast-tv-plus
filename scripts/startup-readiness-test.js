const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-readiness-'));
process.env.NODECAST_DATA_DIR = directory;
process.env.ALLOW_LOCAL_MEDIA_URLS = 'true';
const database = require('../server/db');
const sqlite = require('../server/db/sqlite');
const { prepareLocalCatalogue, hasUsableCatalogue } = require('../server/services/catalogueReadiness');
const { StartupReadiness } = require('../server/services/startupReadiness');
const { createImportProgress } = require('../server/services/importProgress');
const { fetchWithPolicy } = require('../server/services/outboundSecurity');
const m3uParser = require('../server/services/m3uParser');
const syncService = require('../server/services/syncService');
const { isFatalStorageError } = require('../server/services/storageErrors');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function insertItem(id, sourceId) {
    sqlite.getDb().prepare("INSERT INTO playlist_items(id,source_id,item_id,type,name,data) VALUES(?,?,?,'live','Synthetic','{}')").run(id, sourceId, id);
}

async function migrationAndOwnership() {
    const sources = [1, 2, 3, 4].map(id => ({ id, type: 'm3u', url: `https://example.invalid/${id}`, enabled: true }));
    fs.writeFileSync(path.join(directory, 'db.json'), JSON.stringify({ sources, users: [], settings: {}, nextId: 5 }));
    const db = sqlite.getDb();
    db.prepare("INSERT INTO sync_status VALUES(1,'all',100,'success',NULL),(2,'all',200,'error',NULL),(3,'all',300,'syncing',NULL)").run();
    insertItem('legacy-two', 2);
    insertItem('legacy-three', 3);
    const migrated = await prepareLocalCatalogue();
    assert.deepEqual(migrated[0].catalogueBaseline, { connectionRevision: 0, completedAt: 100 });
    assert.deepEqual(migrated[1].catalogueBaseline, { connectionRevision: 0, assumedUsable: true });
    assert.equal(hasUsableCatalogue(migrated[2]), true);
    assert.equal(hasUsableCatalogue(migrated[3]), false);
    const fresh = await database.sources.create({ type: 'm3u', url: 'https://example.invalid/new' });
    insertItem('new-partial', fresh.id);
    await prepareLocalCatalogue();
    assert.equal(hasUsableCatalogue(await database.sources.getById(fresh.id)), false, 'Legacy inference never repeats for a new partial import');
    assert.equal(await database.sources.recordCatalogueImport(fresh.id, 0), true);
    const completed = await database.sources.getById(fresh.id);
    assert.ok(Number.isFinite(completed.catalogueBaseline.completedAt));
    assert.equal((await database.sources.update(fresh.id, { name: 'Renamed' })).connectionRevision, 0);
    assert.equal((await database.sources.update(fresh.id, { url: fresh.url })).connectionRevision, 0);
    const edited = await database.sources.update(fresh.id, { url: 'https://example.invalid/replacement' });
    assert.equal(edited.connectionRevision, 1);
    assert.equal(hasUsableCatalogue(edited), false);
    assert.equal(await database.sources.recordCatalogueImport(fresh.id, 0), false, 'An old import cannot certify replacement settings');
    const password = randomBytes(24).toString('hex');
    assert.equal((await database.sources.update(fresh.id, { password })).connectionRevision, 2);
    assert.equal((await database.sources.update(fresh.id, { password })).connectionRevision, 2);
    assert.equal(await database.sources.recordCatalogueImport(fresh.id, 2), true);
    const empty = await database.sources.create({ type: 'm3u', url: 'https://example.invalid/empty' });
    await database.sources.recordCatalogueImport(empty.id, 0);
    assert.equal(hasUsableCatalogue(await database.sources.getById(empty.id)), true, 'A completed empty import is usable');
    assert.equal(JSON.stringify((await database.sources.getById(empty.id)).catalogueBaseline).includes('password'), false);
}

function fakeSync() {
    let observer;
    let count = 0;
    return {
        subscribeCatalogueReadiness(listener) { observer = listener; return () => { observer = null; }; },
        syncAll(options) { this.options = options; count++; return new Promise(() => {}); },
        emit(event) { observer?.(event); },
        calls() { return count; }
    };
}

async function stateTransitions() {
    const sync = fakeSync();
    const first = { id: 1, type: 'm3u', enabled: true };
    const cached = { id: 2, type: 'xtream', enabled: true, catalogueBaseline: { connectionRevision: 0, assumedUsable: true } };
    const guide = { id: 3, type: 'epg', enabled: true };
    const service = new StartupReadiness({ waitMs: 20, prepare: async () => [first, cached, guide] });
    await service.initialize(sync);
    assert.deepEqual([...sync.options.initialImportIds], [1]);
    assert.equal(service.state, 'starting');
    sync.emit({ kind: 'catalogue', sourceId: 1, connectionRevision: 9 });
    assert.equal(service.state, 'starting');
    await delay(40);
    assert.equal(service.state, 'degraded');
    assert.equal(sync.calls(), 1, 'Waiting expiry does not launch or cancel an import');
    sync.emit({ kind: 'catalogue', sourceId: 1, connectionRevision: 0 });
    assert.equal(service.state, 'ready', 'The original continuing import can complete after the waiting deadline');
    service.stop();
    const cachedOnly = new StartupReadiness({ prepare: async () => [cached, guide] });
    await cachedOnly.initialize(fakeSync());
    assert.equal(cachedOnly.state, 'ready');
    cachedOnly.stop();
    const failed = new StartupReadiness({ prepare: async () => { throw Object.assign(new Error('Synthetic storage failure'), { code: 'EIO' }); } });
    await failed.initialize(fakeSync());
    assert.equal(failed.state, 'failed');
    assert.equal(failed.canUseApplication(), false);
    const unavailableSync = fakeSync();
    const unavailable = new StartupReadiness({ prepare: async () => [first] });
    await unavailable.initialize(unavailableSync);
    unavailableSync.emit({ kind: 'failure', sourceId: 1, connectionRevision: 0 });
    assert.equal(unavailable.state, 'degraded');
    unavailable.stop();
    const noSources = new StartupReadiness({ prepare: async () => [] });
    await noSources.initialize(fakeSync());
    assert.equal(noSources.state, 'ready');
    noSources.stop();
    assert.deepEqual(noSources.snapshot(), { state: 'starting' }, 'A normal stop does not advertise a failed startup');
    assert.equal(noSources.canUseApplication(), false);
    for (const code of ['SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_NOTNULL', 'SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'SQLITE_MISMATCH', 'SQLITE_TOOBIG']) {
        assert.equal(isFatalStorageError({ code }), false, `${code} is not proof of broken storage`);
    }
    for (const code of ['SQLITE_FULL', 'SQLITE_READONLY', 'SQLITE_READONLY_DBMOVED', 'SQLITE_IOERR_WRITE', 'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_CANTOPEN', 'SQLITE_PERM', 'EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'EROFS', 'EIO', 'ENOENT']) {
        assert.equal(isFatalStorageError({ code }), true, `${code} is a storage failure`);
    }
    for (const code of ['EACCES', 'EPERM', 'ENOENT']) {
        assert.equal(isFatalStorageError({ code, syscall: 'connect' }), false, `${code} connecting to a provider is recoverable`);
        for (const syscall of ['open', 'stat', 'mkdir', 'rename', 'write']) {
            assert.equal(isFatalStorageError({ code, syscall }), true, `${code} during ${syscall} remains a storage failure`);
        }
    }
    for (const code of ['SQLITE_CORRUPT', 'SQLITE_READONLY', 'SQLITE_FULL']) {
        assert.equal(isFatalStorageError({ code, syscall: 'connect' }), true, 'The connection exclusion is limited to the three ambiguous system codes');
    }
}

async function progressAndStreams() {
    const active = createImportProgress({ inactivityMs: 60 });
    for (let i = 0; i < 6; i++) { await delay(15); active.check(); }
    assert.equal(active.signal.aborted, false, 'Working imports can exceed an individual inactivity period');
    await delay(90);
    assert.equal(active.signal.reason.code, 'PROVIDER_INACTIVE');
    active.dispose();
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        if (req.url === '/gzip-active') {
            const compressed = require('node:zlib').gzipSync('[]');
            res.writeHead(200, { 'Content-Encoding': 'gzip' });
            let index = 0;
            const timer = setInterval(() => {
                res.write(compressed.subarray(index, ++index));
                if (index === compressed.length) { clearInterval(timer); res.end(); }
            }, 20);
            res.once('close', () => clearInterval(timer));
            return;
        }
        if (req.url === '/headers') return;
        if (req.url === '/gzip') res.writeHead(200, { 'Content-Encoding': 'gzip' });
        else res.writeHead(200);
        res.flushHeaders();
        if (req.url === '/m3u') res.write('#EXTM3U\n');
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const receiving = createImportProgress({ inactivityMs: 80 });
        const working = await fetchWithPolicy(base + '/gzip-active', { signal: receiving.signal, onProgress: receiving.touch }, { allowPrivateHosts: [base] });
        assert.deepEqual(await working.json(), [], 'Raw compressed network progress prevents a false inactivity timeout');
        receiving.dispose();
        for (const suffix of ['/headers', '/body', '/gzip', '/m3u']) {
            const progress = createImportProgress({ inactivityMs: 80 });
            const operation = suffix === '/m3u' ? (async () => {
                for await (const _batch of m3uParser.fetchAndParseStreaming(base + suffix, 500, progress)) { /* no completed feed */ }
            })() : (async () => {
                const response = await fetchWithPolicy(base + suffix, { signal: progress.signal, onProgress: progress.touch }, { allowPrivateHosts: [base] });
                await response.text();
            })();
            await assert.rejects(operation);
            progress.dispose();
        }
        await delay(50);
        // A healthy response can retain an idle keep-alive socket. Stalled
        // responses must be destroyed rather than remain in-flight.
        assert.ok(sockets.size <= 1, 'Timed-out initial imports release actual provider sockets');
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

async function serverBoundary() {
    const data = path.join(directory, 'http');
    fs.mkdirSync(data);
    const preload = path.join(directory, 'hold.cjs');
    const readinessPath = require.resolve('../server/services/startupReadiness');
    fs.writeFileSync(preload, `const http = require('node:http'); const listen = http.Server.prototype.listen; http.Server.prototype.listen = function(...args) { this.once('listening', () => process.send({ port: this.address().port })); return listen.apply(this, args); }; const service = require(${JSON.stringify(readinessPath)}); const prepare = service.prepare; service.prepare = () => new Promise(resolve => process.once('message', async message => { if (message === 'prepare') resolve(await prepare()); })); process.on('message', message => { if (message === 'fatal-storage') { service.fail(); process.send(service.snapshot()); } });`);
    const child = spawn(process.execPath, ['-r', preload, 'server/index.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: '0', NODECAST_DATA_DIR: data, NODECAST_BASE_PATH: '/tv', NODECAST_DISABLE_BACKGROUND_JOBS: 'true', JWT_SECRET: randomBytes(48).toString('hex'), SESSION_SECRET: randomBytes(48).toString('hex') },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    // The test preload exposes only the disposable listener's selected port.
    child.stdout.resume();
    child.stderr.resume();
    try {
        // Use an OS-selected port reported by a test-only listen observer.
        const { port } = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('HTTP startup test timed out')), 10000);
            child.once('message', message => { clearTimeout(timer); resolve(message); });
        });
        const base = `http://127.0.0.1:${port}/tv/api`;
        let statusCalls = 0;
        async function request(endpoint, options = {}) {
            if (endpoint === '/startup') statusCalls++;
            return fetch(base + endpoint, { ...options, signal: AbortSignal.timeout(3000) });
        }
        for (let i = 0; i < 40; i++) {
            if ((await request('/health')).status === 200) break;
            await delay(50);
        }
        assert.equal((await request('/health')).status, 200, 'Health is available while required readiness work is still held');
        assert.deepEqual(await (await request('/startup')).json(), { state: 'starting' });
        for (const [method, endpoint] of [
            ['POST', '/auth/setup'], ['POST', '/auth/login'], ['POST', '/auth/2fa/verify'],
            ['GET', '/auth/oidc/login'], ['GET', '/auth/session'], ['GET', '/settings']
        ]) {
            const response = await request(endpoint, { method });
            assert.equal(response.status, 503, endpoint);
            assert.equal((await response.json()).code, 'APPLICATION_STARTING');
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.ok(Number(response.headers.get('retry-after')) > 0);
            assert.equal(response.headers.get('set-cookie'), null);
        }
        const callback = await request('/auth/oidc/callback');
        assert.equal(callback.status, 503);
        assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
        assert.match(await callback.text(), /href="\/tv\/login.html"/);
        assert.equal((await request('/auth/logout', { method: 'POST' })).status, 200);
        child.send('prepare');
        for (let i = 0; i < 40; i++) {
            if ((await (await request('/startup')).json()).state === 'ready') break;
            await delay(50);
        }
        assert.deepEqual(await (await request('/startup')).json(), { state: 'ready' });
        const password = randomBytes(24).toString('hex');
        const setup = await request('/auth/setup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'readiness-test', password, passwordConfirmation: password })
        });
        assert.equal(setup.status, 201);
        const cookie = setup.headers.get('set-cookie').split(';', 1)[0];
        assert.equal((await request('/auth/me', { headers: { Cookie: cookie } })).status, 200);
        assert.equal((await request('/settings')).status, 401);
        while (statusCalls < 600) assert.equal((await request('/startup')).status, 200);
        const limited = await request('/startup');
        assert.equal(limited.status, 429);
        assert.ok(Number(limited.headers.get('retry-after')) > 0);
        assert.equal(limited.headers.get('cache-control'), 'no-store');
        assert.equal((await request('/auth/session')).status, 200);
        const failureState = new Promise(resolve => child.once('message', resolve));
        child.send('fatal-storage');
        assert.deepEqual(await failureState, { state: 'failed' });
        assert.equal((await request('/health')).status, 503, 'A failed readiness state cannot remain healthy');
        const failedAuth = await request('/auth/me', { headers: { Cookie: cookie } });
        assert.equal(failedAuth.status, 503);
        assert.equal(failedAuth.headers.get('set-cookie'), null);
    } finally {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
    }
}

async function actualImports() {
    let finishGuide;
    let guideStarted = false;
    let serveWorking = false;
    let providerClosed = false;
    let catalogueRequests = 0;
    let malformed = false;
    const provider = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://example.invalid');
        if (url.pathname === '/player_api.php') {
            catalogueRequests++;
            return res.end(JSON.stringify(malformed && url.searchParams.get('action') === 'get_live_categories' ? [{}] : []));
        }
        if (url.pathname === '/xmltv.php') {
            guideStarted = true;
            res.writeHead(200); res.flushHeaders();
            finishGuide = () => res.end('<?xml version="1.0"?><tv></tv>');
            return;
        }
        res.writeHead(200);
        if (serveWorking) return res.end('#EXTM3U\n');
        res.write('#EXTM3U\n');
        res.on('close', () => { providerClosed = true; });
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${provider.address().port}`;
    const service = new syncService.SyncService({ createProgress: () => createImportProgress({ inactivityMs: 80 }) });
    try {
        const xtream = await database.sources.create({ type: 'xtream', url: base, username: 'synthetic', password: randomBytes(16).toString('hex') });
        let settled = false;
        const refresh = service.syncSource(xtream.id, { initialImport: true }).then(result => { settled = true; return result; });
        for (let i = 0; i < 100 && !guideStarted; i++) await delay(10);
        assert.equal(guideStarted, true);
        assert.equal(hasUsableCatalogue(await database.sources.getById(xtream.id)), true, 'Xtream catalogue readiness precedes its optional guide');
        await delay(120);
        assert.equal(settled, false);
        finishGuide();
        assert.equal((await refresh).status, 'success');

        // Exercise the startup-deferred guide, not the already locked normal
        // Xtream path. A manual refresh must not start a second catalogue job.
        guideStarted = false;
        const getAll = database.sources.getAll;
        let startupRefresh;
        try {
            database.sources.getAll = async () => [await database.sources.getById(xtream.id)];
            startupRefresh = service.syncAll({ startup: true });
            for (let i = 0; i < 100 && !guideStarted; i++) await delay(10);
            assert.equal(guideStarted, true);
            const requestsBefore = catalogueRequests;
            assert.equal(await service.syncSource(xtream.id), undefined, 'Deferred guide owns the source-wide lock');
            assert.equal(catalogueRequests, requestsBefore, 'A duplicate refresh cannot download another catalogue');
        } finally {
            database.sources.getAll = getAll;
            finishGuide?.();
            await startupRefresh;
        }
        // Both normal completion and failure must release the deferred lock.
        const originalGuide = service.syncEpgFromUrl;
        try {
            service.syncEpgFromUrl = async () => { throw new Error('Synthetic guide failure'); };
            await assert.rejects(service.syncDeferredGuide(xtream.id, 0), /Synthetic guide failure/);
        } finally { service.syncEpgFromUrl = originalGuide; }
        assert.equal((await service.syncSource(xtream.id, { skipGuide: true })).status, 'success');

        malformed = true;
        const bad = await database.sources.create({ type: 'xtream', url: base, username: 'synthetic', password: randomBytes(16).toString('hex') });
        const badReadiness = new StartupReadiness({ prepare: async () => [bad] });
        await badReadiness.initialize({
            subscribeCatalogueReadiness: listener => service.subscribeCatalogueReadiness(listener),
            syncAll: () => service.syncSource(bad.id, { initialImport: true })
        });
        const malformedResult = await badReadiness.backgroundSync;
        assert.equal(malformedResult.status, 'error');
        assert.equal(badReadiness.state, 'degraded', 'A real provider-generated NOT NULL constraint must not lock sign-in');
        assert.equal(badReadiness.canUseApplication(), true);
        assert.equal(sqlite.getDb().prepare('SELECT 1 AS healthy').get().healthy, 1);
        badReadiness.stop();
        malformed = false;

        // Inject native ClientRequest connection errors in this test process
        // without changing firewall rules or requiring restricted networking.
        const originalRequest = http.request;
        try {
            for (const code of ['EACCES', 'EPERM', 'ENOENT']) {
                http.request = function(...args) {
                    const request = originalRequest.apply(this, args);
                    if (args[0].pathname === '/blocked/player_api.php') {
                        queueMicrotask(() => request.destroy(Object.assign(new Error('Synthetic blocked connection'), { code, syscall: 'connect' })));
                    }
                    return request;
                };
                const blocked = await database.sources.create({ type: 'xtream', url: base + '/blocked' });
                const readiness = new StartupReadiness({ prepare: async () => [blocked] });
                try {
                    await readiness.initialize({
                        subscribeCatalogueReadiness: listener => service.subscribeCatalogueReadiness(listener),
                        syncAll: () => service.syncSource(blocked.id, { initialImport: true })
                    });
                    assert.equal((await readiness.backgroundSync).status, 'error');
                    assert.equal(readiness.state, 'degraded', `${code} from connect must not lock sign-in`);
                    assert.equal(readiness.canUseApplication(), true);
                } finally { readiness.stop(); }
            }
        } finally { http.request = originalRequest; }

        // The existing DNS boundary already converts resolver errors into an
        // ordinary provider error before storage classification is reached.
        const dns = require('node:dns').promises;
        const originalLookup = dns.lookup;
        try {
            for (const code of ['EACCES', 'EPERM', 'ENOENT']) {
                dns.lookup = async () => { throw Object.assign(new Error('Synthetic lookup failure'), { code, syscall: 'getaddrinfo' }); };
                await assert.rejects(fetchWithPolicy('http://synthetic.example.invalid/playlist'), error => (
                    error.statusCode === 502 && !isFatalStorageError(error)
                ));
            }
        } finally { dns.lookup = originalLookup; }

        // Reproduce real transient writer contention without changing the app
        // or exhausting the disk. WAL readers remain usable during this lock.
        const busy = await database.sources.create({ type: 'xtream', url: base });
        const busyReadiness = new StartupReadiness({ prepare: async () => [busy] });
        const Database = require('better-sqlite3');
        const writer = new Database(path.join(directory, 'content.db'));
        const previousTimeout = sqlite.getDb().pragma('busy_timeout', { simple: true });
        try {
            sqlite.getDb().pragma('busy_timeout = 0');
            writer.exec('BEGIN IMMEDIATE');
            await busyReadiness.initialize({
                subscribeCatalogueReadiness: listener => service.subscribeCatalogueReadiness(listener),
                syncAll: () => service.syncSource(busy.id, { initialImport: true })
            });
            await assert.rejects(busyReadiness.backgroundSync, error => error.code === 'SQLITE_BUSY');
            assert.equal(busyReadiness.state, 'degraded', 'Temporary database contention is not permanent startup failure');
            assert.equal(sqlite.getDb().prepare('SELECT 1 AS healthy').get().healthy, 1);
        } finally {
            writer.exec('ROLLBACK');
            writer.close();
            sqlite.getDb().pragma(`busy_timeout = ${previousTimeout}`);
            busyReadiness.stop();
        }
        const stalled = await database.sources.create({ type: 'm3u', url: base + '/stall' });
        insertItem('retained-after-stall', stalled.id);
        assert.equal((await service.syncSource(stalled.id, { initialImport: true })).status, 'error');
        assert.equal(hasUsableCatalogue(await database.sources.getById(stalled.id)), false);
        assert.ok(sqlite.getDb().prepare('SELECT 1 FROM playlist_items WHERE id=?').get('retained-after-stall'), 'Interrupted imports do not purge saved items');
        await delay(30);
        assert.equal(providerClosed, true);
        serveWorking = true;
        assert.equal((await service.syncSource(stalled.id, { initialImport: true })).status, 'success', 'Cancellation releases the actual source lock for a later retry');
        assert.equal(hasUsableCatalogue(await database.sources.getById(stalled.id)), true);
    } finally {
        provider.closeAllConnections();
        await new Promise(resolve => provider.close(resolve));
    }
    const originalGetAll = database.sources.getAll;
    const originalGetById = database.sources.getById;
    const order = [];
    const fakeSources = [
        { id: 11, type: 'xtream', enabled: true, url: 'https://example.invalid' },
        { id: 12, type: 'epg', enabled: true },
        { id: 10, type: 'xtream', enabled: true, url: 'https://example.invalid' }
    ];
    try {
        database.sources.getAll = async () => [...fakeSources];
        database.sources.getById = async id => fakeSources.find(source => source.id === id);
        service.syncSource = async (id, options) => {
            assert.equal(options.skipGuide, true);
            order.push(`sync:${id}`);
            return { status: 'success', connectionRevision: 0 };
        };
        service.syncEpgFromUrl = async id => { order.push(`guide:${id}`); };
        await service.syncAll({ startup: true, initialImportIds: new Set([10]) });
        assert.deepEqual(order, ['sync:10', 'sync:11', 'sync:12', 'guide:10', 'guide:11']);
    } finally {
        database.sources.getAll = originalGetAll;
        database.sources.getById = originalGetById;
    }
}

(async () => {
    try {
        await migrationAndOwnership();
        await stateTransitions();
        await progressAndStreams();
        await actualImports();
        await serverBoundary();
        console.log('Startup readiness migration, ownership, bounded waiting, retained jobs and real provider inactivity tests passed.');
    } finally {
        sqlite.getDb().close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
