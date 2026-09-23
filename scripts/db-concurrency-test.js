const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-db-concurrency-'));
  process.env.NODECAST_DATA_DIR = dataDir;
  const db = require('../server/db');
  const dbPath = path.join(dataDir, 'db.json');

  try {
    const count = 12;
    const created = await Promise.all(Array.from({ length: count }, (_, index) =>
      db.sources.create({
        type: 'm3u',
        name: `Concurrent source ${index}`,
        url: `https://example.invalid/playlist-${index}.m3u`
      })
    ));
    assert.equal(new Set(created.map(source => source.id)).size, count, 'source IDs must be unique');
    assert.equal((await db.sources.getAll()).length, count, 'every successful source create must persist');

    await Promise.all(created.map((source, index) =>
      db.sources.update(source.id, {
        name: `Updated source ${index}`,
        contentVisibility: { movies: false }
      })
    ));
    const updated = await db.sources.getAll();
    assert.deepEqual(updated.map(source => source.name).sort(),
      Array.from({ length: count }, (_, index) => `Updated source ${index}`).sort());
    assert.ok(updated.every(source => source.contentVisibility.movies === false));

    await Promise.all([
      db.sources.update(created[0].id, { name: 'Shared source update' }),
      db.sources.update(created[0].id, { url: 'https://example.invalid/updated.m3u' })
    ]);
    const sharedSource = await db.sources.getById(created[0].id);
    assert.equal(sharedSource.name, 'Shared source update');
    assert.equal(sharedSource.url, 'https://example.invalid/updated.m3u');

    await Promise.all(created.map(source => db.sources.toggleEnabled(source.id)));
    assert.ok((await db.sources.getAll()).every(source => source.enabled === false));

    const sourceId = created[0].id;
    await Promise.all([
      db.settings.update({ defaultVolume: 37 }),
      db.users.create({ username: 'ConcurrentViewer', role: 'viewer' }),
      db.hiddenItems.hide(sourceId, 'channel', 'hidden-channel'),
      db.favorites.add(sourceId, 'favorite-channel'),
      db.sources.update(sourceId, { name: 'Final source name' })
    ]);
    const mixed = await db.loadDb();
    assert.equal(mixed.settings.defaultVolume, 37);
    assert.equal(mixed.users.length, 1);
    assert.equal(mixed.hiddenItems.length, 1);
    assert.equal(mixed.favorites.length, 1);
    assert.equal(mixed.sources.find(source => source.id === sourceId).name, 'Final source name');
    assert.equal(new Set([
      ...mixed.sources.map(source => source.id),
      ...mixed.users.map(user => user.id),
      ...mixed.hiddenItems.map(item => item.id),
      ...mixed.favorites.map(item => item.id)
    ]).size, count + 3, 'all JSON-backed records must have distinct IDs');

    const duplicateUsers = await Promise.allSettled([
      db.users.create({ username: 'DuplicateViewer' }),
      db.users.create({ username: 'duplicateviewer' })
    ]);
    assert.equal(duplicateUsers.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(duplicateUsers.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await db.loadDb()).users.length, 2);

    // A source route may have read an older copy while another request saved.
    // Omitted request fields must not be filled from that stale copy.
    const express = require('express');
    const auth = require('../server/auth');
    auth.requireAuth = (_req, _res, next) => next();
    auth.requireAdmin = (_req, _res, next) => next();
    const app = express();
    app.use(express.json());
    app.use('/api/sources', require('../server/routes/sources'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const staleSource = await db.sources.getById(sourceId);
    const originalGetById = db.sources.getById;
    db.sources.getById = async () => staleSource;
    try {
      const endpoint = `http://127.0.0.1:${server.address().port}/api/sources/${sourceId}`;
      for (const body of [{ name: 'Route-updated name' }, { contentVisibility: { movies: true } }]) {
        const response = await fetch(endpoint, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        assert.equal(response.status, 200);
      }
      const routeUpdated = (await db.loadDb()).sources.find(source => source.id === sourceId);
      assert.equal(routeUpdated.name, 'Route-updated name');
      assert.equal(routeUpdated.contentVisibility.movies, true);
    } finally {
      db.sources.getById = originalGetById;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }

    const deletedId = created[1].id;
    await db.sources.delete(deletedId);
    assert.equal(await db.sources.getById(deletedId), undefined);
    assert.equal((await db.sources.getAll()).length, count - 1);

    const validContent = await fs.readFile(dbPath, 'utf8');
    await fs.writeFile(dbPath, '{not valid JSON');
    await assert.rejects(db.sources.create({ type: 'm3u', name: 'Must not save' }));
    assert.equal(await fs.readFile(dbPath, 'utf8'), '{not valid JSON', 'a failed read must not overwrite data');
    await fs.writeFile(dbPath, '[]');
    await assert.rejects(db.sources.create({ type: 'm3u', name: 'Must not save' }));
    assert.equal(await fs.readFile(dbPath, 'utf8'), '[]', 'a malformed document must not be replaced');
    await fs.writeFile(dbPath, validContent);

    const databaseFs = require('fs/promises');
    const rename = databaseFs.rename;
    let renameAttempts = 0;
    databaseFs.rename = async (...args) => {
      renameAttempts += 1;
      if (renameAttempts === 1) {
        const error = new Error('Temporary file lock');
        error.code = 'EPERM';
        throw error;
      }
      return rename(...args);
    };
    try {
      await db.settings.update({ defaultVolume: 37 });
      assert.equal(renameAttempts, 2, 'a transient rename failure should be retried');
    } finally {
      databaseFs.rename = rename;
    }

    const tempPath = `${dbPath}.tmp`;
    await fs.mkdir(tempPath);
    await assert.rejects(db.sources.create({ type: 'm3u', name: 'Must not report success' }));
    await fs.rmdir(tempPath);
    const recovered = await db.sources.create({ type: 'm3u', name: 'Recovered source' });
    assert.ok(recovered.id > Math.max(...created.map(source => source.id)));

    delete require.cache[require.resolve('../server/db')];
    const restartedDb = require('../server/db');
    assert.equal((await restartedDb.sources.getAll()).length, count);
    assert.equal((await restartedDb.sources.getById(recovered.id)).name, 'Recovered source');
    assert.equal((await restartedDb.settings.get()).defaultVolume, 37);

    console.log('Concurrent JSON database mutations passed.');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
