/**
 * SearchResultCache.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /search-optimization
 *
 * Two-tier search result cache designed for large SFCC catalogs:
 *
 *   Tier 1 — HOT cache (CacheMgr, in-process, ~0 ms)
 *     Caches full search result payloads for the most popular queries.
 *     Populated by frequency tracking — a query enters HOT only after it
 *     crosses a hit-count threshold, avoiding cache pollution from long-tail
 *     one-off searches.
 *
 *   Tier 2 — WARM cache (CacheMgr, longer TTL, serialised hit list only)
 *     Caches product ID arrays for all cached queries. On a hit, product
 *     detail is hydrated separately (via APIResponseCache + RequestBatcher)
 *     so that price/inventory freshness is guaranteed even when search
 *     structure is served from cache.
 *
 * Key design decision — WHAT is cached:
 *   We cache the STRUCTURE (which products, in which order, with which facets)
 *   separately from the DETAIL (prices, availability). Structure changes only
 *   when the catalog index refreshes (hours). Detail changes constantly.
 *   This split lets us use aggressive TTLs on structure without serving
 *   stale prices.
 *
 * Usage:
 *   var SearchResultCache = require('*/cartridge/scripts/search/SearchResultCache');
 *   var Optimizer         = require('*/cartridge/scripts/search/SearchQueryOptimizer');
 *
 *   var result = SearchResultCache.getOrSearch(params, function () {
 *       return Optimizer.execute(params);
 *   });
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var CacheMgr = require('dw/system/CacheMgr');
var Logger   = require('dw/system/Logger').getLogger('search', 'SearchResultCache');

// ─── Configuration ────────────────────────────────────────────────────────────

var CONFIG = {
    /** TTL for full (HOT) cached results — 5 minutes */
    hotTTL: 300,

    /** TTL for WARM cached result (product ID list only) — 30 minutes */
    warmTTL: 1800,

    /**
     * Number of times a query must be seen before its result enters HOT cache.
     * Prevents one-off long-tail queries from polluting the hot tier.
     */
    hotThreshold: 3,

    /** TTL for the frequency counter entries — 1 hour */
    freqTTL: 3600,

    /** Maximum number of refinement combos cached per base query.
     *  Beyond this, only the base (unrefined) result is cached. */
    maxRefinementVariants: 10,

    /** Queries shorter than this are never cached (too ambiguous). */
    minQueryLength: 2,

    /** Cache key prefix namespaces */
    PREFIX: {
        hot : 'srch:hot:',
        warm: 'srch:warm:',
        freq: 'srch:freq:'
    }
};

// ─── Key builder ──────────────────────────────────────────────────────────────

/**
 * Builds a canonical, deterministic cache key for a search parameter set.
 * Refinements are sorted so that {color:red, size:M} and {size:M, color:red}
 * produce the same key.
 *
 * @param  {Object} params  - Normalised search params from the controller
 * @returns {{ hot: string, warm: string, freq: string }}
 */
function buildKeys(params) {
    var parts = [];

    if (params.query)      { parts.push('q=' + encodeURIComponent(params.query.toLowerCase().trim())); }
    if (params.categoryID) { parts.push('cat=' + params.categoryID); }
    if (params.sortRule)   { parts.push('s=' + params.sortRule); }

    // Page start IS part of the key — page 1 and page 2 are different results
    if (params.pageStart)  { parts.push('p=' + params.pageStart); }
    if (params.pageSize)   { parts.push('sz=' + params.pageSize); }

    // Refinements — sort for determinism
    var refs = params.refinements || {};
    var refKeys = Object.keys(refs).sort();
    refKeys.forEach(function (k) {
        var v = Array.isArray(refs[k]) ? refs[k].slice().sort().join(',') : String(refs[k]);
        parts.push('r.' + k + '=' + encodeURIComponent(v));
    });

    var base = parts.join('|').replace(/[^a-zA-Z0-9_=|.%-]/g, '_');

    return {
        hot : CONFIG.PREFIX.hot  + base,
        warm: CONFIG.PREFIX.warm + base,
        freq: CONFIG.PREFIX.freq + (params.query || params.categoryID || 'browse')
    };
}

