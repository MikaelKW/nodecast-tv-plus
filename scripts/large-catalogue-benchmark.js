const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const { spawn } = require('node:child_process');
const { chromium } = require('@playwright/test');

const projectRoot = path.join(__dirname, '..');
const sourceId = 1;
const channelCount = Number.parseInt(process.env.NODECAST_BENCHMARK_CHANNELS || '300000', 10);
const categoryCount = Number.parseInt(process.env.NODECAST_BENCHMARK_CATEGORIES || '600', 10);
const lastChannelName = `Synthetic Channel ${String(channelCount - 1).padStart(6, '0')}`;

function elapsed(started) {
    return Number((performance.now() - started).toFixed(1));
}

function heapMb() {
    return Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1));
}

function collectHeap() {
    if (typeof global.gc === 'function') global.gc();
    return heapMb();
}

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

async function waitForServer(baseUrl, child, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited before becoming ready (code ${child.exitCode}).`);
        }
        try {
            const response = await fetch(`${baseUrl}/api/health`);
            if (response.ok) return;
        } catch {
            // The server may still be starting.
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Server did not become ready within ${timeoutMs}ms.`);
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

async function startServer(dataDirectory) {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let output = '';
    const child = spawn(process.execPath, [
        '--expose-gc',
        '--require',
        path.join(projectRoot, 'scripts', 'benchmark-process-metrics-hook.js'),
        'server/index.js'
    ], {
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
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    const pendingMemoryRequests = new Map();
    child.on('message', message => {
        if (message?.type !== 'benchmark-memory-response') return;
        const resolve = pendingMemoryRequests.get(message.requestId);
        if (!resolve) return;
        pendingMemoryRequests.delete(message.requestId);
        resolve(message.memory);
    });
    const getMemory = () => new Promise((resolve, reject) => {
        const requestId = crypto.randomBytes(8).toString('hex');
        const timeout = setTimeout(() => {
            pendingMemoryRequests.delete(requestId);
            reject(new Error('Timed out while sampling benchmark server memory.'));
        }, 5000);
        pendingMemoryRequests.set(requestId, memory => {
            clearTimeout(timeout);
            resolve(memory);
        });
        child.send({ type: 'benchmark-memory-request', requestId }, error => {
            if (!error) return;
            clearTimeout(timeout);
            pendingMemoryRequests.delete(requestId);
            reject(error);
        });
    });
    await waitForServer(baseUrl, child);
    return { baseUrl, child, getMemory, getOutput: () => output };
}

async function measureServerMemory(server, operation) {
    const baseline = await server.getMemory();
    let peak = baseline;
    let sampling = true;
    const updatePeak = memory => {
        if (memory.rss > peak.rss) peak = memory;
    };
    const sampler = (async () => {
        while (sampling) {
            try {
                updatePeak(await server.getMemory());
            } catch {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 40));
        }
    })();
    try {
        const result = await operation();
        updatePeak(await server.getMemory());
        return {
            result,
            memory: {
                baselineRssMb: Number((baseline.rss / 1024 / 1024).toFixed(1)),
                peakRssMb: Number((peak.rss / 1024 / 1024).toFixed(1)),
                peakHeapMb: Number((peak.heapUsed / 1024 / 1024).toFixed(1))
            }
        };
    } finally {
        sampling = false;
        await sampler;
    }
}

async function seedSourceFile(dataDirectory) {
    const now = new Date().toISOString();
    const data = {
        sources: [{
            id: sourceId,
            name: 'Synthetic Large Catalogue',
            type: 'm3u',
            url: 'http://127.0.0.1/benchmark.m3u',
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
    };
    await fs.writeFile(path.join(dataDirectory, 'db.json'), JSON.stringify(data));
}

function seedCatalogue(dataDirectory) {
    process.env.NODECAST_DATA_DIR = dataDirectory;
    const { getDb } = require('../server/db/sqlite');
    const db = getDb();
    const insertCategory = db.prepare(`
        INSERT INTO categories
            (id, source_id, category_id, type, name, is_hidden, data)
        VALUES (?, ?, ?, 'live', ?, 0, ?)
    `);
    const insertChannel = db.prepare(`
        INSERT INTO playlist_items
            (id, source_id, item_id, type, name, category_id, stream_icon,
             stream_url, container_extension, added_at, is_hidden, data)
        VALUES (?, ?, ?, 'live', ?, ?, ?, ?, 'ts', ?, 0, ?)
    `);
    const started = performance.now();
    db.transaction(() => {
        for (let categoryIndex = 0; categoryIndex < categoryCount; categoryIndex += 1) {
            const categoryId = `group-${String(categoryIndex).padStart(4, '0')}`;
            insertCategory.run(
                `${sourceId}:${categoryId}`,
                sourceId,
                categoryId,
                `Synthetic Group ${String(categoryIndex).padStart(4, '0')}`,
                '{}'
            );
        }
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            const itemId = `channel-${String(channelIndex).padStart(6, '0')}`;
            const categoryId = `group-${String(channelIndex % categoryCount).padStart(4, '0')}`;
            insertChannel.run(
                `${sourceId}:${itemId}`,
                sourceId,
                itemId,
                `Synthetic Channel ${String(channelIndex).padStart(6, '0')}`,
                categoryId,
                `https://images.invalid/${itemId}.png`,
                `http://streams.invalid/${itemId}.ts`,
                '2026-01-01T00:00:00.000Z',
                JSON.stringify({ tvgId: `epg-${itemId}`, generated: true })
            );
        }
    })();
    return { db, seedMs: elapsed(started) };
}

function measureCurrentServerPipeline(db) {
    const baselineHeapMb = collectHeap();
    const countQuery = `
        SELECT COUNT(*) AS count
        FROM playlist_items
        WHERE source_id = ? AND type = ? AND is_hidden = 0
    `;
    const correlatedCountQuery = `${countQuery.trim().replace(/;$/, '')}
          AND NOT EXISTS (
              SELECT 1 FROM categories c
              WHERE c.source_id = playlist_items.source_id
                AND c.type = playlist_items.type
                AND c.category_id = playlist_items.category_id
                AND c.is_hidden = 1
          )`;
    const joinedCountQuery = `
        SELECT COUNT(*) AS count
        FROM playlist_items p
        LEFT JOIN categories c
          ON c.source_id = p.source_id
         AND c.type = p.type
         AND c.category_id = p.category_id
        WHERE p.source_id = ? AND p.type = ? AND p.is_hidden = 0
          AND COALESCE(c.is_hidden, 0) = 0
    `;
    const measureCount = sql => {
        const started = performance.now();
        const result = db.prepare(sql).get(sourceId, 'live');
        return { count: result.count, ms: elapsed(started) };
    };
    const counts = {
        direct: measureCount(countQuery),
        correlatedVisibility: measureCount(correlatedCountQuery),
        joinedVisibility: measureCount(joinedCountQuery)
    };
    const query = `
        SELECT item_id, name, stream_icon, added_at, rating,
               container_extension, year, category_id, is_hidden, data
        FROM playlist_items
        WHERE source_id = ? AND type = ? AND is_hidden = 0
          AND NOT EXISTS (
              SELECT 1 FROM categories c
              WHERE c.source_id = playlist_items.source_id
                AND c.type = playlist_items.type
                AND c.category_id = playlist_items.category_id
                AND c.is_hidden = 1
          )
    `;
    const queryPlan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(sourceId, 'live');

    let started = performance.now();
    let rows = db.prepare(query).all(sourceId, 'live');
    const sqliteMs = elapsed(started);
    const rowsHeapMb = heapMb();

    started = performance.now();
    let streams = rows.map(item => {
        const data = JSON.parse(item.data || '{}');
        return {
            ...data,
            stream_id: item.item_id,
            series_id: undefined,
            name: item.name,
            stream_icon: item.stream_icon,
            cover: item.stream_icon,
            added: item.added_at,
            rating: item.rating,
            container_extension: item.container_extension,
            category_id: item.category_id,
            is_hidden: item.is_hidden,
            epg_channel_id: data.epg_channel_id || data.tvgId || null
        };
    });
    const serverMapMs = elapsed(started);
    const mappedHeapMb = heapMb();

    started = performance.now();
    let json = JSON.stringify(streams);
    const stringifyMs = elapsed(started);
    const jsonHeapMb = heapMb();
    const jsonBytes = Buffer.byteLength(json);

    started = performance.now();
    const gzipBytes = zlib.gzipSync(json).length;
    const gzipMs = elapsed(started);

    started = performance.now();
    let parsed = JSON.parse(json);
    const clientParseMs = elapsed(started);
    const parsedHeapMb = heapMb();

    started = performance.now();
    let channels = parsed.map(stream => ({
        id: `m3u_${sourceId}_${stream.stream_id}`,
        streamId: stream.stream_id,
        name: stream.name,
        tvgId: stream.epg_channel_id,
        tvgLogo: stream.stream_icon,
        url: stream.stream_url,
        groupId: `m3u_${sourceId}_${stream.category_id}`,
        groupTitle: stream.category_id || 'Uncategorized',
        sourceId,
        sourceType: 'm3u'
    }));
    const clientMapMs = elapsed(started);
    const clientMappedHeapMb = heapMb();

    started = performance.now();
    const groupedChannels = {};
    for (const channel of channels) {
        const groupKey = channel.groupTitle || 'Uncategorized';
        (groupedChannels[groupKey] ||= []).push(channel);
    }
    const sortedGroups = Object.keys(groupedChannels).sort((a, b) => a.localeCompare(b));
    const groupMs = elapsed(started);

    started = performance.now();
    const normalizedSearch = lastChannelName.toLowerCase();
    const rareMatches = channels.filter(channel =>
        channel.name.toLowerCase().includes(normalizedSearch)
        || channel.groupTitle.toLowerCase().includes(normalizedSearch)
    );
    const searchMs = elapsed(started);

    const metrics = {
        baselineHeapMb,
        sqliteMs,
        rowsHeapMb,
        serverMapMs,
        mappedHeapMb,
        stringifyMs,
        jsonHeapMb,
        jsonBytes,
        gzipMs,
        gzipBytes,
        compressionRatio: Number((jsonBytes / gzipBytes).toFixed(1)),
        clientParseMs,
        parsedHeapMb,
        clientMapMs,
        clientMappedHeapMb,
        groupMs,
        groupCount: sortedGroups.length,
        searchMs,
        searchMatches: rareMatches.length,
        counts,
        queryPlan: queryPlan.map(row => row.detail)
    };

    rows = null;
    streams = null;
    json = null;
    parsed = null;
    channels = null;
    collectHeap();
    return metrics;
}

function requestCompressedJson(url, cookie) {
    return new Promise((resolve, reject) => {
        const started = performance.now();
        const request = http.get(url, {
            headers: {
                Accept: 'application/json',
                'Accept-Encoding': 'gzip',
                Cookie: cookie
            }
        }, response => {
            const headersMs = elapsed(started);
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                try {
                    assert.equal(response.statusCode, 200);
                    const compressed = Buffer.concat(chunks);
                    const body = response.headers['content-encoding'] === 'gzip'
                        ? zlib.gunzipSync(compressed)
                        : compressed;
                    const parseStarted = performance.now();
                    const data = JSON.parse(body.toString('utf8'));
                    resolve({
                        data,
                        headersMs,
                        completeMs: elapsed(started),
                        parseMs: elapsed(parseStarted),
                        compressedBytes: compressed.length,
                        uncompressedBytes: body.length,
                        contentEncoding: response.headers['content-encoding'] || 'identity'
                    });
                } catch (error) {
                    reject(error);
                }
            });
        });
        request.on('error', reject);
    });
}

