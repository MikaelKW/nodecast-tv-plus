'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Persistent authentication audit log.
 *
 * Records sign-in attempts with their outcome and request context for
 * administrators. Only fixed codes and the listed context fields are stored:
 * callers cannot pass passwords, MFA codes, cookies, tokens or arbitrary
 * properties into an entry. Recording never throws, so a storage problem can
 * not block or alter authentication.
 */

const EVENTS = Object.freeze(['sign_in', 'sign_out', 'setup', 'failure_summary']);

const OUTCOMES = Object.freeze(['success', 'failure', 'mfa_required']);

const METHODS = Object.freeze([
    'password',
    'sso',
    'password+totp',
    'password+recovery_code',
    'sso+totp',
    'sso+recovery_code'
]);

const REASONS = Object.freeze({
    missing_credentials: 'The username or password was empty.',
    unknown_account: 'No account exists with this username.',
    invalid_password: 'The password was incorrect.',
    rate_limited: 'Blocked by the sign-in rate limit.',
    local_sign_in_disabled: 'Local sign-in is disabled.',
    mfa_unavailable: 'Two-factor authentication was unavailable.',
    invalid_mfa_code: 'The two-factor code was incorrect.',
    invalid_recovery_code: 'The recovery code was incorrect or already used.',
    mfa_rate_limited: 'Blocked by the two-factor rate limit.',
    mfa_challenge_expired: 'The two-factor challenge had expired.',
    mfa_challenge_invalid: 'The two-factor challenge was no longer valid.',
    sso_failed: 'The single sign-on provider did not authenticate the user.',
    sso_unavailable: 'Single sign-on was unavailable.',
    server_error: 'The server could not complete authentication.'
});

const DEFAULT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_MAX_ENTRIES = 50000;
const MIN_MAX_ENTRIES = 1000;
const MAX_MAX_ENTRIES = 1000000;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const PRUNE_EVERY_INSERTS = 200;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 60 * 1000;
const SUMMARY_FLUSH_MS = 30 * 1000;
const FAILURE_LIMITS = Object.freeze({ ordinary: 60, mfa: 30 });
const FAILURE_SOURCE_LIMIT = 5;
const FAILURE_SOURCE_KEYS = 128;

function retentionAllowances(maxEntries) {
    const activity = Math.floor(maxEntries * 0.7);
    const mfa = Math.floor(maxEntries * 0.15);
    const ordinary = maxEntries - activity - mfa;
    const mfaSummary = Math.max(1, Math.floor(mfa * 0.1));
    const ordinarySummary = Math.max(1, Math.floor(ordinary * 0.1));
    return { activity, mfa: mfa - mfaSummary, mfa_summary: mfaSummary,
        ordinary: ordinary - ordinarySummary, ordinary_summary: ordinarySummary };
}

const LIMITS = Object.freeze({
    username: 128,
    ip: 64,
    host: 255,
    userAgent: 512,
    forwardedFor: 10
});

// C0/C1 control characters, line/paragraph separators and bidirectional
// formatting characters, which could disguise text in the log viewer.
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]', 'g');

