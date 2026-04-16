/**
 * RequestBatcher.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /api-optimization
 *
 * Batches multiple OCAPI / SCAPI requests into the fewest possible HTTP calls
 * using OCAPI's bulk-endpoint patterns and SCAPI composite requests.
 *
 * Problem:
 *   A typical SFCC category page may render 48 product tiles. Fetching each
 *   product individually creates 48 sequential HTTP requests — killing TTFB.
 *   This utility chunks IDs into configurable batch sizes and executes them
 *   in controlled parallel waves.
 *
 * Usage:
 *   var RequestBatcher = require('*/cartridge/scripts/perf/RequestBatcher');
 *
 *   RequestBatcher.products(['P001','P002',...,'P048'], { batchSize: 24 })
 *       .then(function (products) { res.json(products); })
 *       .catch(function (err) { /* handle */ });
 *
 * Requires:
 *   - SFCC OCAPI Shop API enabled (product/batch resource)
 *   - A valid client-credential token (see TokenCache.js)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var HTTPClient = require('dw/net/HTTPClient');
var Logger     = require('dw/system/Logger').getLogger('perf', 'RequestBatcher');
var Site       = require('dw/system/Site');

// ─── Configuration ────────────────────────────────────────────────────────────

var DEFAULTS = {
    batchSize    : 24,     // IDs per OCAPI call (OCAPI max is typically 25)
    maxConcurrent: 2,      // Parallel batch waves (SFCC thread pool aware)
    timeoutMs    : 5000,   // Per-request timeout
    expand       : 'images,prices,availability'  // OCAPI expand parameter
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Chunks an array into sub-arrays of at most `size` elements.
 *
 * @param  {Array}  arr
 * @param  {number} size
 * @returns {Array[]}
 */
function chunk(arr, size) {
    var chunks = [];
    for (var i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

/**
 * Builds the OCAPI product batch URL.
 *
 * @param  {string[]} ids
 * @param  {string}   expand
 * @returns {string}
 */
function buildProductBatchURL(ids, expand) {
    var siteID = Site.getCurrent().getID();
    var base   = '/s/' + siteID + '/dw/shop/v23_2/products/(' + ids.join(',') + ')';
    return base + '?expand=' + encodeURIComponent(expand) + '&all_images=false';
}

/**
 * Executes a single synchronous OCAPI GET request.
 * Returns parsed JSON or throws on HTTP error.
 *
 * @param  {string} url
 * @param  {string} token     - Bearer token
 * @param  {number} timeoutMs
 * @returns {Object}
 */
function ocapiGet(url, token, timeoutMs) {
    var http = new HTTPClient();
    http.setTimeout(timeoutMs);
    http.setRequestHeader('Authorization', 'Bearer ' + token);
    http.setRequestHeader('Content-Type', 'application/json');

    var ok = http.sendAndReceive(url, 'GET');

    if (!ok || http.getStatusCode() !== 200) {
        throw new Error(
            'OCAPI request failed: ' + http.getStatusCode() + ' ' + url
        );
    }

    var body = http.getText();
    return JSON.parse(body);
}

/**
 * Processes an array of ID batches sequentially in waves of `maxConcurrent`.
 * SFCC scripts are single-threaded — "concurrency" here means we minimise
 * total wall-clock time by dequeueing the next batch as soon as one finishes.
 *
 * @param  {string[][]} batches
 * @param  {Function}   fetchFn   - Function(batch) → result
 * @param  {number}     maxWave
 * @returns {Array} Flattened results
 */
function processInWaves(batches, fetchFn, maxWave) {
    var results = [];
    var wave    = maxWave || 2;

    for (var i = 0; i < batches.length; i += wave) {
        var waveBatches = batches.slice(i, i + wave);
        var waveResults = waveBatches.map(function (batch) {
            return fetchFn(batch);
        });
        // Flatten wave results into master array
        waveResults.forEach(function (r) {
            if (r && Array.isArray(r.data)) {
                results = results.concat(r.data);
            }
        });
    }
    return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

var RequestBatcher = {

    /**
     * Fetches multiple products via OCAPI batch endpoint.
     *
     * @param  {string[]} productIDs  - Array of SFCC product IDs
     * @param  {Object}   [opts]      - Overrides for DEFAULTS
     * @param  {string}   token       - Valid OCAPI Bearer token
     * @returns {{ products: Object[], errors: Object[] }}
     */
    products: function (productIDs, opts, token) {
        if (!Array.isArray(productIDs) || productIDs.length === 0) {
            return { products: [], errors: [] };
        }

        var cfg      = Object.assign({}, DEFAULTS, opts || {});
        var batches  = chunk(productIDs, cfg.batchSize);
        var errors   = [];

        Logger.info('RequestBatcher.products ids={0} batches={1} batchSize={2}',
            productIDs.length, batches.length, cfg.batchSize);

        var products = processInWaves(batches, function (batch) {
            try {
                var url = buildProductBatchURL(batch, cfg.expand);
                return ocapiGet(url, token, cfg.timeoutMs);
            } catch (e) {
                Logger.error('Batch fetch failed for ids=[{0}]: {1}', batch.join(','), e.message);
                errors.push({ ids: batch, error: e.message });
                return { data: [] };
            }
        }, cfg.maxConcurrent);

        return { products: products, errors: errors };
    },

    /**
     * Generic batch fetcher for any OCAPI resource that accepts comma-separated
     * IDs in the URL path (categories, content assets, etc.)
     *
     * @param  {string[]} ids        - Resource IDs to fetch
     * @param  {Function} urlBuilder - Function(ids[]) → URL string
     * @param  {Object}   [opts]     - Overrides for DEFAULTS
     * @param  {string}   token      - Valid OCAPI Bearer token
     * @returns {{ data: Object[], errors: Object[] }}
     */
    batch: function (ids, urlBuilder, opts, token) {
        if (!Array.isArray(ids) || ids.length === 0) {
            return { data: [], errors: [] };
        }

        var cfg     = Object.assign({}, DEFAULTS, opts || {});
        var batches = chunk(ids, cfg.batchSize);
        var errors  = [];

        var data = processInWaves(batches, function (batch) {
            try {
                var url = urlBuilder(batch);
                return ocapiGet(url, token, cfg.timeoutMs);
            } catch (e) {
                Logger.error('Generic batch failed ids=[{0}]: {1}', batch.join(','), e.message);
                errors.push({ ids: batch, error: e.message });
                return { data: [] };
            }
        }, cfg.maxConcurrent);

        return { data: data, errors: errors };
    },

    /** Expose defaults for external override / testing */
    DEFAULTS: DEFAULTS
};

module.exports = RequestBatcher;