async function setupSession(baseUrl) {
    const password = crypto.randomBytes(24).toString('base64url');
    const response = await fetch(`${baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: 'BenchmarkAdmin',
            password,
            passwordConfirmation: password
        })
    });
    assert.equal(response.status, 201);
    const cookie = (response.headers.get('set-cookie') || '').split(';', 1)[0];
    assert.ok(cookie);
    return cookie;
}

async function seedFavorites(baseUrl, cookie, count = 12) {
    for (let index = 0; index < count; index += 1) {
        const itemId = `channel-${String(index).padStart(6, '0')}`;
        const response = await fetch(`${baseUrl}/api/favorites`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ sourceId, itemId, itemType: 'channel' })
        });
        assert.equal(response.status, 200);
    }
}

async function measureHomeBrowser(baseUrl, cookie, expectedFavorites = 12) {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext();
        const parsedBase = new URL(baseUrl);
        const [name, value] = cookie.split('=', 2);
        await context.addCookies([{
            name,
            value,
            domain: parsedBase.hostname,
            path: '/',
            httpOnly: true,
            sameSite: 'Lax'
        }]);
        const page = await context.newPage();
        page.setDefaultTimeout(30000);
        let fullLiveCatalogueRequests = 0;
        page.on('request', request => {
            if (new URL(request.url()).pathname.endsWith('/live_streams')) {
                fullLiveCatalogueRequests += 1;
            }
        });

        const started = performance.now();
        await page.goto(`${baseUrl}/#home`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(expected => (
            document.querySelectorAll('#favorite-channels-list .channel-tile').length === expected
        ), expectedFavorites);
        const readyMs = elapsed(started);
        const state = await page.evaluate(() => ({
            favoriteTiles: document.querySelectorAll('#favorite-channels-list .channel-tile').length,
            liveChannelsMaterialized: window.app?.channelList?.channels?.length || 0,
            domNodes: document.getElementsByTagName('*').length,
            heapMb: performance.memory
                ? Number((performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1))
                : null
        }));

        return { readyMs, fullLiveCatalogueRequests, ...state };
    } finally {
        await browser.close();
    }
}

