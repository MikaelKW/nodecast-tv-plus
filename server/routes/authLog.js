'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const auth = require('../auth');
const authAudit = require('../services/authAudit');

function createRouter({ authService = auth, audit = authAudit } = {}) {
    const router = express.Router();
    const limitReads = rateLimit({
        limit: 120,
        windowMs: 60 * 1000,
        keyGenerator: req => String(req.user.id),
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Too many log requests. Try again shortly.' }
    });

    router.use(authService.requireAuth, authService.requireAdmin, limitReads);
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    /**
     * Authentication audit entries, newest first.
     * GET /api/auth-log?from=&to=&account=&ip=&outcome=&event=&method=&page=&pageSize=
     */
    router.get('/', (req, res) => {
        try {
            const { from, to, account, ip, outcome, event, method, page, pageSize } = req.query;
            const text = value => (typeof value === 'string' ? value : undefined);
            res.json(audit.query({
                from: text(from),
                to: text(to),
                account: text(account),
                ip: text(ip),
                outcome: text(outcome),
                event: text(event),
                method: text(method),
                page: text(page),
                pageSize: text(pageSize)
            }));
        } catch (error) {
            console.error('[AuthAudit] Could not read authentication events:', error.message);
            res.status(500).json({ error: 'The sign-in log could not be loaded.' });
        }
    });

    return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
