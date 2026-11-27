'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const service = require('../server/services/authAudit');

function fixture(max = 1000) {
    const database = new Database(':memory:');
    let time = Date.parse('2026-11-25T12:00:00Z');
    let unavailable = false;
    let unreadable = false;
    let reads = 0;
    const warnings = [];
    const make = () => service.createAuthAudit({
        getDb: () => { reads += 1; if (unavailable) throw new Error('Synthetic storage failure'); return database; },
        getSettings: async () => { if (unreadable) throw new Error('Synthetic policy failure');
            return { authLogRetentionDays: 90, authLogMaxEntries: max }; },
        now: () => time, logger: { warn: (...args) => warnings.push(args.join(' ')) }
    });
    return { database, audit: make(), make, warnings, at: () => time, reads: () => reads,
        advance(ms) { time += ms; }, failStorage(value) { unavailable = value; }, failPolicy(value) { unreadable = value; } };
}
const activity = (id, event = 'sign_out', outcome = 'success') => ({ event, outcome, method: 'password',
    user: { id, username: `account-${id}` } });
const failure = () => ({ event: 'sign_in', outcome: 'failure', reason: 'rate_limited', context: { ip: '192.0.2.7' } });

async function testActivityAdmission() {
    const f = fixture();
    try {
        await f.audit.prune();
        f.audit.record(activity(1, 'sign_in'));
        for (let i = 0; i < 1000; i++) {
            f.audit.record(activity(2, 'sign_out'));
            f.audit.record(activity(2, 'sign_in'));
            f.audit.record(activity(2, 'sign_in', 'mfa_required'));
        }
        assert.equal(f.audit.flushPending(), true);
        await f.audit.prune();
        assert.equal(f.audit.query({ account: 'account-1' }).total, 1);
        const rows = f.database.prepare('SELECT event,outcome,summary_event,occurrences FROM auth_events WHERE user_id=2').all();
        assert.equal(rows.filter(row => row.event !== 'activity_summary').length, service.ACTIVITY_ACCOUNT_LIMIT);
        assert.equal(rows.reduce((sum, row) => sum + row.occurrences, 0), 3000);
        assert.deepEqual(rows.filter(row => row.event === 'activity_summary').map(row => [row.summary_event, row.outcome]).sort(),
            [['sign_in', 'mfa_required'], ['sign_in', 'success'], ['sign_out', 'success']]);
        assert.equal(f.audit.record({ event: 'activity_summary', outcome: 'success' }), false);
        assert.equal(f.audit.record({ event: 'sign_in', outcome: 'summary' }), false);
    } finally { await f.audit.prune(); f.database.close(); }
}

async function testManyAccountsRemainBounded() {
    const f = fixture();
    try {
        await f.audit.prune();
        for (let id = 1; id <= 5000; id++) f.audit.record(activity(id, 'sign_in'));
        f.audit.flushPending();
        const rows = f.database.prepare('SELECT * FROM auth_events').all();
        assert.equal(rows.filter(row => row.event !== 'activity_summary').length, service.ACTIVITY_LIMIT);
        assert.equal(rows.length, service.ACTIVITY_LIMIT + service.ACTIVITY_PENDING_KEYS + 1);
        assert.equal(rows.reduce((sum, row) => sum + row.occurrences, 0), 5000);
        const mixed = rows.find(row => row.outcome === 'summary');
        assert.equal(mixed.user_id, null);
        assert.equal(mixed.username, null);
        assert.equal(JSON.parse(mixed.activity_counts)['sign_in:success:password'], 5000 - service.ACTIVITY_LIMIT - service.ACTIVITY_PENDING_KEYS);
    } finally { await f.audit.prune(); f.database.close(); }
}