async function measureBrowser(baseUrl, cookie) {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext();
        const parsedBase = new URL(baseUrl);
        const [name, value] = cookie.split('=', 2);
        await context.addCookies([{
            name,
            value,
            domain: parsedBase.hostname,
            path: '/',
            httpOnly: true,
            sameSite: 'Lax'
        }]);
        const page = await context.newPage();
        page.setDefaultTimeout(180000);
        let fullLiveCatalogueRequests = 0;
        page.on('request', request => {
            if (new URL(request.url()).pathname.endsWith('/live_streams')) {
                fullLiveCatalogueRequests += 1;
            }
        });
        const started = performance.now();
        await page.goto(`${baseUrl}/#live`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(expectedGroups => (
            window.app?.currentPage === 'live'
            && window.app?.channelList?.isLoading === false
            && window.app?.channelList?.isCatalogueReady === true
            && window.app?.channelList?.boundedGroups?.length === expectedGroups
        ), categoryCount);
        const coldLoadMs = elapsed(started);
        const initialState = await page.evaluate(() => ({
            materializedChannels: window.app.channelList.channels.length,
            groups: window.app.channelList.boundedGroups?.length || 0,
            renderedChannels: window.app.channelList.renderedChannels?.length || 0,
            domNodes: document.getElementsByTagName('*').length,
            heapMb: performance.memory
                ? Number((performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1))
                : null
        }));
        assert.ok(initialState.materializedChannels <= 100);

        const groupLoadStarted = performance.now();
        await page.locator('.group-header:not(.favorites-group)').first().click();
        await page.waitForFunction(() => (
            [...window.app.channelList.boundedGroupPages.values()]
                .some(state => state.channels.length === 100 && state.loading === false)
        ));
        const groupLoadMs = elapsed(groupLoadStarted);
        const loadedGroupState = await page.evaluate(() => ({
            materializedChannels: window.app.channelList.channels.length,
            renderedChannels: window.app.channelList.renderedChannels.length,
            domNodes: document.getElementsByTagName('*').length
        }));
        assert.ok(loadedGroupState.materializedChannels <= 200);

        const reloadStarted = performance.now();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(expectedGroups => (
            window.app?.currentPage === 'live'
            && window.app?.channelList?.isLoading === false
            && window.app?.channelList?.isCatalogueReady === true
            && window.app?.channelList?.boundedGroups?.length === expectedGroups
        ), categoryCount);
        const reloadMs = elapsed(reloadStarted);
        const reloadHeapMb = await page.evaluate(() => performance.memory
            ? Number((performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1))
            : null);

        const searchStarted = performance.now();
        await page.locator('#channel-search').fill(lastChannelName);
        await page.waitForFunction(() => (
            window.app?.channelList?.isLoading === false
            && window.app?.channelList?.boundedSearchResults?.length === 1
        ));
        const searchMs = elapsed(searchStarted);
        return {
            coldLoadMs,
            groupLoadMs,
            reloadMs,
            reloadHeapMb,
            searchMs,
            fullLiveCatalogueRequests,
            initialState,
            loadedGroupState
        };
    } finally {
        await browser.close();
    }
}

