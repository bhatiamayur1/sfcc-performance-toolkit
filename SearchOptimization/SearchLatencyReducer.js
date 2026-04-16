/**
 * SearchLatencyReducer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /search-optimization
 *
 * Client-side and server-side techniques for reducing perceived and real
 * search latency on SFCC storefronts with large catalogs.
 *
 * Techniques implemented:
 *
 *   1. TYPE-AHEAD DEBOUNCER
 *      Fires AJAX search requests only after the user pauses typing (300 ms).
 *      Prevents flooding the SFCC Search API with a request per keystroke.
 *
 *   2. PREDICTIVE PREFETCH
 *      Pre-fetches likely next queries (category drill-down, popular sort rules)
 *      when the user hovers over a refinement or sort control — so results feel
 *      instant when they click.
 *
 *   3. OPTIMISTIC SKELETON REVEAL
 *      Immediately shows skeleton placeholders when a search fires, replacing
 *      "white flash" with a smooth loading state that communicates progress.
 *
 *   4. STALE-WHILE-REVALIDATE (SWR) PATTERN
 *      Serves the last valid result immediately from sessionStorage while the
 *      fresh result loads in the background. Eliminates blank-screen flicker on
 *      back-navigation and filter changes.
 *
 *   5. SERVER-SIDE: QUERY NORMALISER
 *      Normalises incoming search terms (case, whitespace, common synonyms)
 *      before hitting the cache — maximising cache hit rates across slight
 *      query variations that would otherwise miss.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FILE SPLIT:
 *   Part A (this file, top)  — SERVER-SIDE utilities (require() in SFCC scripts)
 *   Part B (IIFE at bottom)  — CLIENT-SIDE utilities (include via <script> tag)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ═════════════════════════════════════════════════════════════════════════════
// PART A — SERVER-SIDE: QueryNormaliser
// Require in SFCC controllers / scripts.
// ═════════════════════════════════════════════════════════════════════════════

'use strict';

var Logger = require('dw/system/Logger').getLogger('search', 'SearchLatencyReducer');

// ─── Synonym map ──────────────────────────────────────────────────────────────

/**
 * Common query synonyms to normalise before cache lookup.
 * Extend with brand-specific and locale-specific terms.
 * Key: normalised canonical term → Value: array of surface forms to replace.
 *
 * Example: "tshirt" and "t-shirt" both map to "t shirt" so they hit the same
 * cache entry and the same SFCC search index synonym group.
 */
var SYNONYM_MAP = {
    't shirt'  : ['tshirt', 't-shirt', 'tee shirt', 'teeshirt'],
    'joggers'  : ['jogging bottoms', 'sweatpants', 'tracksuit bottoms'],
    'sneakers' : ['trainers', 'sport shoes', 'athletic shoes'],
    'hoodie'   : ['hoody', 'hooded sweatshirt', 'hooded top'],
    'denim'    : ['jeans denim', 'jeans'],
    'swimwear' : ['swim wear', 'bathing suit', 'swimming costume', 'swimsuit'],
    'kids'     : ['children', 'childrens', "children's", 'child'],
    'womens'   : ["women's", 'ladies', "ladies'", 'woman'],
    'mens'     : ["men's", 'gents', 'male', 'man']
};

/**
 * Builds a reverse lookup: surface form → canonical term.
 * @returns {Object}
 */
function buildReverseSynonymMap() {
    var reverse = {};
    Object.keys(SYNONYM_MAP).forEach(function (canonical) {
        SYNONYM_MAP[canonical].forEach(function (surface) {
            reverse[surface.toLowerCase()] = canonical;
        });
    });
    return reverse;
}

var REVERSE_SYNONYMS = buildReverseSynonymMap();

// ─── QueryNormaliser ──────────────────────────────────────────────────────────

