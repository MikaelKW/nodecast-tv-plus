const database = require('../db');
const { getDb } = require('../db/sqlite');

function isCatalogueSource(source) {
    return source.type === 'm3u' || source.type === 'xtream';
}

function hasUsableCatalogue(source) {
    const baseline = source.catalogueBaseline;
    return baseline?.connectionRevision === database.sourceConnectionRevision(source)
        && (Number.isFinite(baseline.completedAt) || baseline.assumedUsable === true);
}

async function prepareLocalCatalogue() {
    // Required storage failures are not treated as ordinary provider failures.
    await database.checkHealth();
    const db = getDb();
    await database.mutateDb(data => {
        if (data.catalogueReadinessVersion === 1) return { changed: false };
        const statuses = new Map(db.prepare("SELECT source_id, status, last_sync FROM sync_status WHERE type = 'all'").all().map(row => [row.source_id, row]));
        const stored = new Set(db.prepare("SELECT DISTINCT source_id FROM playlist_items WHERE type IN ('live', 'movie', 'series')").all().map(row => row.source_id));
        for (const source of data.sources) {
            if (!isCatalogueSource(source)) continue;
            const connectionRevision = database.sourceConnectionRevision(source);
            const status = statuses.get(source.id);
            if (status?.status === 'success' && Number.isFinite(status.last_sync)) {
                source.catalogueBaseline = { connectionRevision, completedAt: status.last_sync };
            } else if (stored.has(source.id)) {
                // Legacy rows cannot establish whether a prior import completed.
                source.catalogueBaseline = { connectionRevision, assumedUsable: true };
            }
        }
        data.catalogueReadinessVersion = 1;
    });
    return database.sources.getAll();
}

module.exports = { isCatalogueSource, hasUsableCatalogue, prepareLocalCatalogue };
