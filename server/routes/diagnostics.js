'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const auth = require('../auth');
const diagnosticEvents = require('../services/diagnosticEvents');

const router = express.Router();
const limitReads = rateLimit({
    limit: 60,
    windowMs: 60 * 1000,
    keyGenerator: req => String(req.user.id),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many diagnostics requests. Try again shortly.' }
});

router.use(auth.requireAuth, auth.requireAdmin);

router.get('/events', limitReads, (req, res) => {
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 100)
        : 50;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ events: diagnosticEvents.list(limit) });
});

module.exports = router;