var QueryNormaliser = {

    /**
     * Normalises a raw search query string for consistent cache key generation
     * and improved SFCC search index hit rates.
     *
     * Transformations applied (in order):
     *   1. Lowercase
     *   2. Trim + collapse internal whitespace
     *   3. Strip leading/trailing punctuation
     *   4. Replace known synonyms with canonical form
     *   5. Remove common stop words (only when query has > 1 token)
     *
     * @param  {string} rawQuery
     * @returns {string} Normalised query
     */
    normalise: function (rawQuery) {
        if (!rawQuery || typeof rawQuery !== 'string') { return ''; }

        var q = rawQuery
            .toLowerCase()
            .trim()
            .replace(/\s{2,}/g, ' ')               // Collapse whitespace
            .replace(/^[^\w]+|[^\w]+$/g, '');       // Strip leading/trailing non-word chars

        // Synonym substitution — check each token and the full phrase
        var substituted = REVERSE_SYNONYMS[q] || q;

        // Token-level synonym substitution for multi-word queries
        if (substituted === q && q.indexOf(' ') !== -1) {
            var tokens = q.split(' ');
            substituted = tokens.map(function (token) {
                return REVERSE_SYNONYMS[token] || token;
            }).join(' ');
        }

        return substituted.trim();
    },

    /**
     * Returns true if two queries normalise to the same string.
     * Useful for deduplicating type-ahead requests.
     *
     * @param  {string} a
     * @param  {string} b
     * @returns {boolean}
     */
    equivalent: function (a, b) {
        return QueryNormaliser.normalise(a) === QueryNormaliser.normalise(b);
    },

    /**
     * Returns a canonical sort key for the query — useful for grouping
     * analytics and warming cache by query cluster.
     *
     * @param  {string} query
     * @returns {string}
     */
    sortKey: function (query) {
        return QueryNormaliser.normalise(query).split(' ').sort().join(' ');
    },

    SYNONYM_MAP     : SYNONYM_MAP,
    REVERSE_SYNONYMS: REVERSE_SYNONYMS
};

module.exports = { QueryNormaliser: QueryNormaliser };

// ═════════════════════════════════════════════════════════════════════════════
// PART B — CLIENT-SIDE: SearchLatencyReducer
// Include as a static JS file via ScriptLoader at 'high' priority.
// ═════════════════════════════════════════════════════════════════════════════

