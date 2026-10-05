// Optional native build-cache checks. All probe contexts contain only tracked
// build files; probe images are never published or used by the application.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function readVertices(log) {
    const vertices = new Map();
    for (const line of log.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        // Buildx rawjson emits one vertex update per line. Also accept grouped
        // progress messages so the parser does not confuse logs with vertices.
        for (const vertex of message.vertexes || [message]) {
            const key = vertex.digest || vertex.id;
            if (key && (vertex.name || vertices.has(key))) {
                vertices.set(key, { ...vertices.get(key), ...vertex });
            }
        }
    }
    return [...vertices.values()];
}

function checkBuild(log, compilationCached) {
    const vertices = readVertices(log);
    function one(pattern) {
        const matches = vertices.filter(vertex => pattern.test(vertex.name || ''));
        assert.equal(matches.length, 1, `Expected one build step matching ${pattern}`);
        const vertex = matches[0];
        assert.ok(vertex.completed, `Build step did not complete: ${vertex.name}`);
        assert.ok(!vertex.error, `Build step failed: ${vertex.name}`);
        return vertex;
    }
    const refresh = one(/\[media-build-packages \d+\/\d+\] RUN .*Refreshing media build packages/);
    const compilation = one(/\[media-builder \d+\/\d+\] RUN .*sh \/tmp\/build-media/);
    assert.equal(Boolean(refresh.cached), false, 'Build packages must be freshly installed');
    if (compilationCached !== undefined) {
        assert.equal(Boolean(compilation.cached), compilationCached, 'Unexpected compilation cache result');
    }
    const seconds = compilation.started
        ? Math.max(0, (Date.parse(compilation.completed) - Date.parse(compilation.started)) / 1000)
        : 0;
    assert.ok(Number.isFinite(seconds), 'Invalid compilation timestamps');
    return {
        packagesRefreshed: true,
        compilationCached: Boolean(compilation.cached),
        compilationSeconds: seconds
    };
}

function selfTest() {
    function log(cached, refreshCached = false) {
        return [
            { id: 'refresh', name: '[media-build-packages 2/2] RUN echo "Refreshing media build packages for test"', completed: '2026-01-01T00:00:01Z', cached: refreshCached },
            { id: 'compile', name: '[media-builder 4/4] RUN sh /tmp/build-media && sh /tmp/collect-media-packages', started: '2026-01-01T00:00:01Z' },
            { id: 'compile', completed: '2026-01-01T00:00:11Z', cached }
        ].map(value => JSON.stringify(value)).join('\n');
    }
    assert.equal(checkBuild(log(true), true).compilationCached, true);
    assert.equal(checkBuild(log(false), false).compilationSeconds, 10);
    const grouped = log(true).split('\n').map(line => {
        const vertex = JSON.parse(line);
        vertex.digest = vertex.id;
        delete vertex.id;
        return JSON.stringify({ vertexes: [vertex] });
    }).join('\n') + '\n' + JSON.stringify({ logs: [{ vertex: 'compile', data: 'ignored' }] });
    assert.equal(checkBuild(grouped, true).compilationCached, true);
    assert.throws(() => checkBuild(log(false), true));
    assert.throws(() => checkBuild(log(true, true), true));
    assert.throws(() => checkBuild('', true));
    assert.throws(() => checkBuild('{invalid', true));
    assert.throws(() => checkBuild(log(true).replace('2026-01-01T00:00:11Z', 'invalid-date'), true));
    assert.throws(() => checkBuild(log(true).replace('completed', 'unfinished'), true));
    assert.throws(() => checkBuild(log(true) + '\n' + JSON.stringify({ id: 'duplicate', name: '[media-builder 4/4] RUN sh /tmp/build-media', completed: '2026-01-01' }), true));
    console.log('Media build-cache parser checks passed.');
}

