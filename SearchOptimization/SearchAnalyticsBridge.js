/**
 * SearchAnalyticsBridge.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /search-optimization
 *
 * Bridges real-user search behaviour into the caching and optimisation layer.
 *
 * Two components:
 *
 * SERVER-SIDE: SearchAnalyticsCollector
 *   A lightweight SFCC controller helper that captures search events
 *   (query, result count, latency, zero-result rate) and writes them to
 *   the SFCC Custom Object store for async processing.
 *
 * SERVER-SIDE: SearchAnalyticsAggregator (Job step)
 *   Reads the Custom Object store, aggregates query frequency and zero-result
 *   rate, then updates the Site Preference used by SearchIndexWarmup.js to
 *   determine which queries to pre-warm. The feedback loop:
 *
 *     Real user searches → Analytics captured → Aggregated hourly
 *       → Top queries updated → Next index rebuild warms the right queries
 *
 * Usage:
 *   // In Search-Show controller:
 *   var Bridge = require('*/cartridge/scripts/search/SearchAnalyticsBridge');
 *   Bridge.Collector.record(searchResult);
 *
 *   // In aggregation Job step:
 *   module.exports = { execute: Bridge.Aggregator.execute };
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var CustomObjectMgr  = require('dw/object/CustomObjectMgr');
var Transaction      = require('dw/system/Transaction');
var Site             = require('dw/system/Site');
var Logger           = require('dw/system/Logger').getLogger('search', 'SearchAnalyticsBridge');
var Status           = require('dw/system/Status');

// ─── Configuration ────────────────────────────────────────────────────────────

var CONFIG = {
    /** Custom Object type name — define this in BM → Custom Object Definitions */
    customObjectType: 'SearchAnalyticsEvent',

    /**
     * Maximum events to collect per Job run before aggregating.
     * Keeps Custom Object store from growing unbounded.
     */
    maxEventsPerRun: 5000,

    /**
     * Top N queries by frequency to write back to the warmup preference.
     * Should match LIMITS.maxTopQueries in SearchIndexWarmup.js.
     */
    topQueryCount: 50,

    /**
     * Minimum search count before a query enters the warmup list.
     * Filters out one-off long-tail queries.
     */
    minSearchCount: 10,

    /** Zero-result rate threshold above which a query is flagged (0–1) */
    zeroResultThreshold: 0.5,

    /** Site Preference ID to write updated top queries into */
    warmupPrefID: 'searchWarmupTopQueries'
};

// ─── SERVER-SIDE: SearchAnalyticsCollector ────────────────────────────────────

var Collector = {

    /**
     * Records a single search event as a Custom Object.
     * Called synchronously in the Search-Show controller — kept minimal
     * to avoid adding latency to the search response.
     *
     * @param {Object} searchResult  - Result from SearchQueryOptimizer.execute()
     */
    record: function (searchResult) {
        if (!searchResult || !searchResult.query) { return; }

        // Sample at 20% in production to reduce write volume on high-traffic sites.
        // Remove / adjust the sampling rate for smaller catalogs.
        if (Math.random() > 0.2) { return; }

        try {
            Transaction.wrap(function () {
                var eventID = 'srch_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
                var obj     = CustomObjectMgr.createCustomObject(CONFIG.customObjectType, eventID);

                // Store only what we need for aggregation — keep payloads small
                obj.custom.query       = (searchResult.query || '').slice(0, 200);
                obj.custom.categoryID  = searchResult.categoryID || '';
                obj.custom.resultCount = searchResult.total || 0;
                obj.custom.latencyMs   = searchResult.durationMs || 0;
                obj.custom.sortRule    = searchResult.sortRule || '';
                obj.custom.cacheHit    = searchResult.cacheHit ? '1' : '0';
                obj.custom.siteID      = Site.getCurrent().getID();
                obj.custom.ts          = String(Date.now());
            });
        } catch (e) {
            // Non-fatal — analytics must never break the search response
            Logger.warn('SearchAnalyticsBridge.Collector.record failed: {0}', e.message);
        }
    },

    /**
     * Records a zero-result search event with higher priority.
     * Zero-result queries are tracked to identify catalog gaps and synonym needs.
     *
     * @param {string} query
     * @param {string} [categoryID]
     */
    recordZeroResult: function (query, categoryID) {
        this.record({
            query      : query,
            categoryID : categoryID || '',
            total      : 0,
            durationMs : 0,
            sortRule   : '',
            cacheHit   : false
        });

        Logger.info('SearchAnalytics ZERO_RESULT q="{0}" cat={1}', query, categoryID);
    }
};

