'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const service = require('../server/services/authAudit');

function fixture() {
    const database = new Database(':memory:');
    let at = Date.parse('2026-11-24T12:00:00Z');
    let unavailable = false;
    const timers = new Map();
    const audit = service.createAuthAudit({
        getDb: () => { if (unavailable) throw new Error('Synthetic unavailable storage'); return database; },
        getSettings: async () => ({ authLogRetentionDays: 90, authLogMaxEntries: 1000 }),
        now: () => at, logger: null,
        timers: {
            setInterval(fn, ms) { const handle = { unref() {} }; timers.set(handle, { fn, ms }); return handle; },
            clearInterval(handle) { timers.delete(handle); }
        }
    });
    return { database, audit, timers, advance(ms) { at += ms; }, fail(value) { unavailable = value; } };
}

const user = { id: 7, username: 'review-account' };
const ordinary = (index = 0) => ({ event: 'sign_in', outcome: 'failure', reason: 'rate_limited',
    username: `attempt-${index}`, context: { ip: `2001:db8::${index.toString(16)}` } });
const mfa = (index = 0) => ({ ...ordinary(index), user, method: 'password+totp', reason: 'invalid_mfa_code',
    verifiedChallenge: true, challengeKey: `server-challenge-${index}` });

function totals(database) {
    return Object.fromEntries(database.prepare('SELECT category, COUNT(*) n FROM auth_events GROUP BY category').all()
        .map(row => [row.category, row.n]));
}

async function testGlobalBoundsAndClassification() {
    const f = fixture();
    try {
        await f.audit.prune();
        for (const [event, outcome] of [['sign_in', 'success'], ['sign_in', 'mfa_required'],
            ['sign_out', 'success'], ['setup', 'success']]) {
            f.audit.record({ event, outcome, user, method: 'password' });
        }
        const protectedIds = f.audit.query().entries.map(entry => entry.id);
        for (let index = 0; index < 5000; index++) {
            f.audit.record(ordinary(index));
            f.audit.record(mfa(index));
        }
        assert.equal(f.audit.flushPending(), true);
        await f.audit.prune();
        const counts = totals(f.database);
        assert.equal(counts.activity, 4);
        assert.equal(counts.ordinary, service.FAILURE_LIMITS.ordinary);
        assert.equal(counts.mfa, service.FAILURE_LIMITS.mfa);
        assert.equal(counts.ordinary_summary, 1);
        assert.equal(counts.mfa_summary, 1);
        for (const id of protectedIds) assert.ok(f.database.prepare('SELECT id FROM auth_events WHERE id=?').get(id));
        const summaries = f.audit.query({ event: 'failure_summary' }).entries;
        for (const group of ['ordinary', 'mfa']) {
            const summary = summaries.find(entry => entry.retentionGroup === group);
            assert.equal(summary.occurrences, 5000 - service.FAILURE_LIMITS[group]);
            assert.equal(Object.values(summary.reasonCounts).reduce((a, b) => a + b, 0), summary.occurrences);
            assert.equal(summary.username, null);
            assert.equal(summary.ip, null);
            assert.equal(summary.firstAt, summary.lastAt);
        }
        assert.equal(f.audit.record({ event: 'failure_summary', outcome: 'failure' }), false);
        // An account ID or an MFA-looking method alone does not prove a challenge.
        f.advance(service.FAILURE_WINDOW_MS);
        f.audit.record({ ...mfa(6001), verifiedChallenge: false });
        f.audit.record({ ...mfa(6002), challengeKey: null });
        assert.equal(f.audit.query({ account: user.username }).entries.filter(entry => entry.retentionGroup === 'ordinary').length, 2);
    } finally { f.audit.stopMaintenance(); f.database.close(); }
}

async function testIndependentRetentionAndExpiry() {
    const f = fixture();
    try {
        await f.audit.prune();
        f.audit.record({ event: 'sign_in', outcome: 'success', user });
        for (let window = 0; window < 25; window++) {
            for (let i = 0; i < 80; i++) { f.audit.record(ordinary(i)); f.audit.record(mfa(i)); }
            f.audit.flushPending();
            f.advance(service.SUMMARY_PERIOD_MS);
        }
        await f.audit.prune();
        const counts = totals(f.database);
        const allowances = service.retentionAllowances(1000);
        assert.equal(Object.values(allowances).reduce((a, b) => a + b, 0), 1000);
        assert.equal(counts.activity, 1, 'Other evidence groups cannot evict successful activity.');
        for (const category of ['ordinary', 'mfa', 'ordinary_summary', 'mfa_summary']) {
            assert.equal(counts[category], allowances[category], `${category} has its own allowance.`);
        }
        for (let i = 0; i < 710; i++) {
            f.audit.record({ event: 'sign_out', outcome: 'success', user: { id: 8, username: 'busy-account' } });
            f.advance(service.FAILURE_WINDOW_MS);
        }
        await f.audit.prune();
        assert.equal(totals(f.database).activity, allowances.activity, 'Protected activity is bounded too.');
        assert.equal(f.audit.query({ account: user.username, outcome: 'success' }).total, 1, 'The quiet account keeps its earlier record.');
        f.advance(91 * 24 * 60 * 60 * 1000);
        await f.audit.prune();
        assert.equal(f.audit.query().total, 0, 'Age expiry applies to every group and summary.');
    } finally { f.audit.stopMaintenance(); f.database.close(); }
}

