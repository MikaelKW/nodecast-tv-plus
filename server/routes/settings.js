const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { settings, getDefaultSettings } = require('../db');
const syncService = require('../services/syncService');
const releaseUpdates = require('../services/releaseUpdates');
const auth = require('../auth');

function createRouter({ authService = auth, releaseUpdateService = releaseUpdates } = {}) {
    const router = express.Router();
    router.use(authService.requireAuth);

    const limitManualUpdateChecks = rateLimit({
        limit: 6,
        windowMs: 10 * 60 * 1000,
        keyGenerator: req => String(req.user.id),
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Too many update checks. Try again shortly.' }
    });

/**
 * Get all settings
 * GET /api/settings
 */
router.get('/', async (req, res) => {
    try {
        const currentSettings = await settings.get();
        res.json(currentSettings);
    } catch (err) {
        console.error('Error getting settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Update settings (partial update)
 * PUT /api/settings
 */
router.put('/', authService.requireAdmin, async (req, res) => {
    try {
        const updates = req.body;
        if (
            Object.prototype.hasOwnProperty.call(updates, 'automaticUpdateChecks')
            && typeof updates.automaticUpdateChecks !== 'boolean'
        ) {
            return res.status(400).json({ error: 'automaticUpdateChecks must be true or false' });
        }
        const updatedSettings = await settings.update(updates);

        // If sync interval changed, restart the server-side sync timer
        if (updates.epgRefreshInterval !== undefined) {
            syncService.restartSyncTimer().catch(console.error);
        }

        res.json(updatedSettings);
    } catch (err) {
        console.error('Error updating settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Reset settings to defaults
 * DELETE /api/settings
 */
router.delete('/', authService.requireAdmin, async (req, res) => {
    try {
        const defaultSettings = await settings.reset();
        res.json(defaultSettings);
    } catch (err) {
        console.error('Error resetting settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get default settings (for reference)
 * GET /api/settings/defaults
 */
router.get('/defaults', (req, res) => {
    res.json(getDefaultSettings());
});

/**
 * Get sync status (last sync time)
 * GET /api/settings/sync-status
 */
router.get('/sync-status', (req, res) => {
    const lastSyncTime = syncService.getLastSyncTime();
    res.json({
        lastSyncTime: lastSyncTime ? lastSyncTime.toISOString() : null
    });
});

/**
 * Get the current version and cached stable-release status.
 * GET /api/settings/about
 */
router.get('/about', authService.requireAdmin, async (req, res) => {
    try {
        res.json(await releaseUpdateService.getStatus({ refreshIfDue: true }));
    } catch {
        res.status(503).json({ error: 'Release information is temporarily unavailable.' });
    }
});

/**
 * Check the fixed official GitHub Releases endpoint immediately.
 * POST /api/settings/about/check
 */
router.post('/about/check', authService.requireAdmin, limitManualUpdateChecks, async (req, res) => {
    try {
        res.json(await releaseUpdateService.checkNow({ force: true }));
    } catch {
        res.status(503).json({ error: 'Release information is temporarily unavailable.' });
    }
});

/**
 * Get hardware capabilities (GPU acceleration support)
 * GET /api/settings/hw-info
 */
router.get('/hw-info', authService.requireAdmin, async (req, res) => {
    try {
        const hwDetect = require('../services/hwDetect');
        let capabilities = hwDetect.getCapabilities();

        // If not yet detected, run detection now
        if (!capabilities) {
            capabilities = await hwDetect.detect();
        }

        res.json(capabilities);
    } catch (err) {
        console.error('Error getting hardware info:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Refresh hardware detection (re-probe GPUs)
 * POST /api/settings/hw-info/refresh
 */
router.post('/hw-info/refresh', authService.requireAdmin, async (req, res) => {
    try {
        const hwDetect = require('../services/hwDetect');
        const capabilities = await hwDetect.refresh();
        res.json(capabilities);
    } catch (err) {
        console.error('Error refreshing hardware info:', err);
        res.status(500).json({ error: err.message });
    }
});

    return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;

