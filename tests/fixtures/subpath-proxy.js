const http = require('node:http');

const listenPort = Number(process.env.NODECAST_TEST_SUBPATH_PORT || 3212);
const upstreamPort = Number(process.env.NODECAST_TEST_APP_PORT || 3210);
const basePath = '/nodecast';

const server = http.createServer((req, res) => {
    if (req.url === basePath) {
        res.writeHead(308, { Location: `${basePath}/` });
        return res.end();
    }

    if (!req.url.startsWith(`${basePath}/`)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Outside configured proxy path');
    }

    const headers = {
        ...req.headers,
        host: `127.0.0.1:${listenPort}`,
        'x-forwarded-host': `127.0.0.1:${listenPort}`,
        'x-forwarded-prefix': basePath,
        'x-forwarded-proto': 'http'
    };

    const proxyRequest = http.request({
        hostname: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: req.url.slice(basePath.length) || '/',
        headers
    }, proxyResponse => {
        res.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
        proxyResponse.pipe(res);
    });

    proxyRequest.on('error', error => {
        if (res.headersSent) return res.destroy(error);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`Proxy error: ${error.message}`);
    });

    req.pipe(proxyRequest);
});

server.listen(listenPort, '127.0.0.1', () => {
    console.log(`[SubpathProxy] Listening on http://127.0.0.1:${listenPort}${basePath}/`);
});

const close = () => server.close();
process.on('SIGINT', close);
process.on('SIGTERM', close);
