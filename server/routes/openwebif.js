'use strict';
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const auth = require('../auth');
const { sources } = require('../db');
const { getLiveChannel } = require('../services/catalogueService');
const { serviceReference } = require('../services/enigma2');
const { validateHttpUrl } = require('../services/urlSecurity');
const { fetchWithPolicy } = require('../services/outboundSecurity');
const router = express.Router();
router.use(auth.requireAuth);
const limitZap = rateLimit({
    limit: 60, windowMs: 60000, keyGenerator: req => String(req.user.id),
    standardHeaders: 'draft-7', legacyHeaders: false
});
router.post('/zap', limitZap, async (req, res) => {
    const { sourceId, streamId } = req.body || {};
    const id = Number(sourceId);
    if (!['string', 'number'].includes(typeof sourceId) || !Number.isSafeInteger(id) || id <= 0 ||
        typeof streamId !== 'string' || !streamId || streamId.length > 512) {
        return res.status(400).json({ error: 'Valid sourceId and streamId are required' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    let response;
    try {
        const source = await sources.getById(id);
        if (!source?.enabled || source.type !== 'm3u' || !source.zapBeforeStreaming || source.contentVisibility?.live === false) {
            return res.status(404).json({ error: 'Zap is not enabled for this source' });
        }
        const item = getLiveChannel(id, streamId);
        if (!item) return res.status(404).json({ error: 'Channel not found' });
        const receiver = new URL(validateHttpUrl(source.url, 'Source URL'));
        receiver.pathname = '/web/zap';
        receiver.search = new URLSearchParams({ sRef: serviceReference(item) }).toString();
        receiver.hash = '';
        response = await fetchWithPolicy(receiver.href, { signal: controller.signal }, {
            allowPrivateHosts: [source.url], followRedirects: false
        });
        if (!response.ok) return res.status(502).json({ error: 'Receiver could not be tuned' });
        let text = '';
        let bytes = 0;
        for await (const chunk of response.body) {
            bytes += chunk.length;
            if (bytes > 16384) throw new Error('Receiver response exceeded its limit');
            text += chunk.toString('utf8');
        }
        if (!/<e2state>\s*true\s*<\/e2state>/i.test(text)) {
            return res.status(502).json({ error: 'Receiver could not be tuned' });
        }
        if (!res.destroyed) res.json({ success: true });
    } catch (error) {
        if (!res.destroyed) res.status(error.statusCode === 400 ? 400 : 502).json({ error: 'Receiver could not be tuned' });
    } finally {
        clearTimeout(timer);
        res.off('close', disconnected);
        await response?.body?.cancel?.();
    }
});
module.exports = router;
