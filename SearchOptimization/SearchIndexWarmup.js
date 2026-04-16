/**
 * SearchIndexWarmup.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /search-optimization
 *
 * SFCC Job step script that pre-warms the search result cache immediately
 * after a catalog index rebuild. Eliminates the cold-start latency spike
 * that affects the first N users after every re-index (which on large
 * catalogs can take 500–2000 ms per search).
 *
 * Warming strategy:
 *   1. TOP QUERIES    — load from a configurable Site Preference (JSON list)
 *                       or from an analytics export (GA4 BigQuery, Splunk, etc.)
 *   2. TOP CATEGORIES — walk the catalog's root category tree
 *   3. TOP REFINEMENT COMBOS — colour × category, size × category for best-sellers
 *
 * Configure as a SFCC Job step:
 *   Administration → Operations → Jobs → New Job
 *   Step type: ExecuteScriptModule
 *   Module: app_custom_storefront/cartridge/scripts/search/SearchIndexWarmup
 *   Method: execute
 *
 * Schedule: trigger after the Search Index Build job finishes (chain jobs).
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var CatalogMgr         = require('dw/catalog/CatalogMgr');
var Site               = require('dw/system/Site');
var Status             = require('dw/system/Status');
var Logger             = require('dw/system/Logger').getLogger('search', 'SearchIndexWarmup');

var SearchQueryOptimizer = require('*/cartridge/scripts/search/SearchQueryOptimizer');
var SearchResultCache    = require('*/cartridge/scripts/search/SearchResultCache');

// ─── Configurable limits ──────────────────────────────────────────────────────

