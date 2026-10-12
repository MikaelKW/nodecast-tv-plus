const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function run() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-user-management-'));
    process.env.NODECAST_DATA_DIR = directory;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
    process.env.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
    for (const key of ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_AUTH_URL',
        'OIDC_TOKEN_URL', 'OIDC_USERINFO_URL', 'DISABLE_LOCAL_AUTH', 'OIDC_AUTO_REDIRECT']) {
        process.env[key] = '';
    }
    const db = require('../server/db');
    let server;
    async function seed() {
        await db.mutateDb(data => { data.users = []; });
        return Promise.all(['FirstAdmin', 'SecondAdmin'].map(username =>
            db.users.create({ username, role: 'admin' })));
    }
    async function assertOneAdmin() {
        const persisted = JSON.parse(await fs.readFile(path.join(directory, 'db.json'), 'utf8'));
        assert.equal(persisted.users.filter(user => user.role === 'admin').length, 1);
    }
    function assertConflict(results) {
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        const rejected = results.filter(result => result.status === 'rejected');
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reason.code, 'LAST_ADMIN');
    }
    try {
        let admins = await seed();
        assertConflict(await Promise.allSettled(admins.map(user => db.users.update(user.id, { role: 'viewer' }))));
        await assertOneAdmin();
        admins = await seed();
        assertConflict(await Promise.allSettled(admins.map(user => db.users.delete(user.id))));
        await assertOneAdmin();
        for (const deleteFirst of [false, true]) {
            admins = await seed();
            const operations = [() => db.users.update(admins[0].id, { role: 'viewer' }),
                () => db.users.delete(admins[1].id)];
            if (deleteFirst) operations.reverse();
            assertConflict(await Promise.allSettled(operations.map(operation => operation())));
            await assertOneAdmin();
        }

        // Rejected compound updates must not partially change other fields.
        const remaining = (await db.users.getAll()).find(user => user.role === 'admin');
        const before = await fs.readFile(path.join(directory, 'db.json'), 'utf8');
        await assert.rejects(db.users.update(remaining.id, { role: 'viewer', username: 'MustNotPersist' }),
            error => error.code === 'LAST_ADMIN');
        assert.equal(await fs.readFile(path.join(directory, 'db.json'), 'utf8'), before);
        await db.users.update(remaining.id, { username: 'RenamedAdmin', role: 'admin' });
        const viewer = await db.users.create({ username: 'SequentialViewer', role: 'viewer' });
        await db.users.update(viewer.id, { role: 'admin' });
        await db.users.update(remaining.id, { role: 'viewer' });
        await db.users.delete(remaining.id);
        await assertOneAdmin();

        const express = require('express');
        const auth = require('../server/auth');
        const app = express();
        app.use(express.json());
        app.use(require('express-session')({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
        app.use(auth.passport.initialize());
        app.use('/api/auth', require('../server/routes/auth'));
        app.use('/api/users', require('../server/routes/users'));
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
        const base = `http://127.0.0.1:${server.address().port}`;
        async function request(route, method, user, body) {
            const response = await fetch(`${base}${route}`, {
                method, headers: {
                    ...(user ? { Authorization: `Bearer ${auth.generateToken(user)}` } : {}),
                    'Content-Type': 'application/json'
                }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)
            });
            const text = await response.text();
            return { status: response.status, body: response.headers.get('content-type')?.includes('application/json')
                ? JSON.parse(text) : { error: text } };
        }
        // Gate only the tested mutation calls after real authorization. This
        // deterministically overlaps requests without sleeps or auth bypasses.
        async function race(calls, methods) {
            let arrivals = 0;
            let release;
            let fail;
            const gate = new Promise((resolve, reject) => { release = resolve; fail = reject; });
            const timeout = setTimeout(() => fail(new Error('Requests did not reach mutation gate')), 5000);
            const originals = methods.map(([object, key]) => [object, key, object[key]]);
            for (const [object, key, original] of originals) {
                object[key] = async (...args) => {
                    if (++arrivals === calls.length) release();
                    await gate;
                    return original(...args);
                };
            }
            try {
                const results = await Promise.all(calls.map(call => call()));
                assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
                assert.match(results.find(result => result.status === 400).body.error, /last admin/i);
                await assertOneAdmin();
            } finally {
                clearTimeout(timeout);
                for (const [object, key, original] of originals) object[key] = original;
            }
        }

        // Current and legacy routes must preserve the same invariant, even
        // when requests enter through different routes.
        for (const paths of [['/api/auth/users', '/api/auth/users'], ['/api/users', '/api/users'],
            ['/api/auth/users', '/api/users']]) {
            admins = await seed();
            const methods = paths.map(prefix => prefix === '/api/auth/users'
                ? [db.users, 'update'] : [db, 'mutateDb']);
            await race(admins.map((user, index) => () => request(`${paths[index]}/${user.id}`, 'PUT', user, { role: 'viewer' })),
                methods.filter(([object, key], index, all) => all.findIndex(item => item[0] === object && item[1] === key) === index));
        }
        for (const prefix of ['/api/auth/users', '/api/users']) {
            admins = await seed();
            await race([
                () => request(`${prefix}/${admins[0].id}`, 'PUT', admins[0], { role: 'viewer' }),
                () => request(`${prefix}/${admins[1].id}`, 'DELETE', admins[0])
            ], prefix === '/api/auth/users' ? [[db.users, 'update'], [db.users, 'delete']] : [[db, 'mutateDb']]);
            admins = await seed();
            await race([
                () => request(`${prefix}/${admins[1].id}`, 'DELETE', admins[0]),
                () => request(`${prefix}/${admins[0].id}`, 'DELETE', admins[1])
            ], prefix === '/api/auth/users' ? [[db.users, 'delete']] : [[db, 'mutateDb']]);
        }

        admins = await seed();
        assert.equal((await request(`/api/auth/users/${admins[0].id}`, 'DELETE', admins[0])).status, 400);
        const ordinary = await db.users.create({ username: 'OrdinaryViewer', role: 'viewer' });
        for (const prefix of ['/api/auth/users', '/api/users']) {
            assert.equal((await request(`${prefix}/${admins[0].id}`, 'PUT', null, { role: 'viewer' })).status, 401);
            assert.equal((await request(`${prefix}/${admins[0].id}`, 'PUT', ordinary, { role: 'viewer' })).status, 403);
            assert.equal((await request(`${prefix}/${admins[0].id}`, 'DELETE', ordinary)).status, 403);
            assert.equal((await request(`${prefix}/${admins[0].id}`, 'PUT', admins[1], { role: 'invalid' })).status, 400);
        }
        assert.equal((await request(`/api/auth/users/${ordinary.id}`, 'PUT', admins[0], { username: 'EditedViewer' })).status, 200);
        assert.equal((await request(`/api/auth/users/${ordinary.id}`, 'DELETE', admins[0])).status, 200);
        // A route check must use current stored roles rather than JWT roles.
        await db.users.update(admins[1].id, { role: 'viewer' });
        assert.equal((await request(`/api/auth/users/${admins[0].id}`, 'PUT', admins[1], { role: 'viewer' })).status, 403);
        assert.equal((await request(`/api/auth/users/${admins[0].id}`, 'PUT', admins[0], { role: 'viewer' })).status, 400);

        delete require.cache[require.resolve('../server/db')];
        const restarted = require('../server/db');
        assert.equal((await restarted.users.getAll()).filter(user => user.role === 'admin').length, 1);
        console.log('Administrator preservation and account-management regression checks passed.');
    } finally {
        if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await fs.rm(directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