// ─── Frequency tracker ────────────────────────────────────────────────────────

/**
 * Increments the frequency counter for a base query and returns the new count.
 * Used to determine whether a query is "popular enough" for HOT caching.
 *
 * @param  {string} freqKey
 * @returns {number} Updated frequency count
 */
function incrementFrequency(freqKey) {
    var safeKey = freqKey.replace(/[^a-zA-Z0-9_:.-]/g, '_');
    try {
        var current = CacheMgr.get(safeKey);
        var next    = ((current && current.count) || 0) + 1;
        CacheMgr.put(safeKey, { count: next }, CONFIG.freqTTL);
        return next;
    } catch (e) {
        Logger.warn('SearchResultCache freq increment error: {0}', e.message);
        return 0;
    }
}

/**
 * Returns the current frequency count for a query key.
 * @param  {string} freqKey
 * @returns {number}
 */
function getFrequency(freqKey) {
    var safeKey = freqKey.replace(/[^a-zA-Z0-9_:.-]/g, '_');
    try {
        var entry = CacheMgr.get(safeKey);
        return (entry && entry.count) || 0;
    } catch (e) {
        return 0;
    }
}

// ─── Cache read ───────────────────────────────────────────────────────────────

/**
 * Attempts to read from HOT cache, then WARM cache.
 *
 * @param  {{ hot: string, warm: string }} keys
 * @returns {{ tier: 'hot'|'warm'|null, data: Object|null }}
 */
function readFromCache(keys) {
    // ── Tier 1: HOT ───────────────────────────────────────────────────────────
    try {
        var hot = CacheMgr.get(keys.hot);
        if (hot && hot.result) {
            Logger.info('SearchResultCache HOT HIT key={0}', keys.hot);
            return { tier: 'hot', data: hot.result };
        }
    } catch (e) {
        Logger.warn('SearchResultCache HOT read error: {0}', e.message);
    }

    // ── Tier 2: WARM (structure only — product IDs + facets) ──────────────────
    try {
        var warm = CacheMgr.get(keys.warm);
        if (warm && warm.productIDs) {
            Logger.info('SearchResultCache WARM HIT key={0} ids={1}', keys.warm, warm.productIDs.length);
            return { tier: 'warm', data: warm };
        }
    } catch (e) {
        Logger.warn('SearchResultCache WARM read error: {0}', e.message);
    }

    return { tier: null, data: null };
}

// ─── Cache write ──────────────────────────────────────────────────────────────

/**
 * Writes a search result to the appropriate cache tier(s).
 *
 * @param  {{ hot: string, warm: string }} keys
 * @param  {Object}  result         - Full result from SearchQueryOptimizer.execute()
 * @param  {number}  freqCount      - Current frequency count for this query
 */