/* eslint-disable */
;(function (window, document) {
    'use strict';

    // ── Utility: debounce ────────────────────────────────────────────────────

    /**
     * Returns a debounced version of fn that fires only after `wait` ms of silence.
     * @param  {Function} fn
     * @param  {number}   wait
     * @returns {Function}
     */
    function debounce(fn, wait) {
        var timer;
        return function () {
            var ctx  = this;
            var args = arguments;
            clearTimeout(timer);
            timer = setTimeout(function () { fn.apply(ctx, args); }, wait);
        };
    }

    // ── Utility: simple fetch wrapper (IE11 fallback via XHR) ────────────────

    function ajaxGet(url, callback) {
        if (typeof fetch !== 'undefined') {
            fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
                .then(function (r) { return r.json(); })
                .then(function (data) { callback(null, data); })
                .catch(function (e) { callback(e, null); });
        } else {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
            xhr.onload  = function () {
                try { callback(null, JSON.parse(xhr.responseText)); }
                catch (e) { callback(e, null); }
            };
            xhr.onerror = function (e) { callback(e, null); };
            xhr.send();
        }
    }

    // ─── 1. TYPE-AHEAD DEBOUNCER ─────────────────────────────────────────────

    var TypeAheadDebouncer = {
        _lastQuery: '',

        /**
         * Attaches a debounced search handler to an input element.
         *
         * @param {HTMLInputElement} input      - Search input element
         * @param {string}           searchURL  - Base SFCC search-suggest URL
         * @param {Function}         onResults  - Callback(results) when data arrives
         * @param {Object}           [opts]
         * @param {number}           [opts.delay=300]       - Debounce delay (ms)
         * @param {number}           [opts.minLength=2]     - Min chars before firing
         */
        attach: function (input, searchURL, onResults, opts) {
            if (!input) { return; }

            var options   = opts || {};
            var delay     = options.delay     || 300;
            var minLength = options.minLength || 2;
            var self      = this;

            var handler = debounce(function () {
                var q = input.value.trim();

                // Skip if query unchanged or too short
                if (q === self._lastQuery || q.length < minLength) { return; }
                self._lastQuery = q;

                var url = searchURL + (searchURL.indexOf('?') !== -1 ? '&' : '?') + 'q=' + encodeURIComponent(q);

                ajaxGet(url, function (err, data) {
                    if (err) {
                        console.warn('[TypeAheadDebouncer] Request failed:', err);
                        return;
                    }
                    onResults(data);
                });
            }, delay);

            input.addEventListener('input', handler);
            input.addEventListener('keyup', handler);  // Catches paste, autofill
        }
    };

    // ─── 2. PREDICTIVE PREFETCH ──────────────────────────────────────────────

    var PredictivePrefetch = {
        _prefetched: {},
        _timer     : null,

        /**
         * Pre-fetches a search result JSON on refinement/sort hover.
         * Stores the result in a window-level map so the real click handler
         * can read it synchronously (zero latency).
         *
         * @param {string} searchURL - Pre-built URL for the anticipated search
         */
        prefetch: function (searchURL) {
            if (this._prefetched[searchURL]) { return; }  // Already fetched

            this._prefetched[searchURL] = 'pending';

            ajaxGet(searchURL, function (err, data) {
                if (!err && data) {
                    PredictivePrefetch._prefetched[searchURL] = data;
                } else {
                    delete PredictivePrefetch._prefetched[searchURL];
                }
            });
        },

        /**
         * Returns a pre-fetched result if available, or null.
         * @param  {string} searchURL
         * @returns {Object|null}
         */
        get: function (searchURL) {
            var cached = this._prefetched[searchURL];
            return (cached && cached !== 'pending') ? cached : null;
        },

        /**
         * Attaches hover-prefetch behaviour to refinement links / sort options.
         *
         * @param {string} containerSelector - CSS selector for the refinement/sort container
         * @param {Function} urlBuilder       - Function(el) → search URL string
         */
        attachToRefinements: function (containerSelector, urlBuilder) {
            var container = document.querySelector(containerSelector);
            if (!container) { return; }

            var self = this;

            container.addEventListener('mouseover', function (e) {
                var el = e.target && e.target.closest ? e.target.closest('[data-refinement-url], [data-sort-url]') : null;
                if (!el) { return; }

                clearTimeout(self._timer);
                self._timer = setTimeout(function () {
                    var url = urlBuilder ? urlBuilder(el) : (el.getAttribute('data-refinement-url') || el.getAttribute('data-sort-url'));
                    if (url) { self.prefetch(url); }
                }, 150);  // 150ms hover intent — avoids prefetching on accidental mouseover
            });
        }
    };

    // ─── 3. OPTIMISTIC SKELETON REVEAL ──────────────────────────────────────

    var OptimisticSkeleton = {

        /**
         * Immediately replaces the product grid with skeleton cards, then
         * executes the search and replaces skeletons with real results.
         *
         * @param {HTMLElement} gridEl      - Product grid container
         * @param {number}      count       - Number of skeleton cards to show
         * @param {Function}    searchFn    - Async function that returns result HTML
         * @param {Function}    renderFn    - Function(html) that injects results into gridEl
         */
        execute: function (gridEl, count, searchFn, renderFn) {
            if (!gridEl) { return; }

            // Show skeletons immediately
            var skeletons = Array.from({ length: count }, function () {
                return [
                    '<div class="product-tile skeleton-card" aria-hidden="true">',
                    '  <div class="skeleton-card__body">',
                    '    <span class="skeleton-text skeleton-text--lg"></span>',
                    '    <span class="skeleton-text"></span>',
                    '    <span class="skeleton-text skeleton-text--sm"></span>',
                    '  </div>',
                    '</div>'
                ].join('');
            }).join('');

            gridEl.innerHTML = skeletons;
            gridEl.setAttribute('aria-busy', 'true');

            // Execute real search
            searchFn(function (resultHTML) {
                gridEl.innerHTML = resultHTML;
                gridEl.removeAttribute('aria-busy');
            });
        }
    };

    // ─── 4. STALE-WHILE-REVALIDATE (SWR) ────────────────────────────────────

    var SWRCache = {
        _PREFIX: 'sfcc_srch_',

        /**
         * Returns a cached result for a URL key and triggers a background refresh.
         *
         * @param  {string}   url           - Search URL (used as cache key)
         * @param  {Function} fetchFn       - Function(url, callback) to get fresh data
         * @param  {Function} onCached      - Called immediately with stale data (if any)
         * @param  {Function} onFresh       - Called when fresh data arrives
         * @param  {number}   [maxAgeMs]    - Max age of stale data (default: 5 min)
         */
        get: function (url, fetchFn, onCached, onFresh, maxAgeMs) {
            var key    = this._PREFIX + btoa(url).replace(/[^a-zA-Z0-9]/g, '').slice(0, 80);
            var maxAge = maxAgeMs || 5 * 60 * 1000;
            var stale  = null;

            try {
                var raw = sessionStorage.getItem(key);
                if (raw) {
                    var entry = JSON.parse(raw);
                    if (Date.now() - entry.ts < maxAge) {
                        stale = entry.data;
                        onCached(stale);  // Serve stale immediately
                    }
                }
            } catch (e) { /* sessionStorage unavailable or quota exceeded */ }

            // Always fetch fresh data in the background
            fetchFn(url, function (err, fresh) {
                if (err || !fresh) { return; }

                // Store fresh result
                try {
                    sessionStorage.setItem(key, JSON.stringify({ data: fresh, ts: Date.now() }));
                } catch (e) { /* quota exceeded — degrade silently */ }

                // Only call onFresh if data has changed
                if (JSON.stringify(fresh) !== JSON.stringify(stale)) {
                    onFresh(fresh);
                }
            });
        },

        /** Clears all SWR cache entries (e.g. after cart/session change). */
        clear: function () {
            try {
                var keys = Object.keys(sessionStorage).filter(function (k) {
                    return k.indexOf(SWRCache._PREFIX) === 0;
                });
                keys.forEach(function (k) { sessionStorage.removeItem(k); });
            } catch (e) { /* no-op */ }
        }
    };

    // ─── Public API ──────────────────────────────────────────────────────────

    window.SearchLatencyReducer = {
        TypeAheadDebouncer  : TypeAheadDebouncer,
        PredictivePrefetch  : PredictivePrefetch,
        OptimisticSkeleton  : OptimisticSkeleton,
        SWRCache            : SWRCache,

        /**
         * One-shot initialisation — wires up all client-side techniques
         * for a standard SFRA search page.
         *
         * @param {Object} config
         * @param {string} config.searchInput       - CSS selector for the search <input>
         * @param {string} config.suggestURL        - SFCC suggest endpoint URL
         * @param {string} config.refinementPanel   - CSS selector for refinement sidebar
         * @param {string} config.productGrid       - CSS selector for product grid
         * @param {number} [config.pageSize]        - Products per page (for skeleton count)
         */
        init: function (config) {
            var input       = document.querySelector(config.searchInput);
            var gridEl      = document.querySelector(config.productGrid);
            var pageSize    = config.pageSize || 24;

            // 1. Debounced type-ahead
            TypeAheadDebouncer.attach(input, config.suggestURL, function (results) {
                // Render suggest dropdown — implement per your storefront's markup
                document.dispatchEvent(new CustomEvent('sfcc:suggestions', { detail: results }));
            });

            // 2. Predictive prefetch on refinement hover
            PredictivePrefetch.attachToRefinements(config.refinementPanel, null);

            // 3. Listen for search-initiated events and show skeletons
            document.addEventListener('sfcc:searchStart', function (e) {
                var url = e.detail && e.detail.url;
                if (!gridEl || !url) { return; }

                // Check if we have a prefetched result
                var prefetched = PredictivePrefetch.get(url);
                if (prefetched) {
                    document.dispatchEvent(new CustomEvent('sfcc:searchResult', { detail: prefetched }));
                    return;
                }

                // Show skeletons while real search runs
                OptimisticSkeleton.execute(gridEl, pageSize, function (done) {
                    ajaxGet(url, function (err, data) {
                        if (!err && data) { done(data.gridHTML || ''); }
                    });
                }, function (html) {
                    gridEl.innerHTML = html;
                });
            });
        }
    };

}(window, document));
/* eslint-enable */
