const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const candidateImage = process.env.NODECAST_MIGRATION_CANDIDATE_IMAGE || 'nodecast-tv-plus:migration-test';
const expectedCandidateVersion = require('../package.json').version;
const baselineDockerfile = `FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data /app/transcode-cache
EXPOSE 3000
CMD ["npm", "start"]
`;
const baselines = [
    {
        version: '2.1.1',
        image: 'nodecast-tv-upstream-migration-test:2.1.1',
        kind: 'upstream',
        context: 'https://github.com/technomancer702/nodecast-tv.git#3be14ef2faff81eb59f405c4641825a64f0b9c4a'
    },
    {
        version: '2.1.4',
        image: 'nodecast-tv-upstream-migration-test:2.1.4',
        kind: 'upstream',
        context: 'https://github.com/technomancer702/nodecast-tv.git#0e26a90dae211cf9ed4c7adc8941ec9fbddec972'
    },
    {
        version: '2.3.0',
        image: 'ghcr.io/mikaelkw/nodecast-tv-plus:2.3.0',
        kind: 'plus'
    }
];

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function run(command, args, { stream = false, allowFailure = false, input, timeoutMs = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: projectRoot,
            stdio: stream ? ['pipe', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        if (!stream) {
            child.stdout.on('data', chunk => { stdout += chunk.toString(); });
            child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        }

        child.once('error', error => {
            clearTimeout(timeout);
            reject(error);
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
        child.once('exit', code => {
            clearTimeout(timeout);
            if (timedOut) {
                reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
                return;
            }
            const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
            if (code === 0 || allowFailure) return resolve(result);
            reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr}` : ''}`));
        });
    });
}

const docker = (args, options) => run('docker', args, options);

async function dockerObjectExists(type, name) {
    const result = await docker([type, 'inspect', name], { allowFailure: true });
    return result.code === 0;
}

async function removePreparedImage(image) {
    if (!(await dockerObjectExists('image', image))) return;

    const result = await docker(['image', 'rm', image], { allowFailure: true });
    if (result.code !== 0) {
        console.warn(`Keeping prepared migration image ${image}; another local container may still reference it.`);
    }
}

async function ensureCandidateImage() {
    if (await dockerObjectExists('image', candidateImage)) return false;
    console.log(`Building migration candidate image ${candidateImage}...`);
    await docker(['build', '-t', candidateImage, '.'], { stream: true });
    return true;
}

async function prepareBaseline(baseline) {
    if (await dockerObjectExists('image', baseline.image)) {
        console.log(`Using existing ${baseline.kind} ${baseline.version} migration baseline image...`);
        return false;
    }

    if (baseline.context) {
        console.log(`Building lightweight upstream ${baseline.version} baseline from its pinned commit...`);
        await docker(['build', '-t', baseline.image, '-f', '-', baseline.context], {
            stream: true,
            input: baselineDockerfile,
            timeoutMs: 300000
        });
        return true;
    }

    console.log(`Pulling published Plus ${baseline.version} migration baseline...`);
    await docker(['pull', baseline.image], { stream: true, timeoutMs: 300000 });
    return true;
}

async function request(baseUrl, pathname, { method = 'GET', body, token, cookie } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;

    const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000)
    });
    const text = await response.text();
    let payload = null;
    if (text) {
        try {
            payload = JSON.parse(text);
        } catch {
            payload = text;
        }
    }

    if (!response.ok) {
        const message = typeof payload === 'object' && payload?.error
            ? payload.error
            : `HTTP ${response.status}`;
        throw new Error(`${method} ${pathname} failed: ${message}`);
    }

    return { payload, headers: response.headers, status: response.status };
}

async function waitForVersion(baseUrl, expectedVersion, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const response = await request(baseUrl, '/api/version');
            if (response.payload?.version === expectedVersion) return;
            lastError = new Error(`received version ${response.payload?.version || 'unknown'}`);
        } catch (error) {
            lastError = error;
        }
        await sleep(500);
    }
    throw new Error(`Timed out waiting for version ${expectedVersion}: ${lastError?.message || 'unknown error'}`);
}

async function mappedBaseUrl(containerName) {
    const result = await docker(['port', containerName, '3000/tcp']);
    const mapping = result.stdout.split(/\r?\n/).find(Boolean);
    const match = mapping?.match(/:(\d+)$/);
    if (!match) throw new Error(`Could not determine the mapped port for ${containerName}.`);
    return `http://127.0.0.1:${match[1]}`;
}

