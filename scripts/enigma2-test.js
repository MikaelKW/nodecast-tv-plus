'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { getEventListeners } = require('node:events');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-enigma-'));
process.env.NODECAST_DATA_DIR = directory;
process.env.NODECAST_CACHE_DIR = path.join(directory, 'cache');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
process.env.ALLOW_LOCAL_MEDIA_URLS = 'true';
process.env.NODECAST_DISABLE_BACKGROUND_JOBS = 'true';
const { parseProgram, selectProgramStreams } = require('../server/services/mpegTsProgram');
const { parseZapOptions, serviceReference } = require('../server/services/enigma2');
const parser = require('../server/services/m3uParser');
const db = require('../server/db');
const sqlite = require('../server/db/sqlite');
const { buildRemuxArgs } = require('../server/services/remux');
const { TranscodeSession } = require('../server/services/transcodeSession');
const { resolveFFmpegPath } = require('../server/services/ffmpegBinary');
const ffmpeg = resolveFFmpegPath().path;
const probeVersion = spawnSync('ffprobe', ['-version'], { stdio: 'ignore', windowsHide: true });
const ffprobe = probeVersion.status === 0 ? 'ffprobe' : require('@ffprobe-installer/ffprobe').path;
const ref = '1:0:1:65:65:53:CE40000:0:0:0:';
function tool(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(result.status, 0, result.stderr || 'Media fixture process failed');
    return result.stdout;
}
function load(file, extra = {}) {
    const sandbox = { window: {}, console, AbortController, DOMException, setTimeout, clearTimeout, ...extra };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox);
    return sandbox;
}
async function clientTests() {
    const { window } = load('public/js/components/VideoPlayer.js');
    const zap = window.VideoPlayer.prototype.zapBeforeStreaming;
    let calls = 0;
    const player = { async requestPlaybackResource(url, options) {
        calls++;
        assert.equal(url, '/api/openwebif/zap');
        assert.deepEqual(JSON.parse(options.body), { sourceId: 1, streamId: ref });
        return { ok: true, async json() { return { success: true }; } };
    } };
    const channel = { sourceId: 1, streamId: ref, zapDelay: 0 };
    const controller = new AbortController();
    await zap.call(player, channel, controller.signal);
    assert.equal(calls, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort();
    await assert.rejects(zap.call(player, channel, controller.signal), error => error.name === 'AbortError');
    assert.equal(calls, 1, 'Already cancelled startup must not tune the receiver');
    const pending = new AbortController();
    const operation = zap.call(player, { ...channel, zapDelay: 10000 }, pending.signal);
    setTimeout(() => pending.abort(), 10);
    await assert.rejects(operation, error => error.name === 'AbortError');
    assert.equal(getEventListeners(pending.signal, 'abort').length, 0);
    const failed = { async requestPlaybackResource() { return { ok: false }; } };
    await assert.rejects(zap.call(failed, channel, new AbortController().signal), /could not be tuned/);

    const live = load('public/js/pages/LivePage.js', { document: { removeEventListener() {} } }).window.LivePage;
    let stops = 0;
    const context = { app: { player: { _zapPendingPlayId: 1, stop() { stops++; } } } };
    live.prototype.hide.call(context);
    context.app.player._zapPendingPlayId = null;
    live.prototype.hide.call(context);
    assert.equal(stops, 1, 'Leaving Live cancels pending tuning, not established background playback');

    const urls = load('public/js/basePath.js', {
        document: { currentScript: { src: 'https://nodecast.example/nodecast/js/basePath.js' } },
        window: { location: { href: 'https://nodecast.example/nodecast/', origin: 'https://nodecast.example' } },
        URL, URLSearchParams
    }).window.NodeCastUrl;
    const remux = new URL(urls.remux('https://receiver.example/input.ts', { audio: 'aac' }, '202'), 'https://nodecast.example');
    assert.equal(remux.pathname, '/nodecast/api/remux');
    assert.equal(remux.searchParams.get('program'), '202');
    const list = load('public/js/components/ChannelList.js').window.ChannelList;
    const mapped = list.prototype._mapBoundedChannel.call({}, { stream_id: ref, program: '202' },
        { id: 1, type: 'm3u', zapBeforeStreaming: true, zapDelay: 0 });
    assert.equal(mapped.program, '202');
    assert.equal(mapped.zapBeforeStreaming, true);
    assert.equal(mapped.zapDelay, 0);
    const ordinary = list.prototype._mapBoundedChannel.call({}, { stream_id: 'ordinary' }, { id: 1, type: 'm3u' });
    assert.equal(Object.hasOwn(ordinary, 'program'), false);
    assert.equal(Object.hasOwn(ordinary, 'zapBeforeStreaming'), false);
}
async function run() {
    let receiver;
    let application;
    let managed;
    try {
        for (const value of [undefined, null]) assert.equal(parseProgram(value), null);
        assert.equal(parseProgram('00202'), '202');
        for (const value of ['', 0, 65536, -1, 1.2, true, [], {}, '1;bad']) assert.throws(() => parseProgram(value));
        assert.deepEqual(selectProgramStreams({ programs: [{ program_id: 202, streams: [{ index: 2 }] }] }, '202'), [{ index: 2 }]);
        assert.throws(() => selectProgramStreams({}, '202'), /not found/);
        assert.deepEqual(parseZapOptions({ zapBeforeStreaming: true, zapDelay: 0 }, 'm3u'), { zapBeforeStreaming: true, zapDelay: 0 });
        assert.deepEqual(parseZapOptions({}, 'm3u'), {}, 'Omitted options must not overwrite concurrent source changes');
        assert.throws(() => parseZapOptions({ zapDelay: -1 }, 'm3u'));
        assert.throws(() => parseZapOptions({ zapDelay: 10001 }, 'm3u'));
        assert.throws(() => parseZapOptions({ zapBeforeStreaming: 'false' }, 'm3u'));
        assert.throws(() => parseZapOptions({ zapBeforeStreaming: true }, 'xtream'));
        assert.equal(serviceReference({ stream_id: 'generated-id', stream_url: `http://receiver.example:8001/${ref}` }), ref);
        assert.throws(() => serviceReference({ stream_id: 'not-a-reference', stream_url: 'http://receiver.example/anything' }));
        const playlist = '#EXTM3U\n#EXTINF:-1,One\n#EXTVLCOPT:program=202\nhttp://receiver.example/one\n#EXTINF:-1,Two\nhttp://receiver.example/two\n';
        const parsed = await parser.parse(playlist);
        const streamed = [];
        for await (const batch of parser.parseStreaming(playlist, 1)) streamed.push(...batch.channels);
        assert.deepEqual(streamed, parsed.channels);
        assert.equal(parsed.channels[0].program, '202');
        assert.equal(parsed.channels[1].program, undefined, 'A program tag must not leak to the next channel');
        const orphaned = await parser.parse('#EXTVLCOPT:program=202\n#EXTINF:-1,One\nhttp://receiver.example/one');
        assert.equal(orphaned.channels[0].program, undefined);
        await clientTests();

        const media = path.join(directory, 'multi-program.ts');
        tool(ffmpeg, ['-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
            '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15',
            '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
            '-t', '12', '-map', '0:v', '-map', '1:a', '-map', '2:v', '-map', '3:a',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-c:a', 'aac',
            '-program', 'program_num=101:st=0:st=1', '-program', 'program_num=202:st=2:st=3', '-f', 'mpegts', media]);
        let origin;
        let mode = 'success';
        let tunes = 0;
        let redirects = 0;
        receiver = http.createServer((req, res) => {
            if (req.url.startsWith('/web/zap')) {
                tunes++;
                assert.equal(new URL(req.url, origin).searchParams.get('sRef'), ref);
                if (mode === 'redirect') { res.writeHead(302, { Location: '/redirect-target' }); return res.end(); }
                if (mode === 'oversize') return res.end('x'.repeat(17000));
                return res.end(`<e2simplexmlresult><e2state>${mode === 'success' ? 'True' : 'False'}</e2state></e2simplexmlresult>`);
            }
            if (req.url === '/redirect-target') { redirects++; return res.end('unexpected'); }
            if (req.url === '/test.m3u') return res.end(`#EXTM3U\n#EXTINF:-1 tvg-id="test-channel" group-title="Synthetic",Program Test\n#EXTVLCOPT:program=202\n${origin}/${ref}\n`);
            res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': fs.statSync(media).size });
            if (req.method === 'HEAD') return res.end();
            const input = fs.createReadStream(media);
            input.on('error', error => res.destroy(error));
            res.on('close', () => input.destroy());
            input.pipe(res);
        });
        await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
        origin = `http://127.0.0.1:${receiver.address().port}`;
        const source = await db.sources.create({ type: 'm3u', name: 'Synthetic receiver', url: `${origin}/test.m3u`, zapBeforeStreaming: true, zapDelay: 0 });
        await require('../server/services/syncService').syncSource(source.id);
        const sourceChannel = require('../server/services/catalogueService').getLiveChannel(source.id, 'test-channel');
        assert.equal(sourceChannel.program, '202', 'Program metadata must survive synchronization and catalogue lookup');
        const admin = await db.users.create({ username: 'SyntheticAdmin', role: 'admin' });
        const viewer = await db.users.create({ username: 'SyntheticViewer', role: 'viewer' });
        const auth = require('../server/auth');
        auth.configureJwtStrategy(id => db.users.getById(id));
        const express = require('express');
        const app = express();
        app.locals.ffmpegPath = ffmpeg;
        app.locals.ffprobePath = ffprobe;
        app.use(express.json(), auth.passport.initialize());
        for (const name of ['openwebif', 'sources', 'probe', 'remux', 'favorites']) app.use(`/api/${name}`, require(`../server/routes/${name}`));
        application = app.listen(0, '127.0.0.1');
        await new Promise(resolve => application.once('listening', resolve));
        const base = `http://127.0.0.1:${application.address().port}`;
        async function request(route, user = viewer, body, method = body === undefined ? 'GET' : 'POST') {
            return fetch(base + route, { method,
                headers: { ...(user ? { Authorization: `Bearer ${auth.generateToken(user)}` } : {}), 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        }
        const zapBody = { sourceId: source.id, streamId: 'test-channel' };
        assert.equal((await request('/api/openwebif/zap', null, zapBody)).status, 401);
        assert.equal(tunes, 0);
        assert.equal((await request('/api/openwebif/zap', viewer, { ...zapBody, streamId: 'unknown' })).status, 404);
        assert.equal((await request('/api/openwebif/zap', viewer, zapBody)).status, 200);
        const listed = await (await request('/api/sources')).json();
        assert.equal(listed[0].url, undefined);
        assert.equal(listed[0].zapBeforeStreaming, true);
        assert.equal(listed[0].zapDelay, 0);
        const edited = await request(`/api/sources/${source.id}`, admin, { name: 'Renamed synthetic receiver' }, 'PUT');
        assert.equal(edited.status, 200);
        assert.equal((await edited.json()).zapDelay, 0);
        assert.equal((await db.sources.getById(source.id)).zapBeforeStreaming, true);
        assert.equal((await request(`/api/sources/${source.id}`, admin, { zapDelay: 10001 }, 'PUT')).status, 400);
        mode = 'redirect';
        assert.equal((await request('/api/openwebif/zap', viewer, zapBody)).status, 502);
        assert.equal(redirects, 0, 'Tuning must not follow receiver redirects');
        mode = 'failure';
        assert.equal((await request('/api/openwebif/zap', viewer, zapBody)).status, 502);
        mode = 'oversize';
        assert.equal((await request('/api/openwebif/zap', viewer, zapBody)).status, 502);
        await db.sources.update(source.id, { zapBeforeStreaming: false });
        assert.equal((await request('/api/openwebif/zap', viewer, zapBody)).status, 404);
        await db.sources.update(source.id, { zapBeforeStreaming: true });
        sqlite.favorites.add(viewer.id, source.id, 'test-channel', 'channel');
        const favorites = await (await request('/api/favorites/channels')).json();
        assert.equal(favorites[0].program, '202');
        assert.equal(favorites[0].zapBeforeStreaming, true);

        const query = new URLSearchParams({ url: `${origin}/${ref}` });
        const normal = await (await request(`/api/probe?${query}`)).json();
        query.set('program', '202');
        const selected = await (await request(`/api/probe?${query}`)).json();
        assert.equal(normal.width, 160);
        assert.equal(selected.width, 320, 'Probe/cache must select the requested program');
        assert.equal(selected.audioTracks.length, 1);
        assert.equal((await request(`/api/probe?${query}&program=invalid`)).status, 400);
        query.set('audioCodecs', 'aac');
        const response = await request(`/api/remux?${query}`);
        assert.equal(response.status, 200);
        const output = path.join(directory, 'selected.mp4');
        fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));
        const info = JSON.parse(tool(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output]));
        assert.equal(info.streams.find(stream => stream.codec_type === 'video').width, 320);
        assert.equal(info.streams.filter(stream => stream.codec_type === 'audio').length, 1);
        tool(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-xerror', '-i', output, '-f', 'null', '-']);
        const args = buildRemuxArgs({ url: `${origin}/${ref}`, userAgent: 'Synthetic test', program: 202 });
        assert.ok(args.includes('0:p:202:v:0'));
        const session = new TranscodeSession(`${origin}/${ref}`, { program: 202, videoMode: 'copy' });
        const sessionArgs = session.buildFFmpegArgs();
        assert.ok(sessionArgs.includes('0:p:202:v:0'));
        assert.ok(sessionArgs.includes('0:p:202:a:0?'));
        assert.throws(() => new TranscodeSession(`${origin}/${ref}`, { program: 0 }));
        managed = new TranscodeSession(`${origin}/${ref}`, {
            ffmpegPath: ffmpeg, program: 202, videoMode: 'copy', videoCodec: 'h264',
            audioCodec: 'aac', audioChannels: 1, hwEncoder: 'software'
        });
        assert.equal(await managed.startAndWaitForPlaylist(15000), true);
        const managedInfo = JSON.parse(tool(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', managed.playlistPath]));
        assert.equal(managedInfo.streams.find(stream => stream.codec_type === 'video').width, 320);
        assert.equal(managedInfo.streams.filter(stream => stream.codec_type === 'audio').length, 1);
        assert.equal((await request('/api/sources', viewer, { type: 'm3u', name: 'Not permitted', url: `${origin}/test.m3u` })).status, 403);
        assert.ok(admin.id);
        console.log('Enigma2 parser, program/probe/remux, source permissions, receiver and cancellation tests passed.');
    } finally {
        if (managed) await managed.stop();
        for (const server of [application, receiver]) if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        try { sqlite.getDb().close(); } catch { /* Nothing may have opened it. */ }
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
