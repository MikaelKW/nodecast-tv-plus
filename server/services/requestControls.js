'use strict';

function parseBoundedInteger(value, {
    name = 'value',
    defaultValue,
    min,
    max
}) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    const normalized = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
        const error = new Error(`${name} must be an integer between ${min} and ${max}`);
        error.statusCode = 400;
        throw error;
    }

    return normalized;
}

class SlidingWindowLimiter {
    constructor({ limit, windowMs, maxEntries = 10000 }) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.maxEntries = maxEntries;
        this.entries = new Map();
    }

    prune(now = Date.now()) {
        for (const [key, timestamps] of this.entries) {
            const recent = timestamps.filter(timestamp => now - timestamp < this.windowMs);
            if (recent.length) this.entries.set(key, recent);
            else this.entries.delete(key);
        }

        while (this.entries.size > this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
        }
    }

    consume(key, now = Date.now()) {
        this.prune(now);
        const normalizedKey = String(key || 'anonymous');
        const timestamps = this.entries.get(normalizedKey) || [];
        if (timestamps.length >= this.limit) {
            const retryAfterMs = Math.max(1, this.windowMs - (now - timestamps[0]));
            return { allowed: false, retryAfterMs };
        }

        timestamps.push(now);
        this.entries.set(normalizedKey, timestamps);
        return { allowed: true, retryAfterMs: 0 };
    }
}

function rateLimitMiddleware(limiter, {
    identity = req => req.user?.id,
    message = 'Too many requests. Try again shortly.'
} = {}) {
    return (req, res, next) => {
        const result = limiter.consume(identity(req));
        if (!result.allowed) {
            res.set('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
            return res.status(429).json({ error: message });
        }
        next();
    };
}

class SingleFlight {
    constructor({ maxEntries = 1000 } = {}) {
        this.maxEntries = maxEntries;
        this.inFlight = new Map();
    }

    run(key, operation) {
        const normalizedKey = String(key);
        const existing = this.inFlight.get(normalizedKey);
        if (existing) return existing;

        if (this.inFlight.size >= this.maxEntries) {
            const error = new Error('Too many upstream operations are already in progress');
            error.statusCode = 429;
            throw error;
        }

        const promise = Promise.resolve()
            .then(operation)
            .finally(() => {
                if (this.inFlight.get(normalizedKey) === promise) {
                    this.inFlight.delete(normalizedKey);
                }
            });
        this.inFlight.set(normalizedKey, promise);
        return promise;
    }
}

module.exports = {
    parseBoundedInteger,
    SlidingWindowLimiter,
    rateLimitMiddleware,
    SingleFlight
};
