/**
 * AsyncIntegrationQueue.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /third-party-integration-performance
 *
 * Implements an asynchronous job queue for third-party integration calls that
 * do NOT need to block the customer's request-response cycle.
 *
 * The core insight: most integration calls that happen at order placement
 * do NOT need to complete before we show the customer a confirmation page:
 *
 *   SYNCHRONOUS (must block):          ASYNC (queue it):
 *   ─────────────────────────          ───────────────────
 *   payment.charge()        ✓          oms.createOrder()     → queue
 *   inventory.reserve()     ✓          erp.syncCustomer()    → queue
 *   tax.calculate()         ✓          email.sendConfirm()   → queue (already is)
 *                                      loyalty.addPoints()   → queue
 *                                      fraud.deepScore()     → queue (post-auth)
 *                                      analytics.track()     → queue
 *                                      warehouse.allocate()  → queue
 *
 * Architecture:
 *   Queue entries are persisted in SFCC Custom Objects (durable across restarts).
 *   A SFCC Job processes the queue in configurable batch sizes.
 *   Failed entries are retried with exponential backoff.
 *   Dead-lettered entries (max retries exceeded) are preserved for manual review.
 *
 * Usage (enqueue from a controller):
 *   var Queue = require('*/cartridge/scripts/integrations/AsyncIntegrationQueue');
 *
 *   Queue.enqueue('oms.createOrder', {
 *       orderID    : order.getOrderNo(),
 *       orderToken : order.getOrderToken(),
 *       locale     : request.getLocale()
 *   }, { priority: 'HIGH' });
 *
 * Usage (process queue — SFCC Job step):
 *   module.exports = { execute: Queue.processQueue };
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var Transaction     = require('dw/system/Transaction');
var Logger          = require('dw/system/Logger').getLogger('integrations', 'AsyncQueue');
var Status          = require('dw/system/Status');
var UUIDUtils       = require('dw/util/UUIDUtils');

// ─── Configuration ─────────────────────────────────────────────────────────────

var CONFIG = {
    /** SFCC Custom Object type — define in BM → Custom Object Definitions */
    customObjectType: 'IntegrationQueueEntry',

    /** Maximum retry attempts before dead-lettering */
    maxRetries: 5,

    /** Base delay (ms) for exponential backoff — actual: base × 2^(attempt-1) */
    retryBaseDelayMs: 30000,    // 30 s

    /** Maximum delay cap regardless of attempt number */
    retryMaxDelayMs: 3600000,   // 60 min

    /** Maximum entries to process in a single Job run */
    batchSize: 50,

    /** Priorities */
    PRIORITY: { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 }
};

// ─── Queue entry shape ─────────────────────────────────────────────────────────

/**
 * Custom Object attribute map.
 * Each integration entry has these fields in Business Manager:
 *
 *   jobType     (String)   — integration handler name, e.g. 'oms.createOrder'
 *   payload     (String)   — JSON-serialised call parameters
 *   priority    (Number)   — 0=CRITICAL, 1=HIGH, 2=NORMAL, 3=LOW
 *   status      (String)   — 'PENDING'|'PROCESSING'|'FAILED'|'DEAD_LETTER'
 *   attempts    (Number)   — number of execution attempts
 *   nextRunAt   (Number)   — epoch ms of next allowed run (backoff)
 *   lastError   (String)   — last error message (for dead-letter diagnosis)
 *   createdAt   (Number)   — epoch ms of enqueue time
 *   orderId     (String)   — SFCC order number for traceability
 */

// ─── Backoff calculator ───────────────────────────────────────────────────────

/**
 * Calculates the next-run epoch for a retry attempt using exponential backoff
 * with ±20% jitter to prevent thundering-herd on retry bursts.
 *
 * @param  {number} attempt - 1-based attempt count
 * @returns {number}  Epoch ms when retry should next be allowed
 */
function calcNextRunAt(attempt) {
    var base    = CONFIG.retryBaseDelayMs * Math.pow(2, attempt - 1);
    var capped  = Math.min(base, CONFIG.retryMaxDelayMs);
    var jitter  = capped * 0.2 * (Math.random() * 2 - 1);   // ±20%
    return Date.now() + Math.round(capped + jitter);
}

// ─── Handler registry ─────────────────────────────────────────────────────────

