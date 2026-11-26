const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { waitForApplicationReady } = require('../../scripts/helpers/applicationReadiness');

async function withIsolatedReadinessApp(baseURL, run) {
    const basePath = new URL(baseURL).pathname.replace(/\/$/, '');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-readiness-browser-'));
    const child = fork(require.resolve('./isolated-readiness-server.cjs'), [], {
        cwd: path.resolve(__dirname, '../..'),
        execArgv: [],
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: '0',
            NODECAST_DATA_DIR: path.join(directory, 'data'),
            NODECAST_CACHE_DIR: path.join(directory, 'cache'),
            NODECAST_BASE_PATH: basePath,
            NODECAST_DISABLE_BACKGROUND_JOBS: 'true',
            JWT_SECRET: randomBytes(48).toString('hex'),
            SESSION_SECRET: randomBytes(48).toString('hex'),
            TOTP_ENCRYPTION_KEY: randomBytes(48).toString('hex'),
            APP_ORIGIN: '',
            OIDC_ISSUER_URL: '',
            OIDC_AUTH_URL: '',
            OIDC_TOKEN_URL: '',
            OIDC_USERINFO_URL: '',
            DISABLE_LOCAL_AUTH: '',
            OIDC_AUTO_REDIRECT: ''
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    child.stdout.resume();
    child.stderr.resume();
    const exited = new Promise(resolve => child.once('close', resolve));
    let proxy;
    try {
        const port = await new Promise((resolve, reject) => {
            const finish = (error, value) => {
                clearTimeout(timer);
                child.off('message', onMessage);
                child.off('error', onError);
                child.off('exit', onExit);
                if (error) reject(error);
                else resolve(value);
            };
            const onMessage = message => {
                if (Number.isInteger(message?.port)) finish(null, message.port);
            };
            const onError = error => finish(error);
            const onExit = () => finish(new Error('Isolated readiness server exited before listening'));
            const timer = setTimeout(() => finish(new Error('Isolated readiness server did not listen')), 10000);
            child.on('message', onMessage);
            child.once('error', onError);
            child.once('exit', onExit);
        });
        let origin = `http://127.0.0.1:${port}`;
        await waitForApplicationReady(origin + basePath);
        if (basePath) {
            // Retain a real path-stripping proxy for the subpath project, but
            // forward only to this test's private server and database.
            proxy = http.createServer((req, res) => {
                if (!req.url.startsWith(`${basePath}/`)) {
                    res.writeHead(404);
                    return res.end();
                }
                const upstream = http.request({
                    hostname: '127.0.0.1', port, method: req.method,
                    path: req.url.slice(basePath.length),
                    headers: {
                        ...req.headers,
                        'x-forwarded-prefix': basePath,
                        'x-forwarded-proto': 'http'
                    }
                }, response => {
                    res.writeHead(response.statusCode, response.headers);
                    response.pipe(res);
                });
                upstream.on('error', () => {
                    if (res.headersSent) return res.destroy();
                    res.writeHead(502);
                    res.end();
                });
                req.pipe(upstream);
            });
            await new Promise((resolve, reject) => {
                proxy.once('error', reject);
                proxy.listen(0, '127.0.0.1', resolve);
            });
            origin = `http://127.0.0.1:${proxy.address().port}`;
        }
        await run(origin + basePath);
    } finally {
        if (proxy) {
            proxy.closeAllConnections();
            await new Promise(resolve => proxy.close(resolve));
        }
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 10000);
        try { await exited; } finally { clearTimeout(force); }
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

module.exports = { withIsolatedReadinessApp };
