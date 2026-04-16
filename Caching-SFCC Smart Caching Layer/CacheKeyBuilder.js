/**
 * CacheKeyBuilder.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /caching
 *
 * Builds deterministic, collision-free cache keys for SFCC pages and partials.
 * Supports personalisation segments, A/B test buckets, geolocation, and custom
 * dimensions — without blowing up the cache keyspace.
 *
 * Usage (SFCC Controller / Script):
 *   var CacheKeyBuilder = require('*/cartridge/scripts/perf/CacheKeyBuilder');
 *
 *   var key = CacheKeyBuilder.for('ProductTile')
 *       .withLocale()
 *       .withCurrency()
 *       .withParam('pid')
 *       .withCustomerGroup()
 *       .build();
 *
 *   response.setExpires(600);          // 10-min TTL
 *   CacheMgr.applyDefaultCache(key);   // pass to SFCC CacheMgr
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var Site    = require('dw/system/Site');
var Request = require('dw/system/Request');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of custom dimensions to prevent runaway keyspace growth. */
var MAX_CUSTOM_DIMENSIONS = 8;

/** Separator used between key segments — must be URL-safe. */
var SEG_SEP = '|';

// ─── Builder Class ────────────────────────────────────────────────────────────

/**
 * @class CacheKey
 * @param {string} namespace  - Logical name for the cacheable unit (e.g. 'ProductTile')
 */
function CacheKey(namespace) {
    if (!namespace || typeof namespace !== 'string') {
        throw new TypeError('[CacheKeyBuilder] namespace must be a non-empty string');
    }

    this._namespace  = namespace;
    this._segments   = [];
    this._customDims = 0;
}

// ─── Core dimension helpers ───────────────────────────────────────────────────

/**
 * Appends the current SFCC locale (e.g. en_US).
 * Almost always required — different locales must never share a cache entry.
 */
CacheKey.prototype.withLocale = function () {
    var locale = Request.getLocale() || Site.getCurrent().getDefaultLocale();
    this._segments.push('locale=' + locale);
    return this;
};

/**
 * Appends the active currency code (e.g. GBP).
 * Required whenever prices appear in the cached fragment.
 */
CacheKey.prototype.withCurrency = function () {
    var currency = session.getCurrency().getCurrencyCode();
    this._segments.push('cur=' + currency);
    return this;
};

/**
 * Appends a specific HTTP query-parameter value.
 * @param {string} paramName - Query parameter name
 */
CacheKey.prototype.withParam = function (paramName) {
    var val = request.httpParameterMap[paramName]
        ? request.httpParameterMap[paramName].stringValue
        : 'null';
    this._segments.push(paramName + '=' + encodeURIComponent(val));
    return this;
};

/**
 * Appends the current customer group ID.
 * Required for pages with group-specific pricing or promotions.
 */
CacheKey.prototype.withCustomerGroup = function () {
    var groups = customer.getCustomerGroups().toArray()
        .map(function (g) { return g.getID(); })
        .sort()  // sort for determinism
        .join(',');
    this._segments.push('cg=' + groups);
    return this;
};

/**
 * Appends the storefront Site ID.
 * Useful in multi-site setups sharing the same cartridge.
 */
CacheKey.prototype.withSite = function () {
    this._segments.push('site=' + Site.getCurrent().getID());
    return this;
};

/**
 * Appends an A/B test bucket identifier.
 * @param {string} testID    - Test identifier
 * @param {string} bucketID  - Bucket/variant identifier
 */
CacheKey.prototype.withABBucket = function (testID, bucketID) {
    this._segments.push('ab=' + testID + ':' + bucketID);
    return this;
};

/**
 * Appends a device-class segment (desktop | tablet | mobile).
 * Use when layouts differ significantly across device types.
 */
CacheKey.prototype.withDeviceClass = function () {
    var ua = request.getHttpHeaders().get('user-agent') || '';
    var device = /mobile/i.test(ua) ? 'mobile'
               : /tablet/i.test(ua) ? 'tablet'
               : 'desktop';
    this._segments.push('dev=' + device);
    return this;
};

// ─── Custom dimension ─────────────────────────────────────────────────────────

/**
 * Appends an arbitrary key=value dimension.
 * Capped at MAX_CUSTOM_DIMENSIONS to protect keyspace size.
 *
 * @param {string} key   - Dimension name
 * @param {string} value - Dimension value
 */
CacheKey.prototype.withDimension = function (key, value) {
    if (this._customDims >= MAX_CUSTOM_DIMENSIONS) {
        throw new RangeError(
            '[CacheKeyBuilder] Exceeded maximum custom dimensions (' +
            MAX_CUSTOM_DIMENSIONS + '). Consolidate dimensions or increase MAX_CUSTOM_DIMENSIONS.'
        );
    }
    this._segments.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    this._customDims++;
    return this;
};

// ─── Build ────────────────────────────────────────────────────────────────────

/**
 * Assembles and returns the final cache-key string.
 * Format: <namespace>|<seg1>|<seg2>|...
 *
 * @returns {string}
 */
CacheKey.prototype.build = function () {
    var parts = [this._namespace].concat(this._segments);
    return parts.join(SEG_SEP);
};

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Factory entry-point.
 * @param  {string} namespace
 * @returns {CacheKey}
 */
function forNamespace(namespace) {
    return new CacheKey(namespace);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    for: forNamespace,

    /**
     * Convenience: build a simple page-level key from the current URL path.
     * Includes locale and site by default.
     *
     * @returns {string}
     */
    pageKey: function () {
        var path = request.getHttpPath() || '/';
        return forNamespace('page')
            .withSite()
            .withLocale()
            .withCurrency()
            .withDimension('path', path)
            .build();
    }
};
