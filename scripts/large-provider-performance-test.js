const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const sourceId = 1;
const channelCount = 1000;
const programmesPerChannel = 48;

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
    if (child.exitCode === null) {
        child.kill('SIGKILL');
        await Promise.race([
            new Promise(resolve => child.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 5000))
        ]);
    }
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
    await waitForServer(baseUrl, child);
    return { baseUrl, child, getOutput: () => output };
}

function seedLargeCatalogue(dataDirectory, now) {
    process.env.NODECAST_DATA_DIR = dataDirectory;
    const { getDb } = require('../server/db/sqlite');
    const {
        FULL_GUIDE_SQL,
        NOW_PLAYING_SQL,
        getFullGuide,
        getNowPlaying
    } = require('../server/services/epgGuideData');
    const db = getDb();
    const insertChannel = db.prepare(`
        INSERT INTO playlist_items
            (id, source_id, item_id, type, name, stream_icon, data)
        VALUES (?, ?, ?, 'epg_channel', ?, ?, ?)
    `);
    const insertProgramme = db.prepare(`
        INSERT INTO epg_programs
            (channel_id, source_id, start_time, end_time, title, description)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const halfHourMs = 30 * 60 * 1000;
    const firstStart = now - (programmesPerChannel / 2) * halfHourMs - 5 * 60 * 1000;

    db.transaction(() => {
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            const channelId = `large-${String(channelIndex).padStart(4, '0')}`;
            insertChannel.run(
                `${sourceId}:${channelId}`,
                sourceId,
                channelId,
                `Large Provider Channel ${channelIndex}`,
                '',
                JSON.stringify({ generated: true })
            );
            for (let programmeIndex = 0; programmeIndex < programmesPerChannel; programmeIndex += 1) {
                const start = firstStart + programmeIndex * halfHourMs;
                insertProgramme.run(
                    channelId,
                    sourceId,
                    start,
                    start + halfHourMs,
                    `Programme ${channelIndex}-${programmeIndex}`,
                    `Generated description for channel ${channelIndex}, programme ${programmeIndex}.`
                );
            }
        }

        // Verify deterministic overlap handling: the most recently started
        // currently-airing row must win.
        insertProgramme.run(
            'large-0000',
            sourceId,
            now - 60 * 1000,
            now + 10 * 60 * 1000,
            'Overlap winner',
            'This description must not appear in the lightweight response.'
        );

        // Providers occasionally publish unusually long events. Keep one within
        // the documented seven-day allowance to protect the guide contract.
        insertChannel.run(
            `${sourceId}:long-event`,
            sourceId,
            'long-event',
            'Long Event Channel',
            '',
            JSON.stringify({ generated: true })
        );
        insertProgramme.run(
            'long-event',
            sourceId,
            now - 72 * 60 * 60 * 1000,
            now + 31 * 60 * 60 * 1000,
            'Long-running event',
            'Generated long-running event.'
        );
    })();

    const nowPlan = db.prepare(`EXPLAIN QUERY PLAN ${NOW_PLAYING_SQL}`).all(
        sourceId,
        now - 7 * 24 * 60 * 60 * 1000,
        now,
        now
    );
    const fullPlan = db.prepare(`EXPLAIN QUERY PLAN ${FULL_GUIDE_SQL}`).all(
        sourceId,
        now - 8 * 24 * 60 * 60 * 1000,
        now + 24 * 60 * 60 * 1000,
        now - 24 * 60 * 60 * 1000
    );
    const nowStarted = performance.now();
    const nowData = getNowPlaying(sourceId, now);
    const nowDurationMs = performance.now() - nowStarted;
    const fullStarted = performance.now();
    const fullData = getFullGuide(sourceId, now);
    const fullDurationMs = performance.now() - fullStarted;
    db.close();

    assert.match(nowPlan.map(row => row.detail).join(' '), /idx_epg_source_start/);
    assert.match(fullPlan.map(row => row.detail).join(' '), /idx_epg_source_start/);
    assert.equal(nowData.programmes.length, channelCount + 1);
    assert.equal(
        nowData.programmes.find(programme => programme.channelId === 'large-0000').title,
        'Overlap winner'
    );
    assert.ok(nowData.programmes.every(programme => !Object.hasOwn(programme, 'description')));
    assert.ok(fullData.programmes.length >= channelCount * programmesPerChannel);
    assert.ok(fullData.programmes.some(programme =>
        programme.channelId === 'long-event'
        && programme.title === 'Long-running event'
        && typeof programme.description === 'string'
    ));
    assert.ok(fullData.programmes.every(programme =>
        typeof programme.start === 'string' && typeof programme.stop === 'string'
    ));

    const nowBytes = Buffer.byteLength(JSON.stringify(nowData));
    const fullBytes = Buffer.byteLength(JSON.stringify(fullData));
    assert.ok(nowBytes < fullBytes * 0.15, `Now response ${nowBytes} bytes was not sufficiently smaller than ${fullBytes}.`);
    assert.ok(nowDurationMs < 5000, `Now query took ${nowDurationMs.toFixed(1)}ms.`);
    assert.ok(fullDurationMs < 5000, `Full query took ${fullDurationMs.toFixed(1)}ms.`);

    return { fullBytes, fullDurationMs, nowBytes, nowDurationMs };
}

async function run() {
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-large-provider-'));
    const dataDirectory = path.join(testRoot, 'data');
    await fs.mkdir(dataDirectory, { recursive: true });
    let server;

    try {
        const now = Date.now();
        const metrics = seedLargeCatalogue(dataDirectory, now);
        console.log('[Performance] Generated large catalogue');
        server = await startServer(dataDirectory);
        console.log('[Performance] Test server ready');
        const password = crypto.randomBytes(24).toString('base64url');
        const setup = await fetch(`${server.baseUrl}/api/auth/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'PerformanceAdmin',
                password,
                passwordConfirmation: password
            })
        });
        assert.equal(setup.status, 201);
        console.log('[Performance] Test session ready');
        const cookie = (setup.headers.get('set-cookie') || '').split(';', 1)[0];
        assert.ok(cookie);

        const nowResponse = await fetch(`${server.baseUrl}/api/proxy/epg/${sourceId}/now`, {
            headers: {
                Accept: 'application/json',
                'Accept-Encoding': 'gzip',
                Cookie: cookie
            }
        });
        assert.equal(nowResponse.status, 200);
        assert.equal(nowResponse.headers.get('content-encoding'), 'gzip');
        const nowPayload = await nowResponse.json();
        assert.equal(nowPayload.programmes.length, channelCount + 1);
        console.log('[Performance] Lightweight EPG response verified');

        const fullResponse = await fetch(`${server.baseUrl}/api/proxy/epg/${sourceId}`, {
            headers: {
                Accept: 'application/json',
                'Accept-Encoding': 'gzip',
                Cookie: cookie
            }
        });
        assert.equal(fullResponse.status, 200);
        assert.equal(fullResponse.headers.get('content-encoding'), 'gzip');
        const fullPayload = await fullResponse.json();
        assert.ok(fullPayload.programmes.length >= channelCount * programmesPerChannel);
        console.log('[Performance] Full EPG response verified');

        console.log(
            `Large-provider performance test passed: `
            + `${channelCount} channels, ${fullPayload.programmes.length} guide rows; `
            + `now ${metrics.nowDurationMs.toFixed(1)}ms/${metrics.nowBytes} bytes; `
            + `full ${metrics.fullDurationMs.toFixed(1)}ms/${metrics.fullBytes} bytes.`
        );
    } catch (error) {
        if (server) {
            console.error(server.getOutput());
        }
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

module.exports = {
    seedLargeCatalogue
};
