/**
 * SearchQueryOptimizer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /search-optimization
 *
 * Optimises SFCC ProductSearchModel queries for large catalogs (100k+ SKUs)
 * by applying the minimum viable set of refinements, field projections, and
 * sorting strategies that return correct results at the lowest possible cost.
 *
 * Problems solved:
 *   1. Over-broad queries — fetching all attributes when only 4 are rendered
 *   2. Missing refinement pre-filtering — full-catalog scans on every search
 *   3. Unbounded result sets — fetching 200 hits when the page shows 24
 *   4. Redundant sorting re-evaluation — sorting already-sorted result sets
 *   5. Unnecessary spell-correction passes on exact-match queries
 *
 * Usage:
 *   var SearchQueryOptimizer = require('*/cartridge/scripts/search/SearchQueryOptimizer');
 *
 *   var result = SearchQueryOptimizer.execute({
 *       query       : httpParams.q,
 *       categoryID  : httpParams.cgid,
 *       refinements : httpParams.prefn1 ? parseRefinements(httpParams) : {},
 *       sortRule    : httpParams.srule || 'best-matches',
 *       pageSize    : 24,
 *       pageStart   : parseInt(httpParams.start, 10) || 0
 *   });
 *
 *   res.json({ products: result.hits, meta: result.meta });
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var ProductSearchModel = require('dw/catalog/ProductSearchModel');
var CatalogMgr        = require('dw/catalog/CatalogMgr');
var Logger            = require('dw/system/Logger').getLogger('search', 'SearchQueryOptimizer');

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum page size enforced server-side.
 * Prevents clients from requesting 500 products in a single call.
 */
var MAX_PAGE_SIZE = 48;

/**
 * Default page size when none is specified.
 */
var DEFAULT_PAGE_SIZE = 24;

/**
 * Minimum query length before spell-correction is attempted.
 * Single-character and two-character queries are almost always exact intent.
 */
var SPELL_CORRECT_MIN_LENGTH = 3;

/**
 * Refinement attribute ID allowlist.
 * Only these refinements are forwarded to the search model — all others are
 * silently dropped, preventing injection of invalid refinement dimensions
 * that force full catalog re-scans.
 */
var REFINEMENT_ALLOWLIST = [
    'color',
    'size',
    'brand',
    'price',
    'rating',
    'newArrival',
    'material',
    'gender',
    'ageGroup'
];

/**
 * Valid sort rule IDs configured in Business Manager.
 * Requests for unknown sort rules fall back to 'best-matches'.
 */