/**
 * Registry of async integration handlers.
 * Keys match the jobType string stored in the queue entry.
 * Each handler receives the parsed payload object and must return { success: bool, error?: string }.
 *
 * Register custom handlers with AsyncIntegrationQueue.registerHandler().
 */
var _handlers = {};

// ─── Public API ───────────────────────────────────────────────────────────────

var AsyncIntegrationQueue = {

    /**
     * Enqueues an integration job for async processing.
     *
     * @param  {string} jobType   - Handler name (e.g. 'oms.createOrder')
     * @param  {Object} payload   - Call parameters (must be JSON-serialisable)
     * @param  {Object} [opts]
     * @param  {string} [opts.priority]  - 'CRITICAL'|'HIGH'|'NORMAL'|'LOW'
     * @param  {string} [opts.orderId]   - SFCC order number for tracing
     * @returns {{ entryId: string, jobType: string, priority: number }}
     */
    enqueue: function (jobType, payload, opts) {
        if (!jobType) { throw new TypeError('AsyncIntegrationQueue.enqueue: jobType is required'); }
        var options  = opts || {};
        var priority = CONFIG.PRIORITY[options.priority] !== undefined
            ? CONFIG.PRIORITY[options.priority]
            : CONFIG.PRIORITY.NORMAL;

        var entryId = UUIDUtils.createUUID();

        try {
            Transaction.wrap(function () {
                var obj = CustomObjectMgr.createCustomObject(CONFIG.customObjectType, entryId);
                obj.custom.jobType   = jobType;
                obj.custom.payload   = JSON.stringify(payload || {});
                obj.custom.priority  = priority;
                obj.custom.status    = 'PENDING';
                obj.custom.attempts  = 0;
                obj.custom.nextRunAt = String(Date.now());  // Eligible immediately
                obj.custom.createdAt = String(Date.now());
                obj.custom.lastError = '';
                obj.custom.orderId   = options.orderId || '';
            });

            Logger.info('AsyncQueue ENQUEUED jobType={0} priority={1} entryId={2} orderId={3}',
                jobType, options.priority || 'NORMAL', entryId, options.orderId || '');
        } catch (e) {
            Logger.error('AsyncQueue.enqueue FAILED jobType={0}: {1}', jobType, e.message);
            throw e;
        }

        return { entryId: entryId, jobType: jobType, priority: priority };
    },

    /**
     * Registers an integration handler function.
     *
     * Handler signature: function(payload) → { success: boolean, error?: string }
     *
     * @param {string}   jobType    - Must match the jobType used in enqueue()
     * @param {Function} handlerFn  - Handler function
     */
    registerHandler: function (jobType, handlerFn) {
        if (typeof handlerFn !== 'function') {
            throw new TypeError('Handler must be a function');
        }
        _handlers[jobType] = handlerFn;
        Logger.info('AsyncQueue: registered handler for jobType={0}', jobType);
    },

    /**
     * SFCC Job entry point — processes queued entries in priority order.
     * Call from a SFCC Job configured on a cron (e.g. every 2 minutes).
     *
     * @returns {dw.system.Status}
     */
    processQueue: function () {
        var stats = { processed: 0, succeeded: 0, failed: 0, deadLettered: 0, skipped: 0 };
        var now   = Date.now();

        // Query PENDING entries ordered by priority then createdAt
        var entries = CustomObjectMgr.queryCustomObjects(
            CONFIG.customObjectType,
            'custom.status = {0} OR custom.status = {1}',
            'custom.priority asc, custom.createdAt asc',
            'PENDING', 'FAILED'
        );

        while (entries.hasNext() && stats.processed < CONFIG.batchSize) {
            var obj     = entries.next();
            var entryId = obj.getCustomAttribute('objectID') || obj.UUID;

            // Skip entries not yet due for retry
            var nextRunAt = parseInt(obj.custom.nextRunAt, 10) || 0;
            if (nextRunAt > now) {
                stats.skipped++;
                continue;
            }

            stats.processed++;
            var jobType = String(obj.custom.jobType || '');
            var handler = _handlers[jobType];

            if (!handler) {
                Logger.error('AsyncQueue: no handler for jobType={0} entryId={1}', jobType, entryId);
                try {
                    Transaction.wrap(function () {
                        obj.custom.status    = 'DEAD_LETTER';
                        obj.custom.lastError = 'No handler registered for jobType: ' + jobType;
                    });
                } catch (e) { /* best-effort */ }
                stats.deadLettered++;
                continue;
            }

            // Mark PROCESSING
            try {
                Transaction.wrap(function () { obj.custom.status = 'PROCESSING'; });
            } catch (e) { stats.skipped++; continue; }

            var payload;
            try { payload = JSON.parse(String(obj.custom.payload || '{}')); }
            catch (e) { payload = {}; }

            var attempts = parseInt(obj.custom.attempts, 10) || 0;

            try {
                var handlerResult = handler(payload);
                var succeeded     = handlerResult && handlerResult.success !== false;

                if (succeeded) {
                    // Remove successfully processed entry
                    Transaction.wrap(function () {
                        CustomObjectMgr.remove(obj);
                    });
                    stats.succeeded++;
                    Logger.info('AsyncQueue SUCCESS jobType={0} orderId={1} attempt={2}',
                        jobType, obj.custom.orderId, attempts + 1);
                } else {
                    throw new Error(handlerResult.error || 'Handler returned success=false');
                }

            } catch (handlerErr) {
                attempts++;
                stats.failed++;

                if (attempts >= CONFIG.maxRetries) {
                    // Dead-letter
                    try {
                        Transaction.wrap(function () {
                            obj.custom.status    = 'DEAD_LETTER';
                            obj.custom.attempts  = attempts;
                            obj.custom.lastError = handlerErr.message.slice(0, 500);
                        });
                    } catch (e) { /* best-effort */ }
                    stats.deadLettered++;
                    Logger.error('AsyncQueue DEAD_LETTER jobType={0} orderId={1} after {2} attempts: {3}',
                        jobType, obj.custom.orderId, attempts, handlerErr.message);
                } else {
                    // Schedule retry with backoff
                    var nextRun = calcNextRunAt(attempts);
                    try {
                        Transaction.wrap(function () {
                            obj.custom.status    = 'FAILED';
                            obj.custom.attempts  = attempts;
                            obj.custom.lastError = handlerErr.message.slice(0, 500);
                            obj.custom.nextRunAt = String(nextRun);
                        });
                    } catch (e) { /* best-effort */ }

                    var retryIn = Math.round((nextRun - now) / 1000);
                    Logger.warn('AsyncQueue RETRY jobType={0} orderId={1} attempt={2}/{3} in {4}s: {5}',
                        jobType, obj.custom.orderId, attempts, CONFIG.maxRetries, retryIn, handlerErr.message);
                }
            }
        }

        entries.close();

        Logger.info('AsyncQueue.processQueue complete: processed={0} succeeded={1} failed={2} deadLettered={3} skipped={4}',
            stats.processed, stats.succeeded, stats.failed, stats.deadLettered, stats.skipped);

        if (stats.deadLettered > 0) {
            return new Status(Status.OK, 'QUEUE_PROCESSED_WITH_DLQ',
                'Queue processed. ' + stats.deadLettered + ' entries dead-lettered — manual review required.');
        }

        return new Status(Status.OK, 'QUEUE_PROCESSED',
            'Queue processed: ' + stats.succeeded + '/' + stats.processed + ' succeeded.');
    },

    /**
     * Returns queue depth statistics for monitoring dashboards.
     * @returns {{ pending: number, failed: number, deadLetter: number, total: number }}
     */
    getStats: function () {
        try {
            var pending    = CustomObjectMgr.queryCustomObjects(CONFIG.customObjectType, 'custom.status = {0}', null, 'PENDING').count;
            var failed     = CustomObjectMgr.queryCustomObjects(CONFIG.customObjectType, 'custom.status = {0}', null, 'FAILED').count;
            var deadLetter = CustomObjectMgr.queryCustomObjects(CONFIG.customObjectType, 'custom.status = {0}', null, 'DEAD_LETTER').count;
            return { pending: pending, failed: failed, deadLetter: deadLetter, total: pending + failed + deadLetter };
        } catch (e) {
            Logger.warn('AsyncQueue.getStats failed: {0}', e.message);
            return { pending: -1, failed: -1, deadLetter: -1, total: -1 };
        }
    },

    CONFIG: CONFIG
};

module.exports = AsyncIntegrationQueue;
