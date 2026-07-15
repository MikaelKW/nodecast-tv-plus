class AttemptLimiter {
    constructor({ maxAttempts, windowMs, blockMs = windowMs, maxEntries = 10000 }) {
        this.maxAttempts = maxAttempts;
        this.windowMs = windowMs;
        this.blockMs = blockMs;
        this.maxEntries = maxEntries;
        this.entries = new Map();
    }

    prune(now = Date.now()) {
        for (const [key, entry] of this.entries) {
            const recent = entry.failures.filter(timestamp => now - timestamp < this.windowMs);
            if (recent.length === 0 && (!entry.blockedUntil || entry.blockedUntil <= now)) {
                this.entries.delete(key);
            } else {
                entry.failures = recent;
            }
        }

        while (this.entries.size > this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
        }
    }

    check(key, now = Date.now()) {
        this.prune(now);
        const entry = this.entries.get(key);
        if (!entry?.blockedUntil || entry.blockedUntil <= now) {
            return { allowed: true, retryAfterMs: 0 };
        }

        return { allowed: false, retryAfterMs: entry.blockedUntil - now };
    }

    recordFailure(key, now = Date.now()) {
        this.prune(now);
        const entry = this.entries.get(key) || { failures: [], blockedUntil: 0 };
        entry.failures = entry.failures.filter(timestamp => now - timestamp < this.windowMs);
        entry.failures.push(now);
        if (entry.failures.length >= this.maxAttempts) {
            entry.blockedUntil = now + this.blockMs;
        }
        this.entries.set(key, entry);
        return this.check(key, now);
    }

    reset(key) {
        this.entries.delete(key);
    }
}

module.exports = {
    AttemptLimiter,
    passwordIdentityLimiter: new AttemptLimiter({
        maxAttempts: 5,
        windowMs: 15 * 60 * 1000,
        blockMs: 15 * 60 * 1000
    }),
    passwordIpLimiter: new AttemptLimiter({
        maxAttempts: 25,
        windowMs: 15 * 60 * 1000,
        blockMs: 15 * 60 * 1000
    }),
    twoFactorLimiter: new AttemptLimiter({
        maxAttempts: 5,
        windowMs: 10 * 60 * 1000,
        blockMs: 10 * 60 * 1000
    })
};