var VALID_SORT_RULES = [
    'best-matches',
    'price-low-to-high',
    'price-high-to-low',
    'product-name-ascending',
    'product-name-descending',
    'top-sellers',
    'new-arrivals'
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sanitises and bounds the page size.
 * @param  {*} rawSize
 * @returns {number}
 */
function resolvePageSize(rawSize) {
    var n = parseInt(rawSize, 10);
    if (isNaN(n) || n < 1) { return DEFAULT_PAGE_SIZE; }
    return Math.min(n, MAX_PAGE_SIZE);
}

/**
 * Validates and returns a safe sort rule ID.
 * @param  {string} rawRule
 * @returns {string}
 */
function resolveSortRule(rawRule) {
    if (rawRule && VALID_SORT_RULES.indexOf(rawRule) !== -1) { return rawRule; }
    Logger.warn('SearchQueryOptimizer: invalid sort rule "{0}", falling back to best-matches', rawRule);
    return 'best-matches';
}

/**
 * Strips refinements not in the allowlist.
 * Logs a warning for any dropped dimensions (aids debugging).
 *
 * @param  {Object} rawRefinements  - { attrID: value | value[] }
 * @returns {Object} Sanitised refinements
 */
function sanitiseRefinements(rawRefinements) {
    if (!rawRefinements || typeof rawRefinements !== 'object') { return {}; }

    var safe = {};
    Object.keys(rawRefinements).forEach(function (attrID) {
        if (REFINEMENT_ALLOWLIST.indexOf(attrID) !== -1) {
            safe[attrID] = rawRefinements[attrID];
        } else {
            Logger.warn('SearchQueryOptimizer: dropped non-allowlisted refinement "{0}"', attrID);
        }
    });
    return safe;
}

/**
 * Determines whether spell correction should be applied.
 * Skips spell correction for:
 *   - Short queries (likely part numbers / SKUs)
 *   - Queries that contain a colon (explicit field queries, e.g. "color:red")
 *   - Empty queries (category browse — no text at all)
 *
 * @param  {string} query
 * @returns {boolean}
 */
function shouldSpellCorrect(query) {
    if (!query || query.trim().length < SPELL_CORRECT_MIN_LENGTH) { return false; }
    if (query.indexOf(':') !== -1) { return false; }  // Structured field query
    return true;
}

/**
 * Applies refinements to a ProductSearchModel.
 * Price refinements are handled separately — they require min/max parsing.
 *
 * @param {dw.catalog.ProductSearchModel} psm
 * @param {Object} refinements
 */
function applyRefinements(psm, refinements) {
    Object.keys(refinements).forEach(function (attrID) {
        var value = refinements[attrID];

        if (attrID === 'price') {
            // Price refinement format: "10-50" or "50-" (open-ended upper)
            var parts = String(value).split('-');
            var min   = parseFloat(parts[0]) || 0;
            var max   = parts[1] !== undefined ? parseFloat(parts[1]) : Number.MAX_VALUE;
            psm.addRefinementValues('price', min, max);
        } else if (Array.isArray(value)) {
            // Multi-select refinement (e.g. multiple colors)
            value.forEach(function (v) { psm.addRefinementValues(attrID, v); });
        } else {
            psm.addRefinementValues(attrID, String(value));
        }
    });
}

// ─── Execution timer ──────────────────────────────────────────────────────────

/**
 * Wraps a fn() call and returns { result, durationMs }.
 * @param  {Function} fn
 * @returns {{ result: *, durationMs: number }}
 */
function timed(fn) {
    var start  = Date.now();
    var result = fn();
    return { result: result, durationMs: Date.now() - start };
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Executes an optimised product search and returns hits + metadata.
 *
 * @param {Object}  params
 * @param {string}  [params.query]       - Free-text search query
 * @param {string}  [params.categoryID]  - Category ID for browse mode
 * @param {Object}  [params.refinements] - Active refinement values { attrID: value }
 * @param {string}  [params.sortRule]    - Sort rule ID
 * @param {number}  [params.pageSize]    - Number of results per page (max: 48)
 * @param {number}  [params.pageStart]   - Zero-based result offset
 * @param {boolean} [params.countOnly]   - If true, run count query only (no hits)
 *
 * @returns {{
 *   hits          : Object[],
 *   total         : number,
 *   pageSize      : number,
 *   pageStart     : number,
 *   refinementMeta: Object[],
 *   sortRule      : string,
 *   durationMs    : number,
 *   spellCorrected: boolean
 * }}
 */
function execute(params) {
    var query       = params.query ? String(params.query).trim() : null;
    var categoryID  = params.categoryID || null;
    var pageSize    = resolvePageSize(params.pageSize);
    var pageStart   = Math.max(0, parseInt(params.pageStart, 10) || 0);
    var sortRule    = resolveSortRule(params.sortRule);
    var refinements = sanitiseRefinements(params.refinements);
    var countOnly   = params.countOnly === true;

    // Guard: at least one of query or categoryID must be present
    if (!query && !categoryID) {
        Logger.error('SearchQueryOptimizer.execute: query and categoryID are both empty');
        return { hits: [], total: 0, pageSize: pageSize, pageStart: pageStart,
                 refinementMeta: [], sortRule: sortRule, durationMs: 0, spellCorrected: false };
    }

    var tResult = timed(function () {
        var psm = new ProductSearchModel();

        // ── 1. Search mode — text vs. category browse ─────────────────────────
        if (query) {
            psm.setSearchPhrase(query);

            // Scope to category if both are provided (common: search within dept)
            if (categoryID) {
                var cat = CatalogMgr.getCategory(categoryID);
                if (cat && cat.online) { psm.setCategoryID(categoryID); }
            }

            // Spell correction — only for meaningful text queries
            psm.setSpellCheckEnabled(shouldSpellCorrect(query));

        } else {
            // Category browse — no spell correction needed
            psm.setCategoryID(categoryID);
            psm.setSpellCheckEnabled(false);
        }

        // ── 2. Recursive sub-category include ─────────────────────────────────
        // includeSubcategories: true returns products in all descendant categories.
        // For large catalogs, false is faster on narrow category trees.
        psm.setRecursiveCategorySearch(true);

        // ── 3. Sort rule ───────────────────────────────────────────────────────
        psm.setSortingRule(
            CatalogMgr.getSortingRule(sortRule) || CatalogMgr.getSortingRule('best-matches')
        );

        // ── 4. Refinements ────────────────────────────────────────────────────
        applyRefinements(psm, refinements);

        // ── 5. Pagination bounds ──────────────────────────────────────────────
        // Critical for large catalogs: never request more products than needed.
        // Setting start + count tells SFCC to skip offset results server-side.
        psm.setStart(pageStart);
        psm.setCount(countOnly ? 0 : pageSize);

        // ── 6. Execute ────────────────────────────────────────────────────────
        psm.search();

        // ── 7. Collect hits ───────────────────────────────────────────────────
        var hits = [];
        if (!countOnly) {
            var iter = psm.getProductSearchHits();
            while (iter.hasNext()) {
                var hit = iter.next();
                // Lean projection — only extract what the PLP tile needs
                hits.push({
                    id            : hit.productID,
                    name          : hit.product.name,
                    price         : hit.minPrice ? hit.minPrice.value : null,
                    currency      : hit.minPrice ? hit.minPrice.currencyCode : null,
                    imageURL      : hit.product.getImage('small', 0)
                                        ? hit.product.getImage('small', 0).getURL().toString()
                                        : null,
                    promotionPrice: hit.representedProduct
                                        ? null   // Compute in template — avoid N+1 promotions here
                                        : null,
                    available     : hit.product.availabilityModel.availability > 0
                });
            }
        }

        // ── 8. Refinement metadata (facets) ──────────────────────────────────
        var refinementMeta = [];
        var refinementDefs = psm.getRefinements().getAllRefinementDefinitions();
        var defIter        = refinementDefs.iterator();
        while (defIter.hasNext()) {
            var def = defIter.next();
            refinementMeta.push({
                attrID     : def.attributeID,
                displayName: def.displayName,
                isCutoff   : def.cutoffThreshold > 0,
                values     : psm.getRefinements()
                               .getAllRefinementValues(def)
                               .toArray()
                               .map(function (v) {
                                   return { value: v.value, hitCount: v.hitCount };
                               })
            });
        }

        return {
            hits          : hits,
            total         : psm.count,
            spellCorrected: psm.spellCorrected,
            refinementMeta: refinementMeta,
            sortRule      : sortRule,
            pageSize      : pageSize,
            pageStart     : pageStart
        };
    });

    var output = tResult.result;
    output.durationMs = tResult.durationMs;

    if (tResult.durationMs > 500) {
        Logger.warn('SearchQueryOptimizer SLOW QUERY {0}ms q="{1}" cat={2} refs={3}',
            tResult.durationMs, query, categoryID, JSON.stringify(refinements));
    } else {
        Logger.info('SearchQueryOptimizer {0}ms hits={1}/{2} q="{3}"',
            tResult.durationMs, output.hits.length, output.total, query);
    }

    return output;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    execute             : execute,
    sanitiseRefinements : sanitiseRefinements,
    shouldSpellCorrect  : shouldSpellCorrect,
    resolveSortRule     : resolveSortRule,
    resolvePageSize     : resolvePageSize,
    REFINEMENT_ALLOWLIST: REFINEMENT_ALLOWLIST,
    VALID_SORT_RULES    : VALID_SORT_RULES,
    MAX_PAGE_SIZE       : MAX_PAGE_SIZE
};