async function testFairSharingAndCapacityWarning() {
    const f = fixture();
    try {
        await f.audit.prune();
        f.audit.record(activity(1, 'sign_in'));
        for (let i = 0; i < 1000; i++) {
            f.audit.record(activity(2));
            f.advance(service.FAILURE_WINDOW_MS);
        }
        await f.audit.prune();
        assert.equal(f.audit.query({ account: 'account-1' }).total, 1);
        assert.equal(f.audit.query({ account: 'account-2' }).total, 699);
        assert.equal(f.warnings.length, 0);
        f.database.prepare('DELETE FROM auth_events').run();
        const insert = f.database.prepare("INSERT INTO auth_events(created_at,event,outcome,user_id,username,category) VALUES(?,'sign_in','success',?,?,'activity')");
        f.database.transaction(() => { for (let id = 1; id <= 701; id++) insert.run(f.at() + id, id, `account-${id}`); })();
        await f.audit.prune();
        assert.equal(f.audit.query().total, 700);
        assert.equal(f.database.prepare('SELECT COUNT(*) n FROM auth_events WHERE user_id=1').get().n, 0);
        assert.equal(f.warnings.filter(message => message.includes('single-account')).length, 1);
        insert.run(f.at() + 702, 702, 'account-702');
        await f.audit.prune();
        assert.equal(f.warnings.filter(message => message.includes('single-account')).length, 1, 'Capacity fallback warns once per running process.');
    } finally { await f.audit.prune(); f.database.close(); }
}

async function testPopulatedLogCleanup() {
    const f = fixture(50000);
    try {
        await f.audit.prune();
        const insert = f.database.prepare("INSERT INTO auth_events(created_at,event,outcome,user_id,username,category) VALUES(?,'sign_in','success',?,?,'activity')");
        f.database.transaction(() => {
            for (let i = 0; i < 50000; i++) {
                const userId = i < 10 ? i + 100 : 2;
                insert.run(f.at() + i, userId, `account-${userId}`);
            }
        })();
        const plan = f.database.prepare("EXPLAIN QUERY PLAN SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC,id DESC) FROM auth_events WHERE category='activity'").all();
        assert.ok(plan.some(row => row.detail.includes('idx_auth_events_account_created')));
        const started = performance.now();
        await f.audit.prune();
        const elapsed = performance.now() - started;
        assert.equal(f.audit.query().total, 35000);
        assert.equal(f.database.prepare('SELECT COUNT(*) n FROM auth_events WHERE user_id>=100').get().n, 10);
        assert.ok(elapsed < 10000, 'Populated activity cleanup remains bounded on a native test runner.');
        console.log(`Fair activity cleanup of 50000 rows passed in ${elapsed.toFixed(1)}ms.`);
    } finally { await f.audit.prune(); f.database.close(); }
}

async function testDurableHourlySummariesAndOverlap() {
    const f = fixture();
    try {
        await f.audit.prune();
        for (let i = 0; i < 8; i++) f.audit.record(failure());
        f.audit.flushPending();
        const first = f.audit.query({ event: 'failure_summary' }).entries[0];
        f.advance(30000);
        for (let i = 0; i < 3; i++) f.audit.record(failure());
        f.audit.flushPending();
        const updated = f.audit.query({ event: 'failure_summary' }).entries[0];
        assert.equal(updated.id, first.id);
        assert.equal(updated.occurrences, 6);
        assert.equal(f.audit.query({ event: 'failure_summary' }).total, 1);
        const query = range => f.audit.query({ event: 'failure_summary', ...range });
        assert.equal(query({ from: '2026-11-25T12:00:10Z', to: '2026-11-25T12:00:20Z' }).total, 1);
        assert.equal(query({ from: updated.lastAt, to: updated.lastAt }).total, 1);
        assert.equal(query({ from: first.firstAt, to: first.firstAt }).total, 1);
        assert.equal(query({ from: '2026-11-25T12:01:00Z' }).total, 0);
        assert.equal(query({ to: '2026-11-25T11:59:59Z' }).total, 0);
        assert.equal(query({ from: '2026-11-25T12:00:20Z', to: '2026-11-25T12:00:10Z' }).total, 0,
            'An inverted date range does not match a spanning summary.');

        for (let i = 0; i < 13; i++) f.audit.record(activity(7));
        f.audit.flushPending();
        const beforeRestart = f.audit.query({ event: 'activity_summary' }).entries[0];
        const restarted = f.make();
        for (let i = 0; i < 13; i++) restarted.record(activity(7));
        restarted.shutdown();
        const afterRestart = restarted.query({ event: 'activity_summary' }).entries[0];
        assert.equal(afterRestart.id, beforeRestart.id);
        assert.equal(afterRestart.occurrences, 2);
        assert.equal(restarted.query({ event: 'sign_out' }).total, 25, 'Event filters include the per-account summary.');
        f.advance(service.SUMMARY_PERIOD_MS);
        for (let i = 0; i < 13; i++) f.audit.record(activity(7));
        f.audit.flushPending();
        assert.equal(f.audit.query({ event: 'activity_summary' }).total, 2, 'A new hour receives a new bounded summary row.');
    } finally { await f.audit.prune(); f.database.close(); }
}

