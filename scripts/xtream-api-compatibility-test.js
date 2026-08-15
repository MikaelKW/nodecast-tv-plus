const assert = require('node:assert/strict');
const http = require('node:http');

process.env.ALLOW_LOCAL_MEDIA_URLS = 'true';

const { XtreamApi } = require('../server/services/xtreamApi');

function createHeaderCheckingFixture() {
    return http.createServer((request, response) => {
        const acceptsJson = String(request.headers.accept || '').includes('application/json');
        const hasUserAgent = Boolean(String(request.headers['user-agent'] || '').trim());

        if (!acceptsJson || !hasUserAgent) {
            response.statusCode = 454;
            response.end();
            return;
        }

        const requestUrl = new URL(request.url, 'http://fixture.invalid');
        assert.equal(requestUrl.pathname, '/player_api.php');
        assert.equal(requestUrl.searchParams.get('username'), 'fixture-user');
        assert.equal(requestUrl.searchParams.get('password'), 'fixture-password');

        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ user_info: { auth: 1 } }));
    });
}

async function run() {
    const fixtureServer = createHeaderCheckingFixture();
    await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));

    try {
        const { port } = fixtureServer.address();
        const api = new XtreamApi(
            `http://127.0.0.1:${port}`,
            'fixture-user',
            'fixture-password'
        );
        const result = await api.authenticate();
        assert.equal(result.user_info.auth, 1);
        console.log('Xtream API compatibility header regression test passed.');
    } finally {
        await new Promise(resolve => fixtureServer.close(resolve));
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
