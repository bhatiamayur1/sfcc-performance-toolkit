/**
 * RetryHandler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /api-optimization
 *
 * Wraps any SFCC service call or function with configurable retry logic using
 * exponential backoff + jitter. Prevents thundering-herd failures when an
 * upstream API (OCAPI, SCAPI, or 3rd-party) returns transient errors.
 *
 * Retry-eligible status codes (configurable):
 *   429 Too Many Requests, 500 Internal Server Error,
 *   502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout
 *
 * Usage:
 *   var RetryHandler = require('*/cartridge/scripts/perf/RetryHandler');
 *
 *   var result = RetryHandler.wrap(function () {
 *       return myService.call(params);
 *   }, {
 *       maxAttempts : 3,
 *       baseDelayMs : 200,
 *       maxDelayMs  : 2000
 *   });
 *
 *   if (result.ok) {
 *       var data = result.value;
 *   } else {
 *       Logger.error('All retries failed: ' + result.lastError);
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var Logger = require('dw/system/Logger').getLogger('perf', 'RetryHandler');

// ─── Defaults ─────────────────────────────────────────────────────────────────

var DEFAULTS = {
    maxAttempts      : 3,
    baseDelayMs      : 150,    // Initial backoff delay
    maxDelayMs       : 3000,   // Cap on any single delay
    jitterFactor     : 0.3,    // ±30 % random jitter to spread retries
    retryableStatuses: [429, 500, 502, 503, 504],
    retryableErrors  : ['ConnectionRefusedException', 'SocketTimeoutException']
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Calculates the delay for attempt N using exponential backoff + jitter.
 *
 *   delay = min(baseDelay × 2^(attempt-1), maxDelay) × (1 ± jitter)
 *
 * @param  {number} attempt     - Current attempt index (1-based)
 * @param  {number} baseDelayMs
 * @param  {number} maxDelayMs
 * @param  {number} jitter      - Jitter factor (0–1)
 * @returns {number} Delay in milliseconds
 */
function calcDelay(attempt, baseDelayMs, maxDelayMs, jitter) {
    var exponential = baseDelayMs * Math.pow(2, attempt - 1);
    var capped      = Math.min(exponential, maxDelayMs);
    var jitterRange = capped * jitter;
    var jitterDelta = (Math.random() * 2 - 1) * jitterRange; // ± jitterRange
    return Math.round(Math.max(0, capped + jitterDelta));
}

/**
 * Blocking sleep using a spin-loop (SFCC scripts have no async/await).
 * Keep delays short — SFCC script execution has a wall-clock time limit.
 *
 * @param {number} ms
 */
function sleep(ms) {
    var end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
}

/**
 * Determines whether an error/result is worth retrying.
 *
 * @param  {*}      errorOrResult - Caught error or service result
 * @param  {number[]} retryableStatuses
 * @param  {string[]} retryableErrors
 * @returns {boolean}
 */
function isRetryable(errorOrResult, retryableStatuses, retryableErrors) {
    if (!errorOrResult) { return false; }

    // HTTP status code check (e.g. from HTTPClient or ServiceResult)
    var status = errorOrResult.statusCode || errorOrResult.status;
    if (typeof status === 'number' && retryableStatuses.indexOf(status) !== -1) {
        return true;
    }

    // Error type / message check
    var message = (errorOrResult.message || String(errorOrResult));
    return retryableErrors.some(function (e) { return message.indexOf(e) !== -1; });
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Executes `fn` with retry logic.
 *
 * The wrapped function should:
 *   - Return a value on success
 *   - Throw an Error (or return an object with a `statusCode`) on failure
 *
 * @param  {Function} fn      - Function to wrap
 * @param  {Object}   [opts]  - Override any DEFAULTS key
 * @returns {{ ok: boolean, value: *, attempts: number, lastError: string|null }}
 */
function wrap(fn, opts) {
    var cfg = Object.assign({}, DEFAULTS, opts || {});

    var lastError = null;
    var attempts  = 0;

    for (var i = 1; i <= cfg.maxAttempts; i++) {
        attempts++;

        try {
            var result = fn();

            // Some SFCC service wrappers return error-like objects rather than throwing
            if (result && isRetryable(result, cfg.retryableStatuses, cfg.retryableErrors)) {
                throw new Error('Retryable status from service: ' + (result.statusCode || result.status));
            }

            Logger.info('RetryHandler succeeded on attempt {0}/{1}', i, cfg.maxAttempts);
            return { ok: true, value: result, attempts: attempts, lastError: null };

        } catch (err) {
            lastError = err.message || String(err);
            Logger.warn('RetryHandler attempt {0}/{1} failed: {2}', i, cfg.maxAttempts, lastError);

            var shouldRetry = isRetryable(err, cfg.retryableStatuses, cfg.retryableErrors);
            var hasMoreAttempts = i < cfg.maxAttempts;

            if (shouldRetry && hasMoreAttempts) {
                var delay = calcDelay(i, cfg.baseDelayMs, cfg.maxDelayMs, cfg.jitterFactor);
                Logger.info('RetryHandler backing off {0}ms before attempt {1}', delay, i + 1);
                sleep(delay);
            } else if (!shouldRetry) {
                // Non-retryable error — fail fast
                Logger.error('RetryHandler non-retryable error, aborting: {0}', lastError);
                break;
            }
        }
    }

    Logger.error('RetryHandler exhausted all {0} attempts. Last error: {1}', cfg.maxAttempts, lastError);
    return { ok: false, value: null, attempts: attempts, lastError: lastError };
}

/**
 * Convenience: throws if all retries fail rather than returning a result object.
 * Use when you want to propagate errors up to an outer try-catch.
 *
 * @param  {Function} fn
 * @param  {Object}   [opts]
 * @returns {*} The successful return value of fn
 */
function wrapOrThrow(fn, opts) {
    var result = wrap(fn, opts);
    if (!result.ok) {
        throw new Error('[RetryHandler] All retries failed: ' + result.lastError);
    }
    return result.value;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    wrap       : wrap,
    wrapOrThrow: wrapOrThrow,
    calcDelay  : calcDelay,  // exported for unit testing
    DEFAULTS   : DEFAULTS
};