async function testIndependentWarningLimits() {
    const f = fixture();
    try {
        await f.audit.prune();
        for (let i = 0; i < 8; i++) f.audit.record(failure());
        f.failStorage(true);
        f.audit.record(activity(9));
        f.audit.flushPending();
        f.failPolicy(true);
        await f.audit.prune();
        assert.equal(f.warnings.length, 3, 'Recording, summary and cleanup failures each report once.');
        f.audit.record(activity(9)); f.audit.flushPending(); await f.audit.prune();
        assert.equal(f.warnings.length, 3, 'Each warning kind remains rate limited.');
        f.failStorage(false); f.failPolicy(false);
        f.audit.flushPending();
        assert.equal(f.audit.query({ event: 'failure_summary' }).entries[0].occurrences, 3);
    } finally { f.failStorage(false); f.failPolicy(false); await f.audit.prune(); f.database.close(); }
}

async function testBoundaryRetryBackoff() {
    const f = fixture();
    try {
        await f.audit.prune();
        for (let i = 0; i < 8; i++) f.audit.record(failure());
        f.failStorage(true);
        assert.equal(f.audit.flushPending(), false);
        f.advance(service.SUMMARY_PERIOD_MS);
        const before = f.reads();
        for (let i = 0; i < 1000; i++) f.audit.record(failure());
        assert.ok(f.reads() - before <= service.FAILURE_SOURCE_LIMIT + 1,
            'An unavailable store at an hour boundary does not cause one summary write per request.');
        f.failStorage(false);
        assert.equal(f.audit.flushPending(), true);
        assert.equal(f.audit.query({ event: 'failure_summary' }).entries[0].occurrences, 998);
    } finally { f.failStorage(false); await f.audit.prune(); f.database.close(); }
}

async function testBalancedAccountsAndLegacySummary() {
    const f = fixture();
    try {
        await f.audit.prune();
        const insert = f.database.prepare("INSERT INTO auth_events(created_at,event,outcome,user_id,username,category) VALUES(?,'sign_in','success',?,?,'activity')");
        insert.run(f.at(), 1, 'quiet');
        f.database.transaction(() => {
            for (let i = 0; i < 1000; i++) insert.run(f.at() + i + 1, i < 500 ? 2 : 3, 'busy');
        })();
        await f.audit.prune();
        assert.deepEqual(f.database.prepare("SELECT COUNT(*) n FROM auth_events WHERE category='activity' GROUP BY user_id").all()
            .map(row => row.n).sort((a, b) => a - b), [1, 349, 350]);
        f.database.prepare('DELETE FROM auth_events').run();
        f.database.exec(`DROP INDEX idx_auth_events_summary_key;
            ALTER TABLE auth_events DROP COLUMN summary_key;
            ALTER TABLE auth_events DROP COLUMN summary_event;
            ALTER TABLE auth_events DROP COLUMN activity_counts;`);
        f.database.prepare(`INSERT INTO auth_events(id,created_at,event,outcome,category,occurrences,first_at,last_at,reason_counts)
            VALUES(400,?,'failure_summary','failure','ordinary_summary',7,?,?,?)`)
            .run(f.at() + 30000, f.at(), f.at() + 30000, JSON.stringify({ rate_limited: 7 }));
        const upgraded = f.make();
        assert.equal(upgraded.query().entries[0].id, 400);
        assert.equal(upgraded.query().entries[0].occurrences, 7);
        assert.equal(upgraded.query({ from: f.at() + 10000, to: f.at() + 20000 }).total, 1);
        for (let i = 0; i < 8; i++) upgraded.record(failure());
        upgraded.shutdown();
        assert.equal(f.database.prepare('SELECT occurrences FROM auth_events WHERE id=400').get().occurrences, 7);
        assert.equal(f.database.prepare("SELECT SUM(occurrences) n FROM auth_events WHERE event='failure_summary'").get().n, 10);
    } finally { await f.audit.prune(); f.database.close(); }
}

(async () => {
    await testActivityAdmission();
    await testManyAccountsRemainBounded();
    await testFairSharingAndCapacityWarning();
    await testPopulatedLogCleanup();
    await testDurableHourlySummariesAndOverlap();
    await testIndependentWarningLimits();
    await testBoundaryRetryBackoff();
    await testBalancedAccountsAndLegacySummary();
    console.log('Fair activity retention, bounded activity summaries and overlapping date filter tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
