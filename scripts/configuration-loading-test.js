const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const entrypoint = path.join(projectRoot, 'server/index.js');
const preload = path.join(__dirname, 'helpers/configuration-loading-preload.cjs');
const packageVersion = require('../package.json').version;

function getFreePort() {
    return new Promise((resolve, reject) => {
        const listener = net.createServer();
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => {
            const port = listener.address().port;
            listener.close(error => error ? reject(error) : resolve(port));
        });
    });
}

async function stopServer(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    let timer;
    child.kill('SIGTERM');
    try {
        await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    } finally {
        clearTimeout(timer);
    }
    if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
    }
}

async function checkStartup(root, mode) {
    const directory = path.join(root, mode);
    await fs.mkdir(directory);
    const port = await getFreePort();
    const expected = {
        jwt: crypto.randomBytes(48).toString('hex'),
        session: crypto.randomBytes(48).toString('hex'),
        totp: crypto.randomBytes(48).toString('hex'),
        basePath: `/configuration-${mode}`,
        values: {}
    };
    // A small allowlist prevents the invoking shell's dotenv options, secrets,
    // NODE_OPTIONS or provider configuration from affecting this test server.
    const env = {
        NODECAST_DATA_DIR: path.join(directory, 'data'),
        NODECAST_CACHE_DIR: path.join(directory, 'cache'),
        NODECAST_INSTANCE_ID: crypto.randomUUID(),
        NODECAST_DISABLE_BACKGROUND_JOBS: 'true'
    };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const injected = {
        NODE_ENV: 'production', PORT: String(port), NODECAST_BASE_PATH: expected.basePath,
        JWT_SECRET: expected.jwt, SESSION_SECRET: expected.session, TOTP_ENCRYPTION_KEY: expected.totp
    };
    const testSecrets = Object.values(expected).filter(value => typeof value === 'string');
    if (mode !== 'file') Object.assign(env, injected);
    if (mode === 'empty') await fs.writeFile(path.join(directory, '.env'), '', { mode: 0o600 });
    if (mode === 'file' || mode === 'precedence') {
        const fileConfig = { ...injected };
        if (mode === 'precedence') {
            fileConfig.PORT = '0';
            fileConfig.NODE_ENV = 'development';
            fileConfig.NODECAST_BASE_PATH = '/incorrect-file-value';
            for (const key of ['JWT_SECRET', 'SESSION_SECRET', 'TOTP_ENCRYPTION_KEY']) {
                fileConfig[key] = crypto.randomBytes(48).toString('hex');
                testSecrets.push(fileConfig[key]);
            }
        }
        expected.values = {
            CONFIG_TEST_QUOTED: 'value # not a comment',
            CONFIG_TEST_MULTILINE: 'first line\nsecond line',
            CONFIG_TEST_LITERAL: 'literal\\nvalue',
            CONFIG_TEST_UNICODE: 'æøå',
            CONFIG_TEST_EMPTY: ''
        };
        if (mode === 'precedence') {
            env.CONFIG_TEST_EXISTING_EMPTY = '';
            expected.values.CONFIG_TEST_EXISTING_EMPTY = '';
        }
        const text = '\ufeff' + Object.entries(fileConfig).map(([key, value]) => `${key}=${value}`).join('\r\n')
            + '\r\nCONFIG_TEST_QUOTED="value # not a comment" # comment\r\n'
            + 'CONFIG_TEST_MULTILINE="first line\\nsecond line"\r\n'
            + "CONFIG_TEST_LITERAL='literal\\nvalue'\r\n"
            + 'export CONFIG_TEST_UNICODE=æøå\r\nCONFIG_TEST_EMPTY=\r\nCONFIG_TEST_EXISTING_EMPTY=file-value\r\ninvalid declaration\r\n';
        await fs.writeFile(path.join(directory, '.env'), text, { mode: 0o600 });
    }
    let output = '';
    const child = spawn(process.execPath, ['-r', preload, entrypoint], {
        cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });
    const observed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.on('message', message => {
            if (message?.type === 'configuration-observed') resolve(message);
        });
        child.once('exit', code => reject(new Error(`Configuration server exited (${code}) before reporting configuration.`)));
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.stdin.end(JSON.stringify(expected));
    try {
        let deadline;
        let actual;
        try {
            actual = await Promise.race([
                observed,
                new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Configuration observation timed out.')), 15000); })
            ]);
        } finally {
            clearTimeout(deadline);
        }
        for (const key of ['jwtMatches', 'sessionMatches', 'totpMatches', 'basePathMatches', 'production', 'valuesMatch']) {
            assert.equal(actual[key], true, `${mode}: ${key}`);
        }
        const url = `http://127.0.0.1:${port}${expected.basePath}/api/health`;
        const until = Date.now() + 15000;
        let healthy = false;
        while (Date.now() < until) {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${mode}: server exited before health check.`);
            try {
                const response = await fetch(url, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(1000) });
                if (response.ok) {
                    assert.deepEqual(await response.json(), { status: 'ok', version: packageVersion });
                    healthy = true;
                    break;
                }
            } catch (error) {
                if (error instanceof assert.AssertionError) throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(healthy, true, `${mode}: application must start with the expected port and base path`);
    } catch (error) {
        for (const secret of testSecrets) output = output.split(secret).join('[redacted]');
        console.error(output);
        throw error;
    } finally {
        await stopServer(child);
    }
}

async function run() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-configuration-'));
    try {
        for (const mode of ['missing', 'empty', 'file', 'precedence']) await checkStartup(root, mode);
        console.log('Configuration loading tests passed for missing/empty files, file parsing, environment precedence and production startup.');
    } finally {
        assert.ok(root.startsWith(path.join(os.tmpdir(), 'nodecast-configuration-')));
        await fs.rm(root, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