async function run() {
    assert.ok(Number.isSafeInteger(channelCount) && channelCount > 0, 'Invalid channel count.');
    assert.ok(Number.isSafeInteger(categoryCount) && categoryCount > 0, 'Invalid category count.');
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-large-catalogue-'));
    const dataDirectory = path.join(testRoot, 'data');
    await fs.mkdir(dataDirectory, { recursive: true });
    let server;

    try {
        await seedSourceFile(dataDirectory);
        const seeded = seedCatalogue(dataDirectory);
        const direct = measureCurrentServerPipeline(seeded.db);
        seeded.db.close();
        const databaseBytes = (await fs.stat(path.join(dataDirectory, 'content.db'))).size;

        server = await startServer(dataDirectory);
        const cookie = await setupSession(server.baseUrl);
        await seedFavorites(server.baseUrl, cookie);
        const favoriteMeasurement = await measureServerMemory(server, () =>
            requestCompressedJson(
                `${server.baseUrl}/api/favorites/channels`,
                cookie
            )
        );
        const favoriteChannels = favoriteMeasurement.result;
        assert.equal(favoriteChannels.data.length, 12);
        favoriteChannels.data = null;

        let home;
        try {
            const homeMeasurement = await measureServerMemory(server, () =>
                measureHomeBrowser(server.baseUrl, cookie)
            );
            home = {
                ...homeMeasurement.result,
                serverMemory: homeMeasurement.memory
            };
        } catch (error) {
            home = { error: error.message };
        }

        const summaryMeasurement = await measureServerMemory(server, () =>
            requestCompressedJson(
                `${server.baseUrl}/api/proxy/catalogue/${sourceId}/live/summary`,
                cookie
            )
        );
        const catalogueSummary = summaryMeasurement.result;
        assert.equal(catalogueSummary.data.totalChannels, channelCount);
        assert.equal(catalogueSummary.data.groups.length, categoryCount);
        catalogueSummary.data = null;

        const pageMeasurement = await measureServerMemory(server, () =>
            requestCompressedJson(
                `${server.baseUrl}/api/proxy/catalogue/${sourceId}/live/channels?limit=100`,
                cookie
            )
        );
        const cataloguePage = pageMeasurement.result;
        assert.equal(cataloguePage.data.items.length, 100);
        assert.equal(cataloguePage.data.hasMore, true);
        assert.ok(cataloguePage.data.nextCursor);
        cataloguePage.data = null;

        const searchMeasurement = await measureServerMemory(server, () =>
            requestCompressedJson(
                `${server.baseUrl}/api/proxy/catalogue/${sourceId}/live/channels?limit=100&query=${encodeURIComponent(lastChannelName)}`,
                cookie
            )
        );
        const catalogueSearch = searchMeasurement.result;
        assert.equal(catalogueSearch.data.items.length, 1);
        catalogueSearch.data = null;

        const categories = await requestCompressedJson(
            `${server.baseUrl}/api/proxy/xtream/${sourceId}/live_categories`,
            cookie
        );
        const coldMeasurement = await measureServerMemory(server, () =>
            requestCompressedJson(
                `${server.baseUrl}/api/proxy/xtream/${sourceId}/live_streams`,
                cookie
            )
        );
        const streamsCold = coldMeasurement.result;
        assert.equal(categories.data.length, categoryCount);
        assert.equal(streamsCold.data.length, channelCount);
        categories.data = null;
        streamsCold.data = null;
        const warmMeasurement = await measureServerMemory(server, () =>
            requestCompressedJson(
                `${server.baseUrl}/api/proxy/xtream/${sourceId}/live_streams`,
                cookie
            )
        );
        const streamsWarm = warmMeasurement.result;
        assert.equal(streamsWarm.data.length, channelCount);
        streamsWarm.data = null;

        let browser;
        try {
            const browserMeasurement = await measureServerMemory(server, () =>
                measureBrowser(server.baseUrl, cookie)
            );
            browser = {
                ...browserMeasurement.result,
                serverMemory: browserMeasurement.memory
            };
        } catch (error) {
            browser = { error: error.message };
        }

        const report = {
            fixture: {
                channels: channelCount,
                categories: categoryCount,
                seedMs: seeded.seedMs,
                databaseBytes
            },
            direct,
            http: {
                favoriteChannels: {
                    ...favoriteChannels,
                    data: undefined,
                    serverMemory: favoriteMeasurement.memory
                },
                catalogueSummary: {
                    ...catalogueSummary,
                    data: undefined,
                    serverMemory: summaryMeasurement.memory
                },
                cataloguePage: {
                    ...cataloguePage,
                    data: undefined,
                    serverMemory: pageMeasurement.memory
                },
                catalogueSearch: {
                    ...catalogueSearch,
                    data: undefined,
                    serverMemory: searchMeasurement.memory
                },
                categories: { ...categories, data: undefined },
                streamsCold: {
                    ...streamsCold,
                    data: undefined,
                    serverMemory: coldMeasurement.memory
                },
                streamsWarm: {
                    ...streamsWarm,
                    data: undefined,
                    serverMemory: warmMeasurement.memory
                }
            },
            home,
            browser
        };

        console.log('\nLarge-catalogue benchmark (synthetic data only)');
        console.log(JSON.stringify(report, null, 2));
    } catch (error) {
        if (server) console.error(server.getOutput());
        throw error;
    } finally {
        await stopServer(server?.child);
        await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

if (require.main === module) {
    run().catch(error => {
        console.error(error);
        process.exit(1);
    });
}