async function startContainer({ name, image, volume, jwtSecret, sessionSecret }) {
    const args = [
        'run', '-d', '--name', name,
        '-p', '127.0.0.1::3000',
        '-e', 'NODE_ENV=production',
        '-e', `JWT_SECRET=${jwtSecret}`,
        '-v', `${volume}:/app/data`
    ];
    if (sessionSecret) {
        args.push('-e', `SESSION_SECRET=${sessionSecret}`, '-e', 'AUTH_COOKIE_SECURE=false');
    }
    args.push(image);
    await docker(args);
    return mappedBaseUrl(name);
}

async function sqliteSnapshot(containerName, sourceId) {
    const code = `
const db = require('/app/server/db/sqlite').getDb();
const first = db.prepare('SELECT item_id FROM playlist_items WHERE source_id = ? ORDER BY item_id LIMIT 1').get(${Number(sourceId)});
const count = table => db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count;
console.log(JSON.stringify({
  categories: count('categories'),
  playlistItems: count('playlist_items'),
  epgPrograms: count('epg_programs'),
  syncStatus: count('sync_status'),
  favorites: count('favorites'),
  watchHistory: count('watch_history'),
  hiddenItems: db.prepare('SELECT COUNT(*) AS count FROM playlist_items WHERE is_hidden = 1').get().count,
  firstItemId: first && first.item_id
}));`;
    const result = await docker(['exec', containerName, 'node', '-e', code]);
    return JSON.parse(result.stdout.split(/\r?\n/).filter(Boolean).at(-1));
}

async function seedBaselineData(containerName, { sourceName, sourceUrl, providerUsername, providerPassword }) {
    const code = `
const { sources } = require('/app/server/db');
const { getDb } = require('/app/server/db/sqlite');
(async () => {
  const source = await sources.create({
    type: 'm3u',
    name: ${JSON.stringify(sourceName)},
    url: ${JSON.stringify(sourceUrl)},
    username: ${JSON.stringify(providerUsername)},
    password: process.env.MIGRATION_PROVIDER_PASSWORD
  });
  const db = getDb();
  const now = Date.now();
  db.prepare('INSERT INTO categories (id, source_id, category_id, type, name, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(source.id + ':migration', source.id, 'migration', 'live', 'Migration', '{}');
  const insertItem = db.prepare('INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, stream_url, container_extension, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertItem.run(source.id + ':migration-one', source.id, 'migration-one', 'live', 'Migration Channel One', 'migration', 'https://stream.example.invalid/live/one.m3u8', 'm3u8', '{}');
  insertItem.run(source.id + ':migration-two', source.id, 'migration-two', 'live', 'Migration Channel Two', 'migration', 'https://stream.example.invalid/live/two.m3u8', 'm3u8', '{}');
  db.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, description, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(source.id + ':migration-one', source.id, now, now + 3600000, 'Migration Programme', 'Migration fixture', '{}');
  db.prepare('INSERT INTO sync_status (source_id, type, last_sync, status, error) VALUES (?, ?, ?, ?, ?)')
    .run(source.id, 'live', now, 'success', null);
  console.log(JSON.stringify({ id: source.id, name: source.name, type: source.type }));
})().catch(error => {
  console.error(error);
  process.exit(1);
});`;
    const result = await docker([
        'exec', '-e', `MIGRATION_PROVIDER_PASSWORD=${providerPassword}`,
        containerName, 'node', '-e', code
    ]);
    return JSON.parse(result.stdout.split(/\r?\n/).filter(Boolean).at(-1));
}

async function sourceCredentialDigest(containerName, sourceId) {
    const code = `
const crypto = require('node:crypto');
const { sources } = require('/app/server/db');
sources.getById(${Number(sourceId)}).then(source => {
  const selected = { url: source.url, username: source.username, password: source.password };
  console.log(crypto.createHash('sha256').update(JSON.stringify(selected)).digest('hex'));
});`;
    const result = await docker(['exec', containerName, 'node', '-e', code]);
    return result.stdout.split(/\r?\n/).filter(Boolean).at(-1);
}

function localCredentialDigest(source) {
    const selected = { url: source.url, username: source.username, password: source.password };
    return crypto.createHash('sha256').update(JSON.stringify(selected)).digest('hex');
}

async function collectApiState(baseUrl, auth) {
    const [settings, sources, favorites, history, hidden] = await Promise.all([
        request(baseUrl, '/api/settings', auth),
        request(baseUrl, '/api/sources', auth),
        request(baseUrl, '/api/favorites', auth),
        request(baseUrl, '/api/history', auth),
        request(baseUrl, '/api/channels/hidden', auth)
    ]);
    return {
        settings: settings.payload,
        sources: sources.payload,
        favorites: favorites.payload,
        history: history.payload,
        hidden: hidden.payload
    };
}

