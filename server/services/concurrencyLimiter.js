'use strict';

class ConcurrencyLimiter {
    constructor({ globalLimit, perIdentityLimit }) {
        this.globalLimit = globalLimit;
        this.perIdentityLimit = perIdentityLimit;
        this.active = 0;
        this.identities = new Map();
    }

    acquire(identity) {
        const key = String(identity || 'anonymous');
        const identityActive = this.identities.get(key) || 0;
        if (this.active >= this.globalLimit || identityActive >= this.perIdentityLimit) {
            return null;
        }

        this.active += 1;
        this.identities.set(key, identityActive + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.active = Math.max(0, this.active - 1);
            const remaining = Math.max(0, (this.identities.get(key) || 1) - 1);
            if (remaining) this.identities.set(key, remaining);
            else this.identities.delete(key);
        };
    }
}

function middleware(limiter) {
    return (req, res, next) => {
        const release = limiter.acquire(req.user?.id);
        if (!release) {
            res.set('Retry-After', '1');
            return res.status(429).json({ error: 'Too many media operations are already running. Try again shortly.' });
        }

        res.once('finish', release);
        res.once('close', release);
        next();
    };
}

const mediaProcessLimiter = new ConcurrencyLimiter({
    globalLimit: 8,
    perIdentityLimit: 3
});

module.exports = {
    ConcurrencyLimiter,
    mediaProcessLimit: middleware(mediaProcessLimiter)
};
