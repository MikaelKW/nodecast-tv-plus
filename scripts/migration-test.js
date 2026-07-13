const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
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
        context: 'https://github.com/technomancer702/nodecast-tv.git#3be14ef2faff81eb59f405c4641825a64f0b9c4a'
    },
    {
        version: '2.1.4',
        image: 'nodecast-tv-upstream-migration-test:2.1.4',
        context: 'https://github.com/technomancer702/nodecast-tv.git#0e26a90dae211cf9ed4c7adc8941ec9fbddec972'
    }
];

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function run(command, args, { stream = false, allowFailure = false, input } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: projectRoot,
            stdio: stream ? ['pipe', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        let stdout = '';
        let stderr = '';

        if (!stream) {
            child.stdout.on('data', chunk => { stdout += chunk.toString(); });
            child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        }

        child.once('error', reject);
        child.stdin.on('error', () => {});
        child.stdin.end(input);
        child.once('exit', code => {
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

async function ensureCandidateImage() {
    if (await dockerObjectExists('image', candidateImage)) return false;
    console.log(`Building migration candidate image ${candidateImage}...`);
    await docker(['build', '-t', candidateImage, '.'], { stream: true });
    return true;
}

async function buildBaseline(baseline) {
    console.log(`Building lightweight upstream ${baseline.version} baseline from its pinned commit...`);
    await docker(['build', '-t', baseline.image, '-f', '-', baseline.context], {
        stream: true,
        input: baselineDockerfile
    });
}

function startFixtureServer() {
    const playlist = `#EXTM3U
#EXTINF:-1 tvg-id="migration-one" group-title="Migration",Migration Channel One
https://stream.example.invalid/live/one.m3u8
#EXTINF:-1 tvg-id="migration-two" group-title="Migration",Migration Channel Two
https://stream.example.invalid/live/two.m3u8
`;

    const server = http.createServer((request, response) => {
        if (request.url !== '/playlist.m3u') {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
        response.end(playlist);
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '0.0.0.0', () => resolve({
            server,
            port: server.address().port
        }));
    });
}

function closeServer(server) {
    return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function request(baseUrl, pathname, { method = 'GET', body, token, cookie } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;

    const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
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

async function waitForSourceSync(baseUrl, sourceId, token, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const { payload: statuses } = await request(baseUrl, '/api/sources/status', { token });
        const status = statuses.find(item => Number(item.source_id) === Number(sourceId));
        if (status?.status === 'success') return;
        if (status?.status === 'error') throw new Error(`Source ${sourceId} synchronization failed.`);
        await sleep(500);
    }
    throw new Error(`Timed out waiting for source ${sourceId} synchronization.`);
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
        '--add-host', 'host.docker.internal:host-gateway',
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
  favorites: count('favorites'),
  watchHistory: count('watch_history'),
  hiddenItems: db.prepare('SELECT COUNT(*) AS count FROM playlist_items WHERE is_hidden = 1').get().count,
  firstItemId: first && first.item_id
}));`;
    const result = await docker(['exec', containerName, 'node', '-e', code]);
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

async function runBaseline(baseline, fixturePort) {
    const suffix = `${process.pid}-${baseline.version.replaceAll('.', '-')}`;
    const upstreamContainer = `nodecast-upstream-migration-${suffix}`;
    const plusContainer = `nodecast-plus-migration-${suffix}`;
    const volume = `nodecast-migration-data-${suffix}`;
    const username = `migration-admin-${suffix}`;
    const password = crypto.randomBytes(36).toString('base64url');
    const jwtSecret = crypto.randomBytes(48).toString('hex');
    const sessionSecret = crypto.randomBytes(48).toString('hex');
    const providerUsername = `provider-${suffix}`;
    const providerPassword = crypto.randomBytes(36).toString('base64url');
    const playlistUrl = `http://host.docker.internal:${fixturePort}/playlist.m3u`;
    const redactions = [password, jwtSecret, sessionSecret, providerPassword];

    await docker(['volume', 'create', volume]);
    try {
        const upstreamUrl = await startContainer({
            name: upstreamContainer,
            image: baseline.image,
            volume,
            jwtSecret
        });
        await waitForVersion(upstreamUrl, baseline.version);

        const setup = await request(upstreamUrl, '/api/auth/setup', {
            method: 'POST',
            body: { username, password }
        });
        const legacyToken = setup.payload.token;
        assert.ok(legacyToken, 'Upstream setup must return a bearer token.');
        redactions.push(legacyToken);
        const tokenAuth = { token: legacyToken };

        await request(upstreamUrl, '/api/settings', {
            ...tokenAuth,
            method: 'PUT',
            body: { maxResolution: '720p', forceProxy: true, epgDays: 5 }
        });
        const sourceResponse = await request(upstreamUrl, '/api/sources', {
            ...tokenAuth,
            method: 'POST',
            body: {
                type: 'm3u',
                name: `Migration fixture ${baseline.version}`,
                url: playlistUrl,
                username: providerUsername,
                password: providerPassword
            }
        });
        const source = sourceResponse.payload;
        await waitForSourceSync(upstreamUrl, source.id, legacyToken);

        const initialSqlite = await sqliteSnapshot(upstreamContainer, source.id);
        assert.equal(initialSqlite.playlistItems, 2);
        assert.equal(initialSqlite.categories, 1);
        assert.ok(initialSqlite.firstItemId);

        await request(upstreamUrl, '/api/favorites', {
            ...tokenAuth,
            method: 'POST',
            body: { sourceId: source.id, itemId: initialSqlite.firstItemId, itemType: 'channel' }
        });
        await request(upstreamUrl, '/api/history', {
            ...tokenAuth,
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
        await request(upstreamUrl, '/api/channels/hide', {
            ...tokenAuth,
            method: 'POST',
            body: { sourceId: source.id, itemId: initialSqlite.firstItemId, itemType: 'channel' }
        });

        const upstreamState = await collectApiState(upstreamUrl, tokenAuth);
        const upstreamSqlite = await sqliteSnapshot(upstreamContainer, source.id);
        const expectedCredentialDigest = localCredentialDigest({
            url: playlistUrl,
            username: providerUsername,
            password: providerPassword
        });
        assert.equal(await sourceCredentialDigest(upstreamContainer, source.id), expectedCredentialDigest);

        await removeContainer(upstreamContainer);

        const plusUrl = await startContainer({
            name: plusContainer,
            image: candidateImage,
            volume,
            jwtSecret,
            sessionSecret
        });
        await waitForVersion(plusUrl, expectedCandidateVersion);

        const legacyMe = await request(plusUrl, '/api/auth/me', tokenAuth);
        assert.equal(legacyMe.payload.username, username);
        assert.match(legacyMe.headers.get('set-cookie') || '', /nodecast_auth=/,
            'A valid legacy bearer token must migrate to an authentication cookie.');

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
        assert.equal(plusState.settings.maxResolution, upstreamState.settings.maxResolution);
        assert.equal(plusState.settings.forceProxy, upstreamState.settings.forceProxy);
        assert.equal(plusState.settings.epgDays, upstreamState.settings.epgDays);
        assert.equal(plusState.sources.length, upstreamState.sources.length);
        assert.equal(plusState.sources[0].name, upstreamState.sources[0].name);
        assert.equal(plusState.sources[0].type, upstreamState.sources[0].type);
        assert.equal(plusState.favorites.length, 1);
        assert.equal(plusState.history.length, 1);
        assert.equal(plusState.history[0].progress, 42);
        assert.equal(plusState.history[0].data.title, 'Migration fixture');
        assert.equal(plusState.hidden.length, 1);
        assert.deepEqual(plusSqlite, upstreamSqlite);

        console.log(`Migration compatibility passed: upstream ${baseline.version} -> Plus ${expectedCandidateVersion}.`);
    } catch (error) {
        const upstreamLogs = await sanitizedLogs(upstreamContainer, redactions);
        const plusLogs = await sanitizedLogs(plusContainer, redactions);
        if (upstreamLogs) console.error(`Sanitized upstream ${baseline.version} logs:\n${upstreamLogs}`);
        if (plusLogs) console.error(`Sanitized Plus logs:\n${plusLogs}`);
        throw error;
    } finally {
        await removeContainer(upstreamContainer);
        await removeContainer(plusContainer);
        await removeVolume(volume);
    }
}

async function main() {
    const dockerVersion = await docker(['version', '--format', '{{.Server.Version}}'], { allowFailure: true });
    if (dockerVersion.code !== 0) throw new Error('A running Docker engine is required for migration tests.');

    const candidateWasBuilt = await ensureCandidateImage();
    const { server, port } = await startFixtureServer();
    try {
        for (const baseline of baselines) {
            await buildBaseline(baseline);
            await runBaseline(baseline, port);
        }
        console.log('All supported upstream migration baselines passed.');
    } finally {
        await closeServer(server);
        for (const baseline of baselines) {
            if (await dockerObjectExists('image', baseline.image)) await docker(['image', 'rm', baseline.image]);
        }
        if (candidateWasBuilt && process.env.KEEP_MIGRATION_TEST_IMAGE !== 'true') {
            if (await dockerObjectExists('image', candidateImage)) await docker(['image', 'rm', candidateImage]);
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
