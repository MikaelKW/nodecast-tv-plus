const { sourceConnectionRevision } = require('../db');
const { isCatalogueSource, hasUsableCatalogue, prepareLocalCatalogue } = require('./catalogueReadiness');

class StartupReadiness {
    constructor({ waitMs = 5 * 60 * 1000, prepare = prepareLocalCatalogue } = {}) {
        this.state = 'starting';
        this.waitMs = waitMs;
        this.prepare = prepare;
        this.pending = new Map();
        this.waitExpired = false;
        this.timer = null;
        this.unsubscribe = null;
    }

    snapshot() { return { state: this.state }; }
    canUseApplication() { return this.state === 'ready' || this.state === 'degraded'; }

    evaluate() {
        if (this.state === 'failed' || this.stopped) return;
        if (!this.pending.size) {
            this.state = 'ready';
            clearTimeout(this.timer);
            this.unsubscribe?.();
            this.unsubscribe = null;
        } else if (this.waitExpired || [...this.pending.values()].every(item => item.failed)) {
            this.state = 'degraded';
        }
    }

    observe(event) {
        const pending = this.pending.get(event.sourceId);
        if (!pending || pending.revision !== event.connectionRevision) return;
        if (event.kind === 'catalogue') this.pending.delete(event.sourceId);
        if (event.kind === 'failure') pending.failed = true;
        if (event.kind === 'storage_failure') {
            this.fail();
            return;
        }
        this.evaluate();
    }

    async initialize(syncService, { disableBackgroundJobs = false } = {}) {
        try {
            const sources = await this.prepare();
            if (this.stopped) return;
            if (!disableBackgroundJobs) {
                for (const source of sources) {
                    if (source.enabled && isCatalogueSource(source) && !hasUsableCatalogue(source)) {
                        this.pending.set(source.id, { revision: sourceConnectionRevision(source), failed: false });
                    }
                }
            }
            this.unsubscribe = syncService.subscribeCatalogueReadiness(event => this.observe(event));
            this.evaluate();
            if (this.pending.size) {
                this.timer = setTimeout(() => {
                    this.waitExpired = true;
                    this.evaluate();
                }, this.waitMs);
                this.timer.unref?.();
            }
            if (!disableBackgroundJobs) {
                this.backgroundSync = syncService.syncAll({ startup: true, initialImportIds: new Set(this.pending.keys()) });
                this.backgroundSync.catch(error => {
                    console.error('[Startup] Initial refresh failed:', error.code || 'refresh_error');
                    this.waitExpired = true;
                    this.evaluate();
                });
            }
        } catch (error) {
            console.error('[Startup] Required local preparation failed:', error.code || 'storage_error');
            this.fail();
        }
    }

    fail() {
        this.state = 'failed';
        clearTimeout(this.timer);
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    stop() {
        this.stopped = true;
        this.state = 'starting';
        clearTimeout(this.timer);
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
}

const startupReadiness = new StartupReadiness();
module.exports = startupReadiness;
module.exports.StartupReadiness = StartupReadiness;