function writeToCache(keys, result, freqCount) {
    // Always write to WARM (structure — cheap to store, long TTL)
    try {
        var warmEntry = {
            productIDs    : result.hits.map(function (h) { return h.id; }),
            total         : result.total,
            refinementMeta: result.refinementMeta,
            sortRule      : result.sortRule,
            cachedAt      : Date.now()
        };
        CacheMgr.put(keys.warm, warmEntry, CONFIG.warmTTL);
    } catch (e) {
        Logger.warn('SearchResultCache WARM write error: {0}', e.message);
    }

    // Only write to HOT if query meets popularity threshold
    if (freqCount >= CONFIG.hotThreshold) {
        try {
            CacheMgr.put(keys.hot, { result: result, cachedAt: Date.now() }, CONFIG.hotTTL);
            Logger.info('SearchResultCache HOT POPULATED key={0} freq={1}', keys.hot, freqCount);
        } catch (e) {
            Logger.warn('SearchResultCache HOT write error: {0}', e.message);
        }
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

var SearchResultCache = {

    /**
     * Main entry point — returns a cached result or executes a fresh search.
     *
     * @param  {Object}   params      - Normalised search params (same as SearchQueryOptimizer.execute)
     * @param  {Function} searchFn    - Zero-argument function that executes the live search
     * @returns {Object}  Search result (same shape as SearchQueryOptimizer.execute return value)
     *                    plus { cacheHit: boolean, cacheTier: 'hot'|'warm'|null }
     */
    getOrSearch: function (params, searchFn) {
        var query = (params.query || '').trim();

        // ── Skip cache for very short / empty queries ─────────────────────────
        if (query.length > 0 && query.length < CONFIG.minQueryLength) {
            var live = searchFn();
            live.cacheHit  = false;
            live.cacheTier = null;
            return live;
        }

        var keys      = buildKeys(params);
        var freqCount = incrementFrequency(keys.freq);
        var cached    = readFromCache(keys);

        if (cached.data) {
            var out = cached.tier === 'hot'
                ? cached.data
                : {
                    // WARM hit — return structure; caller hydrates product detail
                    hits          : cached.data.productIDs.map(function (id) { return { id: id }; }),
                    total         : cached.data.total,
                    refinementMeta: cached.data.refinementMeta,
                    sortRule      : cached.data.sortRule,
                    pageSize      : params.pageSize,
                    pageStart     : params.pageStart,
                    durationMs    : 0,
                    spellCorrected: false
                };

            out.cacheHit  = true;
            out.cacheTier = cached.tier;
            return out;
        }

        // ── Cache miss — execute live search ──────────────────────────────────
        Logger.info('SearchResultCache MISS key={0} freq={1}', keys.hot, freqCount);

        var result = searchFn();
        writeToCache(keys, result, freqCount);

        result.cacheHit  = false;
        result.cacheTier = null;
        return result;
    },

    /**
     * Explicitly invalidates HOT and WARM entries for given search params.
     * Call from a post-catalog-publish hook or after a manual content update.
     *
     * @param {Object} params
     */
    invalidate: function (params) {
        var keys = buildKeys(params);
        [keys.hot, keys.warm].forEach(function (k) {
            try {
                CacheMgr.remove(k);
                Logger.info('SearchResultCache INVALIDATED key={0}', k);
            } catch (e) {
                Logger.warn('SearchResultCache invalidation error key={0}: {1}', k, e.message);
            }
        });
    },

    /**
     * Warms the HOT cache for a list of high-priority queries.
     * Call from a scheduled SFCC Job after catalog index rebuilds.
     *
     * @param  {Object[]} queryList   - Array of param objects to pre-warm
     * @param  {Function} searchFn    - Function(params) → result
     * @returns {{ warmed: number, failed: number }}
     */
    warmCache: function (queryList, searchFn) {
        var warmed = 0;
        var failed = 0;

        queryList.forEach(function (params) {
            try {
                var result = searchFn(params);
                var keys   = buildKeys(params);
                // Force-write to HOT (bypass frequency threshold for warm-up)
                CacheMgr.put(keys.hot,  { result: result, cachedAt: Date.now() }, CONFIG.hotTTL);
                CacheMgr.put(keys.warm, {
                    productIDs    : result.hits.map(function (h) { return h.id; }),
                    total         : result.total,
                    refinementMeta: result.refinementMeta,
                    sortRule      : result.sortRule,
                    cachedAt      : Date.now()
                }, CONFIG.warmTTL);
                warmed++;
                Logger.info('SearchResultCache WARM-UP OK q="{0}"', params.query || params.categoryID);
            } catch (e) {
                failed++;
                Logger.error('SearchResultCache WARM-UP FAILED q="{0}": {1}',
                    params.query || params.categoryID, e.message);
            }
        });

        Logger.info('SearchResultCache warm-up complete. warmed={0} failed={1}', warmed, failed);
        return { warmed: warmed, failed: failed };
    },

    CONFIG: CONFIG
};

module.exports = SearchResultCache;