function cleanText(value, maxLength) {
    if (value === undefined || value === null) return null;
    const text = String(value).replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeIp(value) {
    const text = cleanText(value, LIMITS.ip);
    if (!text) return null;
    // Show IPv4 clients on dual-stack sockets as plain IPv4 addresses.
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
    return mapped ? mapped[1] : text;
}

function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeRetentionSettings(settings = {}) {
    return {
        authLogRetentionDays: clampInteger(
            settings.authLogRetentionDays, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS, DEFAULT_RETENTION_DAYS
        ),
        authLogMaxEntries: clampInteger(
            settings.authLogMaxEntries, MIN_MAX_ENTRIES, MAX_MAX_ENTRIES, DEFAULT_MAX_ENTRIES
        )
    };
}

/** Lower-case host name of a Host header value, without its port. */
function hostWithoutPort(value) {
    const text = String(value || '').trim().toLowerCase();
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
    if (bracketed) return bracketed[1];
    // A bare IPv6 address has several colons and no port.
    if ((text.match(/:/g) || []).length > 1) return text;
    return text.replace(/:\d+$/, '');
}

/**
 * Collect the request context for an entry. `req.ip` and `req.ips` follow the
 * application's explicit `trust proxy` setting, so forwarded headers are only
 * honored when they arrive through a trusted proxy. The direct peer address is
 * stored separately so a proxied entry still shows which proxy delivered it.
 */
function contextFromRequest(req) {
    if (!req || typeof req !== 'object') return {};
    let forwardedFor = [];
    try {
        forwardedFor = Array.isArray(req.ips) ? req.ips : [];
    } catch {
        forwardedFor = [];
    }
    let host = null;
    try {
        // req.hostname honors X-Forwarded-Host only from a trusted proxy but
        // drops the port. Keep the raw Host header (with port) unless a
        // trusted proxy supplied a different host name.
        const rawHost = typeof req.get === 'function' ? req.get('host') : req.headers?.host;
        const hostname = req.hostname;
        host = hostname && rawHost && hostWithoutPort(rawHost) !== hostWithoutPort(hostname)
            ? hostname
            : rawHost || hostname || null;
    } catch {
        host = null;
    }
    let userAgent = null;
    try {
        userAgent = typeof req.get === 'function' ? req.get('user-agent') : req.headers?.['user-agent'];
    } catch {
        userAgent = null;
    }
    return {
        ip: req.ip,
        peerIp: req.socket?.remoteAddress,
        forwardedFor,
        host,
        userAgent
    };
}

function versionAfter(userAgent, pattern) {
    const match = pattern.exec(userAgent);
    return match ? match[1].split(/[._]/)[0] : '';
}

/**
 * Summarize a user agent as "Browser version · Operating system" for display.
 * This is a best-effort label; the full user agent is kept for details.
 */
function describeClient(userAgent) {
    const ua = String(userAgent || '');
    if (!ua) return null;

    let os = '';
    if (/\b(iPhone|iPod)\b/.test(ua)) os = `iOS ${versionAfter(ua, /OS (\d+[_.]\d+)/)}`.trim();
    else if (/\biPad\b/.test(ua)) os = `iPadOS ${versionAfter(ua, /OS (\d+[_.]\d+)/)}`.trim();
    else if (/Android/.test(ua)) os = `Android ${versionAfter(ua, /Android (\d+(?:\.\d+)?)/)}`.trim();
    else if (/Windows NT/.test(ua)) os = 'Windows';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
    else if (/Web0S|webOS/.test(ua)) os = 'webOS';
    else if (/Tizen/.test(ua)) os = 'Tizen';
    else if (/Linux/.test(ua)) os = 'Linux';

    let browser = '';
    const rules = [
        ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/],
        ['Opera', /(?:OPR|Opera)\/(\d+)/],
        ['Samsung Internet', /SamsungBrowser\/(\d+)/],
        ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
        ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
        ['Safari', /Version\/(\d+).*Safari\//],
        ['curl', /^curl\/(\d+)/],
        ['VLC', /VLC\/(\d+)/]
    ];
    for (const [name, pattern] of rules) {
        const match = pattern.exec(ua);
        if (match) {
            browser = `${name} ${match[1]}`;
            break;
        }
    }

    const parts = [browser, os].filter(Boolean);
    return parts.length ? parts.join(' · ') : cleanText(ua, 60);
}

function escapeLike(value) {
    return value.replace(/[\\%_]/g, character => `\\${character}`);
}

// Sign-in matches usernames with JavaScript toLowerCase() (getUsernameKey in
// server/db.js), while SQLite only folds ASCII. The account filter folds both
// sides the same way, so it finds every entry of an account such as "Jörg".
const USERNAME_KEY_FUNCTION = 'auth_username_key';

function usernameKey(value) {
    return typeof value === 'string' ? value.toLowerCase() : null;
}

function parseTime(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

function createAuthAudit({
    getDb,
    getSettings = async () => ({}),
    now = Date.now,
    createId = randomUUID,
    logger = console,
    timers = { setInterval, clearInterval }
} = {}) {
    let schemaReady = false;
    let insertsSincePrune = 0;
    let lastPruneAt = 0;
    let pruning = null;
    let maintenanceTimer = null;
    let summaryTimer = null;
    let lastWarningAt = -Infinity;
    const failureWindow = { start: null, ordinary: 0, mfa: 0 };
    const sources = { ordinary: new Map(), mfa: new Map() };
    const pending = { ordinary: null, mfa: null };
    const preparedDatabases = new WeakSet();

    function warn(message, error) {
        const at = now();
        if (at - lastWarningAt < FAILURE_WINDOW_MS && at >= lastWarningAt) return;
        lastWarningAt = at;
        logger?.warn?.(message, error.message);
    }

    function db() {
        const database = getDb();
        if (!schemaReady) {
            ensureSchema(database);
            schemaReady = true;
        }
        if (!preparedDatabases.has(database)) {
            database.function(USERNAME_KEY_FUNCTION, { deterministic: true }, usernameKey);
            preparedDatabases.add(database);
        }
        return database;
    }

    function ensureSchema(database) {
        database.exec(`
            CREATE TABLE IF NOT EXISTS auth_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at INTEGER NOT NULL,
                event TEXT NOT NULL,
                outcome TEXT NOT NULL,
                method TEXT,
                reason TEXT,
                user_id INTEGER,
                username TEXT,
                ip TEXT,
                peer_ip TEXT,
                forwarded_for TEXT,
                host TEXT,
                user_agent TEXT,
                flow_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_auth_events_created ON auth_events(created_at);
            CREATE INDEX IF NOT EXISTS idx_auth_events_ip ON auth_events(ip, created_at);
            CREATE INDEX IF NOT EXISTS idx_auth_events_username ON auth_events(username COLLATE NOCASE, created_at);
            CREATE INDEX IF NOT EXISTS idx_auth_events_outcome ON auth_events(outcome, created_at);
        `);
        const columns = new Set(database.prepare('PRAGMA table_info(auth_events)').all().map(column => column.name));
        database.transaction(() => {
            for (const [name, definition] of Object.entries({
                category: "TEXT NOT NULL DEFAULT 'ordinary'", occurrences: 'INTEGER NOT NULL DEFAULT 1',
                first_at: 'INTEGER', last_at: 'INTEGER', reason_counts: 'TEXT'
            })) {
                if (!columns.has(name)) database.exec(`ALTER TABLE auth_events ADD COLUMN ${name} ${definition}`);
            }
            if (!columns.has('category')) {
                database.exec(`UPDATE auth_events SET category = 'activity'
                    WHERE outcome IN ('success', 'mfa_required') AND user_id IS NOT NULL;
                    UPDATE auth_events SET category = 'mfa' WHERE outcome = 'failure' AND user_id IS NOT NULL
                    AND flow_id IS NOT NULL AND method IN ('password+totp','password+recovery_code','sso+totp','sso+recovery_code');`);
            }
            database.exec('CREATE INDEX IF NOT EXISTS idx_auth_events_category_id ON auth_events(category, id)');
        })();
    }

    function trimCategory(database, category, settings) {
        const limit = retentionAllowances(settings.authLogMaxEntries)[category];
        return database.prepare(`DELETE FROM auth_events WHERE category = ? AND id <= (
            SELECT id FROM auth_events WHERE category = ? ORDER BY id DESC LIMIT 1 OFFSET ?
        )`).run(category, category, limit).changes;
    }

    // Only two fixed-size pending counters exist, independent of account/IP cardinality.
    function flushPending() {
        let saved = true;
        for (const group of ['ordinary', 'mfa']) {
            const summary = pending[group];
            if (!summary) continue;
            try {
                const database = db();
                database.transaction(() => {
                    database.prepare(`INSERT INTO auth_events
                        (created_at,event,outcome,category,occurrences,first_at,last_at,reason_counts)
                        VALUES (?, 'failure_summary', 'failure', ?, ?, ?, ?, ?)`)
                        .run(summary.last, `${group}_summary`, summary.count, summary.first, summary.last, JSON.stringify(summary.reasons));
                })();
                pending[group] = null;
                noteInsert();
            } catch (error) {
                saved = false;
                warn('[AuthAudit] Could not save grouped authentication events:', error);
            }
        }
        return saved;
    }

    function admitFailure(group, key, reason, at) {
        if (failureWindow.start === null || at - failureWindow.start >= FAILURE_WINDOW_MS || at < failureWindow.start) {
            flushPending();
            failureWindow.start = at;
            failureWindow.ordinary = 0;
            failureWindow.mfa = 0;
            sources.ordinary.clear();
            sources.mfa.clear();
        }
        const sourceCount = sources[group].get(key) || 0;
        if (failureWindow[group] < FAILURE_LIMITS[group] && sourceCount < FAILURE_SOURCE_LIMIT
            && (sources[group].has(key) || sources[group].size < FAILURE_SOURCE_KEYS)) {
            failureWindow[group] += 1;
            sources[group].set(key, sourceCount + 1);
            return true;
        }
        const summary = pending[group] || { count: 0, first: at, last: at, reasons: {} };
        summary.count = Math.min(Number.MAX_SAFE_INTEGER, summary.count + 1);
        summary.last = at;
        const code = reason || 'unspecified';
        summary.reasons[code] = Math.min(Number.MAX_SAFE_INTEGER, (summary.reasons[code] || 0) + 1);
        pending[group] = summary;
        return false;
    }

    function noteInsert() {
        insertsSincePrune += 1;
        if (insertsSincePrune >= PRUNE_EVERY_INSERTS || now() - lastPruneAt >= PRUNE_INTERVAL_MS) void prune();
    }

    function createFlowId() {
        try {
            return createId();
        } catch {
            return null;
        }
    }

    /**
     * Record one entry. Accepts only the documented fields; anything else is
     * ignored. Returns true when stored individually or accepted for a summary.
     */
    function record({
        event,
        outcome,
        method = null,
        reason = null,
        user = null,
        username = null,
        flowId = null,
        verifiedChallenge = false,
        challengeKey = null,
        context = {}
    } = {}) {
        try {
            if (!EVENTS.includes(event) || event === 'failure_summary' || !OUTCOMES.includes(outcome)) return false;
            if (method !== null && !METHODS.includes(method)) return false;
            if (reason !== null && !Object.hasOwn(REASONS, reason)) return false;

            const userId = user?.id !== null && user?.id !== undefined && Number.isSafeInteger(Number(user.id))
                ? Number(user.id)
                : null;
            const at = now();
            const protectedChallenge = verifiedChallenge === true && userId > 0
                && typeof challengeKey === 'string' && challengeKey.length > 0 && challengeKey.length <= 128;
            const category = (outcome === 'success' || outcome === 'mfa_required') && userId > 0
                ? 'activity' : protectedChallenge && outcome === 'failure' ? 'mfa' : 'ordinary';
            if (outcome === 'failure') {
                const key = category === 'mfa' ? `${userId}:${challengeKey}`
                    : normalizeIp(context.ip) || normalizeIp(context.peerIp) || 'unknown';
                if (!admitFailure(category, key, reason, at)) return true;
            }
            const forwardedFor = (Array.isArray(context.forwardedFor) ? context.forwardedFor : [])
                .slice(0, LIMITS.forwardedFor)
                .map(normalizeIp)
                .filter(Boolean);

            db().prepare(`
                INSERT INTO auth_events (
                    created_at, event, outcome, method, reason, user_id, username,
                    ip, peer_ip, forwarded_for, host, user_agent, flow_id, category
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                at,
                event,
                outcome,
                method,
                reason,
                userId,
                cleanText(user?.username ?? username, LIMITS.username),
                normalizeIp(context.ip),
                normalizeIp(context.peerIp),
                forwardedFor.length ? JSON.stringify(forwardedFor) : null,
                cleanText(context.host, LIMITS.host),
                cleanText(context.userAgent, LIMITS.userAgent),
                typeof flowId === 'string' && /^[0-9a-f-]{36}$/i.test(flowId) ? flowId : null,
                category
            );
            noteInsert();
            return true;
        } catch (error) {
            warn('[AuthAudit] Could not record an authentication event:', error);
            return false;
        }
    }

    function recordRequest(req, entry) {
        return record({ ...entry, context: contextFromRequest(req) });
    }

    /**
     * Remove entries older than the retention period, then the oldest entries
     * beyond the configured maximum.
     */
    function prune() {
        if (pruning) return pruning;
        insertsSincePrune = 0;
        lastPruneAt = now();
        pruning = (async () => {
            try {
                const settings = normalizeRetentionSettings(await getSettings());
                const database = db();
                const expired = database.prepare('DELETE FROM auth_events WHERE created_at < ?')
                    .run(now() - settings.authLogRetentionDays * DAY_MS).changes;
                let overflow = 0;
                for (const category of Object.keys(retentionAllowances(settings.authLogMaxEntries))) {
                    overflow += trimCategory(database, category, settings);
                }
                return { expired, overflow };
            } catch (error) {
                warn('[AuthAudit] Could not prune authentication events:', error);
                return { expired: 0, overflow: 0 };
            } finally {
                pruning = null;
            }
        })();
        return pruning;
    }

    function startMaintenance(intervalMs = PRUNE_INTERVAL_MS) {
        stopMaintenance();
        void prune();
        maintenanceTimer = timers.setInterval(() => void prune(), intervalMs);
        maintenanceTimer.unref?.();
        summaryTimer = timers.setInterval(flushPending, SUMMARY_FLUSH_MS);
        summaryTimer.unref?.();
    }

    function stopMaintenance() {
        if (maintenanceTimer) timers.clearInterval(maintenanceTimer);
        if (summaryTimer) timers.clearInterval(summaryTimer);
        maintenanceTimer = null;
        summaryTimer = null;
    }

    function shutdown() {
        stopMaintenance();
        return flushPending();
    }

    function toPublicEntry(row) {
        let forwardedFor = [];
        try {
            forwardedFor = row.forwarded_for ? JSON.parse(row.forwarded_for) : [];
        } catch {
            forwardedFor = [];
        }
        const summary = row.event === 'failure_summary';
        let reasonCounts = {};
        try { reasonCounts = row.reason_counts ? JSON.parse(row.reason_counts) : {}; } catch {}
        const retentionGroup = row.category.replace(/_summary$/, '');
        return {
            id: row.id,
            at: new Date(row.created_at).toISOString(),
            event: row.event,
            outcome: row.outcome,
            method: row.method,
            reason: row.reason,
            reasonText: summary ? `${row.occurrences} additional ${retentionGroup === 'mfa' ? 'challenged two-factor' : 'ordinary'} failures were grouped.`
                : row.reason ? REASONS[row.reason] || null : null,
            retentionGroup,
            occurrences: row.occurrences,
            firstAt: new Date(row.first_at ?? row.created_at).toISOString(),
            lastAt: new Date(row.last_at ?? row.created_at).toISOString(),
            reasonCounts,
            userId: row.user_id,
            username: row.username,
            ip: row.ip,
            peerIp: row.peer_ip,
            forwardedFor: Array.isArray(forwardedFor) ? forwardedFor : [],
            host: row.host,
            userAgent: row.user_agent,
            client: describeClient(row.user_agent),
            flowId: row.flow_id
        };
    }

    /**
     * Query entries, newest first. Filters: from/to (ISO time or epoch ms),
     * account (username substring, case-insensitive), ip (prefix), outcome,
     * event and method.
     */
    function query(filters = {}) {
        const where = [];
        const params = [];

        const from = parseTime(filters.from);
        if (from !== null) {
            where.push('created_at >= ?');
            params.push(from);
        }
        const to = parseTime(filters.to);
        if (to !== null) {
            where.push('created_at <= ?');
            params.push(to);
        }

        const account = cleanText(filters.account, LIMITS.username);
        if (account) {
            where.push(`${USERNAME_KEY_FUNCTION}(username) LIKE ? ESCAPE '\\'`);
            params.push(`%${escapeLike(usernameKey(account))}%`);
        }

        const ip = cleanText(filters.ip, LIMITS.ip);
        if (ip) {
            where.push("(ip LIKE ? ESCAPE '\\' OR peer_ip LIKE ? ESCAPE '\\')");
            params.push(`${escapeLike(ip)}%`, `${escapeLike(ip)}%`);
        }

        if (OUTCOMES.includes(filters.outcome)) {
            where.push('outcome = ?');
            params.push(filters.outcome);
        }
        if (EVENTS.includes(filters.event)) {
            where.push('event = ?');
            params.push(filters.event);
        }
        if (METHODS.includes(filters.method)) {
            where.push('method = ?');
            params.push(filters.method);
        }

        const pageSize = clampInteger(filters.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const database = db();
        const total = database.prepare(`SELECT COUNT(*) AS count FROM auth_events ${clause}`).get(...params).count;
        // Clamp to the last page, which can move when entries are pruned.
        const pages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(pages, clampInteger(filters.page, 1, Number.MAX_SAFE_INTEGER, 1));
        const rows = database.prepare(`
            SELECT * FROM auth_events ${clause}
            ORDER BY created_at DESC, id DESC
            LIMIT ? OFFSET ?
        `).all(...params, pageSize, (page - 1) * pageSize);

        return {
            entries: rows.map(toPublicEntry),
            total,
            page,
            pageSize,
            pages
        };
    }

    return Object.freeze({
        record,
        recordRequest,
        createFlowId,
        prune,
        query,
        startMaintenance,
        stopMaintenance,
        flushPending,
        shutdown
    });
}

let defaultInstance = null;

function getDefault() {
    if (!defaultInstance) {
        const { getDb } = require('../db/sqlite');
        const { settings } = require('../db');
        // Pruning deletes data, so it must not run with fallback defaults when
        // the saved policy cannot be read; getStrict() rejects and prune()
        // then skips this run.
        defaultInstance = createAuthAudit({ getDb, getSettings: () => settings.getStrict() });
    }
    return defaultInstance;
}

module.exports = {
    EVENTS,
    OUTCOMES,
    METHODS,
    REASONS,
    DEFAULT_RETENTION_DAYS,
    MIN_RETENTION_DAYS,
    MAX_RETENTION_DAYS,
    DEFAULT_MAX_ENTRIES,
    MIN_MAX_ENTRIES,
    MAX_MAX_ENTRIES,
    MAX_PAGE_SIZE,
    FAILURE_WINDOW_MS,
    SUMMARY_FLUSH_MS,
    FAILURE_LIMITS,
    FAILURE_SOURCE_LIMIT,
    FAILURE_SOURCE_KEYS,
    retentionAllowances,
    createAuthAudit,
    contextFromRequest,
    describeClient,
    hostWithoutPort,
    normalizeIp,
    normalizeRetentionSettings,
    record: (...args) => getDefault().record(...args),
    recordRequest: (...args) => getDefault().recordRequest(...args),
    createFlowId: () => getDefault().createFlowId(),
    prune: () => getDefault().prune(),
    query: filters => getDefault().query(filters),
    startMaintenance: intervalMs => getDefault().startMaintenance(intervalMs),
    stopMaintenance: () => getDefault().stopMaintenance(),
    flushPending: () => getDefault().flushPending(),
    shutdown: () => getDefault().shutdown()
};