// ─── SERVER-SIDE: SearchAnalyticsAggregator (Job step) ───────────────────────

var Aggregator = {

    /**
     * SFCC Job entry point.
     * Reads Custom Objects, aggregates query stats, and updates warmup preferences.
     *
     * @returns {dw.system.Status}
     */
    execute: function () {
        Logger.info('SearchAnalyticsAggregator: starting aggregation');

        // ── 1. Read events ────────────────────────────────────────────────────

        var allObjects = CustomObjectMgr.getAllCustomObjects(CONFIG.customObjectType);
        if (!allObjects || !allObjects.hasNext()) {
            Logger.info('SearchAnalyticsAggregator: no events to process');
            return new Status(Status.OK, 'NO_EVENTS', 'No analytics events found.');
        }

        // ── 2. Aggregate ──────────────────────────────────────────────────────

        var queryCounts     = {};  // query → { count, zeroResultCount, totalLatency }
        var processedIDs    = [];
        var processedCount  = 0;

        while (allObjects.hasNext() && processedCount < CONFIG.maxEventsPerRun) {
            var obj   = allObjects.next();
            var query = obj.custom.query ? String(obj.custom.query).trim().toLowerCase() : '';
            var count = parseInt(obj.custom.resultCount, 10) || 0;
            var lat   = parseInt(obj.custom.latencyMs, 10)   || 0;

            if (query) {
                if (!queryCounts[query]) {
                    queryCounts[query] = { count: 0, zeroResultCount: 0, totalLatency: 0 };
                }
                queryCounts[query].count++;
                queryCounts[query].totalLatency += lat;
                if (count === 0) { queryCounts[query].zeroResultCount++; }
            }

            processedIDs.push(obj.getCustomAttribute('objectID') || obj.UUID);
            processedCount++;
        }

        // ── 3. Sort by frequency ──────────────────────────────────────────────

        var sortedQueries = Object.keys(queryCounts)
            .filter(function (q) { return queryCounts[q].count >= CONFIG.minSearchCount; })
            .sort(function (a, b) { return queryCounts[b].count - queryCounts[a].count; })
            .slice(0, CONFIG.topQueryCount);

        // ── 4. Log zero-result queries for merchandising team ─────────────────

        var zeroResultQueries = Object.keys(queryCounts).filter(function (q) {
            var stats = queryCounts[q];
            return stats.zeroResultCount / stats.count >= CONFIG.zeroResultThreshold;
        });

        if (zeroResultQueries.length > 0) {
            Logger.warn('SearchAnalytics HIGH_ZERO_RESULT_RATE queries=[{0}]',
                zeroResultQueries.slice(0, 20).join(', '));
        }

        // ── 5. Update Site Preference for SearchIndexWarmup ───────────────────

        try {
            Transaction.wrap(function () {
                Site.getCurrent().setCustomPreferenceValue(
                    CONFIG.warmupPrefID,
                    JSON.stringify(sortedQueries)
                );
            });
            Logger.info('SearchAnalyticsAggregator: updated warmup preference with {0} queries',
                sortedQueries.length);
        } catch (e) {
            Logger.error('SearchAnalyticsAggregator: failed to update preference: {0}', e.message);
        }

        // ── 6. Delete processed Custom Objects ────────────────────────────────

        var deletedCount = 0;
        try {
            Transaction.wrap(function () {
                processedIDs.forEach(function (id) {
                    try {
                        var toDelete = CustomObjectMgr.getCustomObject(CONFIG.customObjectType, id);
                        if (toDelete) {
                            CustomObjectMgr.remove(toDelete);
                            deletedCount++;
                        }
                    } catch (e) { /* best-effort deletion */ }
                });
            });
        } catch (e) {
            Logger.warn('SearchAnalyticsAggregator: error deleting processed events: {0}', e.message);
        }

        Logger.info([
            'SearchAnalyticsAggregator complete.',
            'processed=' + processedCount,
            'deleted=' + deletedCount,
            'topQueries=' + sortedQueries.length,
            'zeroResultQueries=' + zeroResultQueries.length
        ].join(' '));

        return new Status(
            Status.OK,
            'AGGREGATION_COMPLETE',
            'Aggregated ' + processedCount + ' events. Top queries updated.'
        );
    }
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    Collector  : Collector,
    Aggregator : Aggregator,
    CONFIG     : CONFIG
};