async function testPerSourceWindowsAndTimers() {
    const f = fixture();
    try {
        await f.audit.prune();
        f.audit.startMaintenance();
        for (let i = 0; i < 12; i++) { f.audit.record(ordinary()); f.audit.record(mfa()); }
        assert.equal(totals(f.database).ordinary, service.FAILURE_SOURCE_LIMIT);
        assert.equal(totals(f.database).mfa, service.FAILURE_SOURCE_LIMIT);
        assert.equal(f.audit.query({ event: 'failure_summary' }).total, 0);
        const flush = [...f.timers.values()].find(timer => timer.ms === service.SUMMARY_FLUSH_MS);
        assert.ok(flush, 'A periodic flush exists even when no further requests arrive.');
        f.advance(service.SUMMARY_FLUSH_MS);
        flush.fn();
        assert.deepEqual(f.audit.query({ event: 'failure_summary' }).entries.map(entry => entry.occurrences), [7, 7]);
        flush.fn();
        assert.equal(f.audit.query({ event: 'failure_summary' }).total, 2, 'Empty flushes do not add rows.');
        f.advance(service.FAILURE_WINDOW_MS);
        for (let i = 0; i < 8; i++) { f.audit.record(ordinary()); f.audit.record(mfa()); }
        assert.equal(totals(f.database).ordinary, 10, 'Admission resets for the next window.');
        assert.equal(f.audit.shutdown(), true);
        assert.equal(f.timers.size, 0, 'Normal shutdown cancels both timers.');
        assert.deepEqual(f.audit.query({ event: 'failure_summary' }).entries.map(entry => entry.occurrences), [10, 10]);
        f.audit.shutdown();
        assert.equal(f.audit.query({ event: 'failure_summary' }).total, 2, 'Shutdown does not duplicate a summary.');
    } finally { f.audit.stopMaintenance(); f.database.close(); }
}

async function testRetryAndAbruptRestart() {
    const f = fixture();
    try {
        await f.audit.prune();
        for (let i = 0; i < 15; i++) f.audit.record(ordinary());
        f.fail(true);
        assert.equal(f.audit.flushPending(), false);
        f.fail(false);
        assert.equal(f.audit.flushPending(), true);
        assert.equal(f.audit.query({ event: 'failure_summary' }).entries[0].occurrences, 10);
        for (let i = 0; i < 9; i++) f.audit.record(ordinary());
        // A new instance represents process restart without a shutdown flush.
        const restarted = service.createAuthAudit({ getDb: () => f.database, logger: null });
        assert.equal(restarted.query({ event: 'failure_summary' }).entries[0].occurrences, 10,
            'Saved counts survive; only the current unflushed interval is lost on abrupt restart.');
        restarted.record(ordinary());
        assert.equal(totals(f.database).ordinary, 6, 'Admission counters restart with the process.');
        restarted.shutdown();
    } finally { f.audit.stopMaintenance(); f.database.close(); }
}

function testExistingSchemaUpgrade() {
    const database = new Database(':memory:');
    try {
        database.exec(`CREATE TABLE auth_events(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at INTEGER NOT NULL,
            event TEXT NOT NULL,outcome TEXT NOT NULL,method TEXT,reason TEXT,user_id INTEGER,username TEXT,
            ip TEXT,peer_ip TEXT,forwarded_for TEXT,host TEXT,user_agent TEXT,flow_id TEXT);
            INSERT INTO auth_events(created_at,event,outcome,method,user_id,username,flow_id) VALUES
            (1,'sign_in','success','password',7,'existing',NULL),
            (2,'sign_in','failure','password+totp',7,'existing','6f1c2c1e-6c1d-4c6e-9d6a-2b1f3c4d5e6f'),
            (3,'sign_in','failure','password',NULL,'unknown',NULL);`);
        const audit = service.createAuthAudit({ getDb: () => database, logger: null });
        const entries = audit.query().entries.reverse();
        assert.deepEqual(entries.map(entry => entry.id), [1, 2, 3]);
        assert.deepEqual(entries.map(entry => entry.retentionGroup), ['activity', 'mfa', 'ordinary']);
        assert.ok(entries.every(entry => entry.occurrences === 1));
        const restarted = service.createAuthAudit({ getDb: () => database, logger: null });
        assert.equal(restarted.query().total, 3, 'Schema migration is repeatable and retains prior entries.');
    } finally { database.close(); }
}

(async () => {
    await testGlobalBoundsAndClassification();
    await testIndependentRetentionAndExpiry();
    await testPerSourceWindowsAndTimers();
    await testRetryAndAbruptRestart();
    testExistingSchemaUpgrade();
    console.log('Authentication audit recording bounds, summaries and retention tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