function runChecks() {
    const arch = process.env.EXPECTED_ARCH;
    assert.ok(['amd64', 'arm64'].includes(arch), 'EXPECTED_ARCH must be amd64 or arm64');
    assert.equal(os.arch(), arch === 'amd64' ? 'x64' : 'arm64', 'Native host required');
    const engine = spawnSync('docker', ['info', '--format', '{{.Architecture}}'], { encoding: 'utf8' });
    assert.equal(engine.status, 0, 'Docker engine must be available');
    assert.ok((arch === 'amd64' ? ['x86_64', 'amd64'] : ['aarch64', 'arm64']).includes(engine.stdout.trim()), 'Native Docker engine required');
    const root = process.cwd();
    const image = `nodecast-media-cache-probe:${arch}`;
    const nonce = `${Date.now()}-${process.pid}`;
    const results = [];
    function report(value) {
        console.log(JSON.stringify(value));
        if (process.env.MEDIA_CACHE_REPORT) {
            fs.writeFileSync(process.env.MEDIA_CACHE_REPORT, JSON.stringify(value, null, 2) + '\n');
        }
    }
    if (process.argv.includes('--inspect')) {
        const record = spawnSync('docker', ['buildx', 'history', 'logs', '--progress', 'rawjson'],
            { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
        assert.equal(record.status, 0, 'Build record must be available');
        report({ architecture: arch, passed: true, ...checkBuild(
            record.stdout + '\n' + record.stderr,
            process.argv.includes('--require-cached') ? true : undefined
        ) });
        return;
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-media-cache-'));
    try {
        const context = path.join(temporary, 'context');
        fs.mkdirSync(context);
        fs.copyFileSync(path.join(root, 'Dockerfile'), path.join(context, 'Dockerfile'));
        fs.mkdirSync(path.join(context, 'docker'));
        for (const file of ['build-media.sh', 'collect-media-packages.sh']) {
            fs.copyFileSync(path.join(root, 'docker', file), path.join(context, 'docker', file));
        }
        function build(label, cached, extra = []) {
            const start = Date.now();
            const result = spawnSync('docker', [
                'buildx', 'build', '--target', 'media-builder', '--platform', `linux/${arch}`,
                '--pull', '--build-arg', `RUNTIME_REFRESH=cache-probe-${nonce}-${label}`,
                '--progress', 'rawjson', '--load', '--tag', image, ...extra, context
            ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 });
            // Store detailed output locally for failures; avoid replaying all
            // compiler output into an otherwise successful workflow log.
            fs.writeFileSync(path.join(temporary, `${label}.jsonl`), result.stderr || '');
            if (result.status !== 0 || result.error) {
                console.error((result.stderr || '').slice(-8000));
                throw new Error(`${label} build failed: ${result.error?.message || result.status}`);
            }
            const checked = checkBuild(result.stderr, cached);
            const item = { label, ...checked, elapsedSeconds: (Date.now() - start) / 1000 };
            results.push(item);
            console.log(JSON.stringify(item));
        }
        // Explicitly cold compilation; the following run changes the refresh
        // nonce, requiring fresh packages while retaining identical inputs.
        if (!process.argv.includes('--warm-only')) {
            build('cold', false, ['--no-cache-filter', 'media-builder']);
        }
        build('warm', true);
        if (process.argv.includes('--warm-only')) {
            report({ architecture: arch, passed: true, results });
            return;
        }

        // Change a real compiler input without changing the RUN instruction.
        // A harmless header comment must invalidate the compilation cache.
        const dockerfilePath = path.join(context, 'Dockerfile');
        const original = fs.readFileSync(dockerfilePath, 'utf8');
        const start = original.indexOf('FROM ubuntu:24.04 AS media-build-packages');
        const end = original.indexOf('FROM ubuntu:24.04 AS media-builder', start);
        assert.ok(start >= 0 && end > start, 'Expected package/toolchain stages missing');
        const stage = original.slice(start, end);
        const marker = '&& rm -rf /var/lib/apt/lists/*';
        assert.equal(stage.split(marker).length, 2, 'Expected one package cleanup marker');
        const changed = stage.replace(marker, `${marker} \\\n    && printf '\\n/* synthetic cache invalidation probe */\\n' >> /usr/include/stdint.h`);
        fs.writeFileSync(dockerfilePath, original.slice(0, start) + changed + original.slice(end));
        build('changed-header', false);

        // Restore package contents, then change the tracked compilation script.
        fs.writeFileSync(dockerfilePath, original);
        fs.appendFileSync(path.join(context, 'docker/build-media.sh'), '\n# synthetic source cache invalidation probe\n');
        build('changed-source', false);
        report({ architecture: arch, passed: true, results });
    } finally {
        spawnSync('docker', ['image', 'rm', image], { encoding: 'utf8', timeout: 30000 });
        // This is the uniquely generated probe directory, never a repository,
        // source-data directory, application volume or shared test container.
        assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(temporary).startsWith('nodecast-media-cache-'));
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

if (require.main === module) {
    if (process.argv.includes('--self-test')) selfTest();
    else runChecks();
}
module.exports = { readVertices, checkBuild };