var LIMITS = {
    /** Maximum top queries to warm from Site Preferences */
    maxTopQueries    : 50,

    /** Maximum category browse pages to warm */
    maxCategories    : 30,

    /** Maximum refinement combinations per category */
    maxRefCombos     : 5,

    /** Page sizes to warm (page 1 only — subsequent pages warm on demand) */
    pageSize         : 24,

    /** Sort rules to warm for each query/category */
    sortRules        : ['best-matches', 'top-sellers', 'price-low-to-high']
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Loads the top query list from a Site Preference.
 * The preference value should be a JSON array of strings, e.g.:
 *   ["t shirt", "jeans", "trainers", "dress", "jacket"]
 *
 * Falls back to a hardcoded default list if the preference is empty.
 *
 * @returns {string[]}
 */
function loadTopQueries() {
    var prefValue = Site.getCurrent().getCustomPreferenceValue('searchWarmupTopQueries');
    if (prefValue) {
        try {
            var parsed = JSON.parse(prefValue);
            if (Array.isArray(parsed)) {
                return parsed.slice(0, LIMITS.maxTopQueries);
            }
        } catch (e) {
            Logger.warn('SearchIndexWarmup: could not parse searchWarmupTopQueries preference: {0}', e.message);
        }
    }

    // Default fallback — replace with your catalog's actual top terms
    return [
        't shirt', 'jeans', 'trainers', 'dress', 'jacket',
        'hoodie', 'shorts', 'boots', 'coat', 'swimwear',
        'socks', 'underwear', 'leggings', 'trousers', 'blouse'
    ];
}

/**
 * Walks the site catalog and returns an array of online root-level category IDs.
 * Stops at LIMITS.maxCategories.
 *
 * @returns {string[]}
 */
function loadTopCategoryIDs() {
    var cat  = CatalogMgr.getSiteCatalog();
    if (!cat) { return []; }

    var root    = cat.getRoot();
    var subCats = root.getOnlineSubCategories();
    var ids     = [];
    var iter    = subCats.iterator();

    while (iter.hasNext() && ids.length < LIMITS.maxCategories) {
        var sub = iter.next();
        if (sub.online) { ids.push(sub.getID()); }

        // Include one level of sub-categories (department pages)
        var secondLevel = sub.getOnlineSubCategories();
        var iter2       = secondLevel.iterator();
        while (iter2.hasNext() && ids.length < LIMITS.maxCategories) {
            var sub2 = iter2.next();
            if (sub2.online) { ids.push(sub2.getID()); }
        }
    }

    return ids;
}

/**
 * Returns a small set of high-value refinement combos to warm per category.
 * These are brand-agnostic starting points — tune for your catalog.
 *
 * @returns {Object[]}  Array of refinement objects
 */
function getTopRefinementCombos() {
    return [
        { color: 'black' },
        { color: 'white' },
        { gender: 'womens' },
        { gender: 'mens' },
        { newArrival: 'true' }
    ].slice(0, LIMITS.maxRefCombos);
}

/**
 * Executes a single search and writes to cache.
 * Errors are caught and logged — a failed warm-up entry should not abort the job.
 *
 * @param  {Object}  params
 * @param  {Object}  stats   - Mutable stats counter { warmed, failed, skipped }
 */
function warmSingle(params, stats) {
    try {
        var result = SearchQueryOptimizer.execute(params);

        if (!result || result.total === 0) {
            // No results — don't cache empty results
            stats.skipped++;
            return;
        }

        SearchResultCache.warmCache([params], function (p) {
            return SearchQueryOptimizer.execute(p);
        });

        stats.warmed++;

    } catch (e) {
        Logger.error('SearchIndexWarmup warmSingle failed q="{0}" cat={1}: {2}',
            params.query, params.categoryID, e.message);
        stats.failed++;
    }
}

// ─── Main job step ────────────────────────────────────────────────────────────

/**
 * Entry point called by the SFCC Job framework.
 * @returns {dw.system.Status}
 */
function execute() {
    var startTime = Date.now();
    var stats     = { warmed: 0, failed: 0, skipped: 0 };

    Logger.info('SearchIndexWarmup: starting cache warm-up for site={0}',
        Site.getCurrent().getID());

    // ── Phase 1: Top text queries across all sort rules ───────────────────────

    var topQueries = loadTopQueries();
    Logger.info('SearchIndexWarmup: warming {0} top queries × {1} sort rules',
        topQueries.length, LIMITS.sortRules.length);

    topQueries.forEach(function (query) {
        LIMITS.sortRules.forEach(function (sortRule) {
            warmSingle({
                query   : query,
                sortRule: sortRule,
                pageSize: LIMITS.pageSize,
                pageStart: 0
            }, stats);
        });
    });

    // ── Phase 2: Category browse pages ────────────────────────────────────────

    var categoryIDs = loadTopCategoryIDs();
    Logger.info('SearchIndexWarmup: warming {0} category pages', categoryIDs.length);

    categoryIDs.forEach(function (catID) {
        // Base category (no refinements) × sort rules
        LIMITS.sortRules.forEach(function (sortRule) {
            warmSingle({
                categoryID: catID,
                sortRule  : sortRule,
                pageSize  : LIMITS.pageSize,
                pageStart : 0
            }, stats);
        });
    });

    // ── Phase 3: Category + refinement combos ─────────────────────────────────

    var refCombos   = getTopRefinementCombos();
    var topCatIDs   = categoryIDs.slice(0, 10);  // Only top 10 cats for combos

    Logger.info('SearchIndexWarmup: warming {0} categories × {1} refinement combos',
        topCatIDs.length, refCombos.length);

    topCatIDs.forEach(function (catID) {
        refCombos.forEach(function (refs) {
            warmSingle({
                categoryID  : catID,
                refinements : refs,
                sortRule    : 'best-matches',
                pageSize    : LIMITS.pageSize,
                pageStart   : 0
            }, stats);
        });
    });

    // ── Summary ───────────────────────────────────────────────────────────────

    var durationMs = Date.now() - startTime;
    var durationS  = (durationMs / 1000).toFixed(1);

    Logger.info([
        'SearchIndexWarmup complete.',
        'warmed=' + stats.warmed,
        'failed=' + stats.failed,
        'skipped=' + stats.skipped,
        'duration=' + durationS + 's'
    ].join(' '));

    if (stats.failed > 0) {
        return new Status(
            Status.OK,
            'WARM_WITH_ERRORS',
            'Cache warm-up completed with ' + stats.failed + ' errors. See logs for details.'
        );
    }

    return new Status(
        Status.OK,
        'WARM_COMPLETE',
        'Cache warm-up complete. ' + stats.warmed + ' entries in ' + durationS + 's.'
    );
}

module.exports = { execute: execute };
