/**
 * SegmentedCacheManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /personalization-performance/caching
 *
 * Solves the hardest caching problem in personalization: how do you cache
 * content that differs by customer segment without creating an explosion
 * of cache variants that kills your hit rate?
 *
 * Core approach — "Segmented Cache":
 *   Instead of one cache entry per URL (anonymous), maintain N entries per URL
 *   where N = number of active segments. Each segment gets its own tailored
 *   response cached independently.
 *
 * Why this beats per-user caching:
 *   Per-user cache: 1,000,000 customers = 1M cache entries (hit rate → 0)
 *   Segmented cache: 10 segments = 10 cache entries (hit rate stays high)
 *
 * Cache architecture:
 *   Key:   <namespace>:<segment>:<url-canonical>
 *   Value: { html: string, meta: Object, cachedAt: number, ttl: number }
 *
 * Cascading fallback:
 *   Segment cache miss → try ANONYMOUS cache → live render
 *   (anonymous response used as fallback for all segments on cold start)
 *
 * Usage:
 *   var SCM = require('*/cartridge/scripts/personalization/SegmentedCacheManager');
 *
 *   var cached = SCM.get('homepage-hero', segment, pageURL);
 *   if (!cached) {
 *       var rendered = renderComponent(segment);
 *       SCM.set('homepage-hero', segment, pageURL, rendered, { ttl: 300 });
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var CacheMgr = require('dw/system/CacheMgr');
var Logger   = require('dw/system/Logger').getLogger('personalization', 'SegmentedCache');

// ─── Configuration ────────────────────────────────────────────────────────────

var CONFIG = {
    /** Default TTL (seconds) for segment cache entries */
    defaultTTL: 300,

    /** Maximum TTL cap — prevents stale personalized content */
    maxTTL: 900,

    /**
     * Maximum number of segments to cache variants for.
     * Beyond this, fall back to ANONYMOUS cache for that segment.
     * Protects against segment count explosion.
     */
    maxSegmentVariants: 15,

    /** Cache key namespace prefix */
    namespace: 'ps:seg',

    /**
     * Segments eligible for dedicated cache variants.
     * All others fall back to ANONYMOUS cache (safe default).
     */
    cacheableSegments: [
        'anonymous', 'new-visitor', 'returning',
        'loyal', 'vip', 'sale-hunter', 'abandoner',
        'wholesale', 'staff', 'reactivation'
    ]
};

// ─── Key builder ──────────────────────────────────────────────────────────────

/**
 * Builds a deterministic cache key for a segment+URL combination.
 * Strips non-canonical URL params to maximise cache reuse.
 *
 * @param  {string} namespace  - Content block name (e.g. 'homepage-hero')
 * @param  {string} segment    - Customer segment ID
 * @param  {string} [pageURL]  - Current page URL for context
 * @param  {Object} [dims]     - Extra dimensions { locale, currency }
 * @returns {string}
 */
function buildKey(namespace, segment, pageURL, dims) {
    var parts = [CONFIG.namespace, namespace, segment];

    if (pageURL) {
        // Extract only canonical URL params
        var canonicalPath = pageURL.split('?')[0];
        var queryString   = pageURL.split('?')[1] || '';
        var canonicalParams = queryString
            .split('&')
            .filter(function (p) {
                var key = p.split('=')[0];
                return ['cgid', 'pid', 'q'].indexOf(key) !== -1;
            })
            .sort()
            .join('&');

        var urlPart = encodeURIComponent(canonicalPath + (canonicalParams ? '?' + canonicalParams : ''))
            .replace(/%/g, '_')
            .slice(0, 60);
        parts.push(urlPart);
    }

    if (dims) {
        if (dims.locale)   { parts.push('l=' + dims.locale.replace('_', '-')); }
        if (dims.currency) { parts.push('c=' + dims.currency); }
    }

    return parts.join(':');
}

// ─── Segment eligibility ──────────────────────────────────────────────────────

/**
 * Returns true if this segment is eligible for dedicated cache storage.
 * Ineligible segments fall back to the ANONYMOUS cache entry.
 *
 * @param  {string} segment
 * @returns {boolean}
 */
function isSegmentCacheable(segment) {
    return CONFIG.cacheableSegments.indexOf(segment) !== -1;
}

/**
 * Resolves the effective cache segment.
 * Unknown or ineligible segments fall back to 'anonymous'.
 *
 * @param  {string} segment
 * @returns {string}
 */
function resolveEffectiveSegment(segment) {
    return isSegmentCacheable(segment) ? segment : 'anonymous';
}

// ─── Core operations ──────────────────────────────────────────────────────────

var SegmentedCacheManager = {

    /**
     * Retrieves a cached content fragment for a segment.
     * Falls back to ANONYMOUS cache on segment miss.
     *
     * @param  {string} namespace  - Content block name
     * @param  {string} segment    - Customer segment
     * @param  {string} [pageURL]
     * @param  {Object} [dims]     - { locale, currency }
     * @returns {{ content: *, cachedAt: number, segment: string, isFallback: boolean } | null}
     */
    get: function (namespace, segment, pageURL, dims) {
        var effectiveSeg = resolveEffectiveSegment(segment);
        var key          = buildKey(namespace, effectiveSeg, pageURL, dims);

        // ── Primary: exact segment match ──────────────────────────────────────
        try {
            var cached = CacheMgr.get(key);
            if (cached && cached.content !== undefined) {
                var age = Math.round((Date.now() - cached.cachedAt) / 1000);
                Logger.info('SCM HIT seg={0} key={1} age={2}s', effectiveSeg, key, age);
                return {
                    content    : cached.content,
                    meta       : cached.meta || {},
                    cachedAt   : cached.cachedAt,
                    segment    : effectiveSeg,
                    isFallback : false
                };
            }
        } catch (e) {
            Logger.warn('SCM read error seg={0}: {1}', effectiveSeg, e.message);
        }

        // ── Fallback: anonymous cache ─────────────────────────────────────────
        if (effectiveSeg !== 'anonymous') {
            try {
                var anonKey    = buildKey(namespace, 'anonymous', pageURL, dims);
                var anonCached = CacheMgr.get(anonKey);
                if (anonCached && anonCached.content !== undefined) {
                    Logger.info('SCM FALLBACK to anonymous seg={0} key={1}', effectiveSeg, key);
                    return {
                        content    : anonCached.content,
                        meta       : anonCached.meta || {},
                        cachedAt   : anonCached.cachedAt,
                        segment    : 'anonymous',
                        isFallback : true
                    };
                }
            } catch (e) { /* non-fatal */ }
        }

        Logger.info('SCM MISS seg={0} ns={1}', effectiveSeg, namespace);
        return null;
    },

    /**
     * Stores a content fragment for a segment.
     *
     * @param  {string} namespace
     * @param  {string} segment
     * @param  {string} [pageURL]
     * @param  {*}      content    - Content to cache (string, object, etc.)
     * @param  {Object} [opts]
     * @param  {number} [opts.ttl]    - Override default TTL
     * @param  {Object} [opts.meta]   - Extra metadata (component name, version, etc.)
     * @param  {Object} [opts.dims]   - { locale, currency }
     */
    set: function (namespace, segment, pageURL, content, opts) {
        var options      = opts || {};
        var effectiveSeg = resolveEffectiveSegment(segment);
        var ttl          = Math.min(options.ttl || CONFIG.defaultTTL, CONFIG.maxTTL);
        var key          = buildKey(namespace, effectiveSeg, pageURL, options.dims);

        try {
            var entry = {
                content  : content,
                meta     : options.meta || {},
                cachedAt : Date.now(),
                ttl      : ttl
            };
            CacheMgr.put(key, entry, ttl);
            Logger.info('SCM SET seg={0} ns={1} ttl={2}s', effectiveSeg, namespace, ttl);
        } catch (e) {
            Logger.warn('SCM write error seg={0} ns={1}: {2}', effectiveSeg, namespace, e.message);
        }
    },

    /**
     * Invalidates cache entries for a namespace across all segments.
     * Call after a content publish or promotion change.
     *
     * @param {string}   namespace
     * @param {string}   [pageURL]
     * @param {Object}   [dims]
     */
    invalidateAll: function (namespace, pageURL, dims) {
        CONFIG.cacheableSegments.forEach(function (seg) {
            try {
                var key = buildKey(namespace, seg, pageURL, dims);
                CacheMgr.remove(key);
            } catch (e) { /* best-effort */ }
        });
        Logger.info('SCM INVALIDATED namespace={0}', namespace);
    },

    /**
     * Warm-up: pre-populates cache for all segments using a render function.
     * Call from a SFCC Job after content publish.
     *
     * @param  {string}   namespace
     * @param  {Function} renderFn    - (segment) => content
     * @param  {Object}   [opts]
     * @returns {{ warmed: number, failed: number }}
     */
    warmAll: function (namespace, renderFn, opts) {
        var options = opts || {};
        var warmed  = 0;
        var failed  = 0;

        CONFIG.cacheableSegments.forEach(function (seg) {
            try {
                var content = renderFn(seg);
                SegmentedCacheManager.set(namespace, seg, options.pageURL, content, options);
                warmed++;
            } catch (e) {
                failed++;
                Logger.error('SCM warmAll failed seg={0} ns={1}: {2}', seg, namespace, e.message);
            }
        });

        Logger.info('SCM warm-up namespace={0} warmed={1} failed={2}', namespace, warmed, failed);
        return { warmed: warmed, failed: failed };
    },

    /**
     * Gets or renders — returns cached value or calls renderFn and caches the result.
     *
     * @param  {string}   namespace
     * @param  {string}   segment
     * @param  {Function} renderFn  - () => content
     * @param  {Object}   [opts]
     * @returns {*}  Content
     */
    getOrRender: function (namespace, segment, renderFn, opts) {
        var options = opts || {};
        var cached  = this.get(namespace, segment, options.pageURL, options.dims);

        if (cached && !cached.isFallback) {
            return cached.content;
        }

        var content = renderFn(segment);
        this.set(namespace, segment, options.pageURL, content, options);
        return content;
    },

    CONFIG: CONFIG
};

module.exports = SegmentedCacheManager;