async function removeContainer(name) {
    if (await dockerObjectExists('container', name)) await docker(['rm', '-f', name]);
}

async function removeVolume(name) {
    if (await dockerObjectExists('volume', name)) await docker(['volume', 'rm', name]);
}

async function sanitizedLogs(containerName, valuesToRedact) {
    if (!(await dockerObjectExists('container', containerName))) return '';
    const result = await docker(['logs', '--tail', '100', containerName], { allowFailure: true });
    let output = `${result.stdout}\n${result.stderr}`.trim();
    for (const value of valuesToRedact.filter(Boolean)) output = output.split(value).join('[redacted]');
    return output;
}

async function runBaseline(baseline) {
    const suffix = `${process.pid}-${baseline.version.replaceAll('.', '-')}`;
    const baselineContainer = `nodecast-baseline-migration-${suffix}`;
    const plusContainer = `nodecast-plus-migration-${suffix}`;
    const volume = `nodecast-migration-data-${suffix}`;
    const username = `migration-admin-${suffix}`;
    const password = crypto.randomBytes(36).toString('base64url');
    const jwtSecret = crypto.randomBytes(48).toString('hex');
    const sessionSecret = crypto.randomBytes(48).toString('hex');
    const providerUsername = `provider-${suffix}`;
    const providerPassword = crypto.randomBytes(36).toString('base64url');
    const playlistUrl = 'https://migration.example.invalid/playlist.m3u';
    const redactions = [password, jwtSecret, sessionSecret, providerPassword];

    await docker(['volume', 'create', volume]);
    try {
        console.log(`Starting ${baseline.kind} ${baseline.version} with a disposable data volume...`);
        const baselineUrl = await startContainer({
            name: baselineContainer,
            image: baseline.image,
            volume,
            jwtSecret,
            sessionSecret: baseline.kind === 'plus' ? sessionSecret : undefined
        });
        await waitForVersion(baselineUrl, baseline.version);
        console.log(`${baseline.kind} ${baseline.version} is ready; creating account and migration records...`);

        const setup = await request(baselineUrl, '/api/auth/setup', {
            method: 'POST',
            body: { username, password, passwordConfirmation: password }
        });
        let baselineAuth;
        if (baseline.kind === 'upstream') {
            const legacyToken = setup.payload.token;
            assert.ok(legacyToken, 'Upstream setup must return a bearer token.');
            redactions.push(legacyToken);
            baselineAuth = { token: legacyToken };
        } else {
            const setCookie = setup.headers.get('set-cookie') || '';
            const authCookie = setCookie.match(/nodecast_auth=[^;]+/)?.[0];
            assert.ok(authCookie, 'The previous Plus release must issue an authentication cookie.');
            redactions.push(authCookie);
            baselineAuth = { cookie: authCookie };
        }

        await request(baselineUrl, '/api/settings', {
            ...baselineAuth,
            method: 'PUT',
            body: { maxResolution: '720p', forceProxy: true, epgDays: 5 }
        });
        const source = await seedBaselineData(baselineContainer, {
            sourceName: `Migration fixture ${baseline.version}`,
            sourceUrl: playlistUrl,
            providerUsername,
            providerPassword
        });

        const initialSqlite = await sqliteSnapshot(baselineContainer, source.id);
        assert.equal(initialSqlite.playlistItems, 2);
        assert.equal(initialSqlite.categories, 1);
        assert.equal(initialSqlite.epgPrograms, 1);
        assert.equal(initialSqlite.syncStatus, 1);
        assert.ok(initialSqlite.firstItemId);

        await request(baselineUrl, '/api/favorites', {
            ...baselineAuth,
            method: 'POST',
            body: { sourceId: source.id, itemId: initialSqlite.firstItemId, itemType: 'channel' }
        });
        await request(baselineUrl, '/api/history', {
            ...baselineAuth,
            method: 'POST',
            body: {
                id: initialSqlite.firstItemId,
                type: 'movie',
                sourceId: source.id,
                progress: 42,
                duration: 120,
                data: { title: 'Migration fixture' }
            }
        });
        await request(baselineUrl, '/api/channels/hide', {
            ...baselineAuth,
            method: 'POST',
            body: { sourceId: source.id, itemId: initialSqlite.firstItemId, itemType: 'channel' }
        });

        const baselineState = await collectApiState(baselineUrl, baselineAuth);
        const baselineSqlite = await sqliteSnapshot(baselineContainer, source.id);
        const expectedCredentialDigest = localCredentialDigest({
            url: playlistUrl,
            username: providerUsername,
            password: providerPassword
        });
        assert.equal(await sourceCredentialDigest(baselineContainer, source.id), expectedCredentialDigest);

        await removeContainer(baselineContainer);

        console.log(`Starting Plus ${expectedCandidateVersion} against ${baseline.kind} ${baseline.version} data...`);
        const plusUrl = await startContainer({
            name: plusContainer,
            image: candidateImage,
            volume,
            jwtSecret,
            sessionSecret
        });
        await waitForVersion(plusUrl, expectedCandidateVersion);
        console.log(`Plus ${expectedCandidateVersion} is ready; verifying migrated records...`);

        const inheritedMe = await request(plusUrl, '/api/auth/me', baselineAuth);
        assert.equal(inheritedMe.payload.username, username);
        if (baseline.kind === 'upstream') {
            assert.match(inheritedMe.headers.get('set-cookie') || '', /nodecast_auth=/,
                'A valid legacy bearer token must migrate to an authentication cookie.');
        }

        const login = await request(plusUrl, '/api/auth/login', {
            method: 'POST',
            body: { username, password }
        });
        const setCookie = login.headers.get('set-cookie') || '';
        const authCookie = setCookie.match(/nodecast_auth=[^;]+/)?.[0];
        assert.ok(authCookie, 'Password login must issue an authentication cookie.');
        const cookieAuth = { cookie: authCookie };

        const me = await request(plusUrl, '/api/auth/me', cookieAuth);
        assert.equal(me.payload.username, username);
        assert.equal(me.payload.role, 'admin');
        const setupRequired = await request(plusUrl, '/api/auth/setup-required');
        assert.equal(setupRequired.payload.setupRequired, false);

        const plusState = await collectApiState(plusUrl, cookieAuth);
        const plusSqlite = await sqliteSnapshot(plusContainer, source.id);
        const plusCredentialDigest = await sourceCredentialDigest(plusContainer, source.id);

        assert.equal(plusCredentialDigest, expectedCredentialDigest, 'Provider credentials must be preserved.');
        assert.equal(plusState.settings.maxResolution, baselineState.settings.maxResolution);
        assert.equal(plusState.settings.forceProxy, baselineState.settings.forceProxy);
        assert.equal(plusState.settings.epgDays, baselineState.settings.epgDays);
        assert.equal(plusState.sources.length, baselineState.sources.length);
        assert.equal(plusState.sources[0].name, baselineState.sources[0].name);
        assert.equal(plusState.sources[0].type, baselineState.sources[0].type);
        assert.equal(plusState.favorites.length, 1);
        assert.equal(plusState.history.length, 1);
        assert.equal(plusState.history[0].progress, 42);
        assert.equal(plusState.history[0].data.title, 'Migration fixture');
        assert.equal(plusState.hidden.length, 1);
        assert.deepEqual(plusSqlite, baselineSqlite);

        console.log(`Migration compatibility passed: ${baseline.kind} ${baseline.version} -> Plus ${expectedCandidateVersion}.`);
    } catch (error) {
        const baselineLogs = await sanitizedLogs(baselineContainer, redactions);
        const plusLogs = await sanitizedLogs(plusContainer, redactions);
        if (baselineLogs) console.error(`Sanitized ${baseline.kind} ${baseline.version} logs:\n${baselineLogs}`);
        if (plusLogs) console.error(`Sanitized Plus logs:\n${plusLogs}`);
        throw error;
    } finally {
        await removeContainer(baselineContainer);
        await removeContainer(plusContainer);
        await removeVolume(volume);
    }
}

async function main() {
    const dockerVersion = await docker(['version', '--format', '{{.Server.Version}}'], { allowFailure: true });
    if (dockerVersion.code !== 0) throw new Error('A running Docker engine is required for migration tests.');

    const candidateWasBuilt = await ensureCandidateImage();
    const preparedBaselineImages = [];
    try {
        for (const baseline of baselines) {
            if (await prepareBaseline(baseline)) preparedBaselineImages.push(baseline.image);
            await runBaseline(baseline);
        }
        console.log('All supported migration baselines passed.');
    } finally {
        for (const image of preparedBaselineImages) {
            await removePreparedImage(image);
        }
        if (candidateWasBuilt && process.env.KEEP_MIGRATION_TEST_IMAGE !== 'true') {
            await removePreparedImage(candidateImage);
        }
    }
}

// A pending promise alone does not keep Node.js alive. Keep one referenced handle
// until the complete migration sequence has either passed or failed.
const lifecycleGuard = setInterval(() => {}, 1000);

main().then(() => {
    clearInterval(lifecycleGuard);
}).catch(error => {
    clearInterval(lifecycleGuard);
    console.error(error);
    process.exitCode = 1;
});
