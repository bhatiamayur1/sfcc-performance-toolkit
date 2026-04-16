/**
 * CheckoutBottleneckProfiler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /checkout-optimization
 *
 * Instruments every checkout stage with precise timing spans so you can
 * identify where milliseconds are lost in your specific storefront
 * configuration.
 *
 * Measured spans (server-side):
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  Stage          │ Span                   │ Typical (ms) │
 *   ├─────────────────┼────────────────────────┼──────────────┤
 *   │  Cart → Address │ basket.validate()       │  40 – 120   │
 *   │                 │ promotions.evaluate()   │  20 – 200   │
 *   │                 │ tax.calculate()         │  30 – 400   │
 *   │  Address        │ address.validate()      │   5 – 40    │
 *   │                 │ geolocation.lookup()    │  50 – 300   │
 *   │  Shipping       │ methods.query()         │  30 – 150   │
 *   │                 │ rates.calculate()       │  20 – 800   │
 *   │  Payment        │ gateway.preAuth()       │ 200 – 1800  │
 *   │                 │ fraud.score()           │  50 – 400   │
 *   │  Place Order    │ inventory.reserve()     │  30 – 500   │
 *   │                 │ gateway.charge()        │ 300 – 2000  │
 *   │                 │ order.create()          │  20 – 150   │
 *   │                 │ email.send()            │  50 – 500   │
 *   └─────────────────┴────────────────────────┴──────────────┘
 *
 * Usage (in each SFCC Controller action):
 *   var Profiler = require('*/cartridge/scripts/checkout/CheckoutBottleneckProfiler');
 *   var trace    = Profiler.start('PlaceOrder');
 *
 *   var t1 = trace.span('inventory.reserve');
 *   inventoryService.call(params);
 *   t1.end();
 *
 *   var t2 = trace.span('gateway.charge');
 *   paymentGateway.charge(params);
 *   t2.end();
 *
 *   trace.finish();  // Logs full breakdown + flags slow spans
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var Logger = require('dw/system/Logger').getLogger('checkout', 'CheckoutBottleneckProfiler');

// ─── Slow span thresholds ─────────────────────────────────────────────────────

/**
 * Per-operation thresholds in milliseconds.
 * Spans that exceed WARN are logged at WARN level.
 * Spans that exceed CRITICAL are logged at ERROR level and emit a custom
 * object for alerting dashboards.
 */
var THRESHOLDS = {
    // Cart / basket
    'basket.validate'      : { warn: 100,  critical: 300  },
    'promotions.evaluate'  : { warn: 150,  critical: 400  },
    'tax.calculate'        : { warn: 200,  critical: 600  },

    // Address
    'address.validate'     : { warn: 50,   critical: 150  },
    'geolocation.lookup'   : { warn: 150,  critical: 400  },

    // Shipping
    'methods.query'        : { warn: 80,   critical: 250  },
    'rates.calculate'      : { warn: 300,  critical: 800  },

    // Payment
    'gateway.preAuth'      : { warn: 800,  critical: 1800 },
    'fraud.score'          : { warn: 200,  critical: 600  },

    // Place order
    'inventory.reserve'    : { warn: 150,  critical: 500  },
    'gateway.charge'       : { warn: 1000, critical: 2500 },
    'order.create'         : { warn: 100,  critical: 300  },
    'email.send'           : { warn: 200,  critical: 800  },

    // Generic fallback
    _default               : { warn: 200,  critical: 500  }
};

// ─── Trace ────────────────────────────────────────────────────────────────────

/**
 * A single checkout trace — one per controller action invocation.
 * @param {string} stageName  - e.g. 'PlaceOrder', 'SubmitShipping'
 */
function Trace(stageName) {
    this.stage    = stageName;
    this.startMs  = Date.now();
    this.spans    = [];
    this._open    = null;  // Currently-running span
}

/**
 * Opens a named timing span.
 * Returns a handle with an end() method.
 *
 * @param  {string} name  - Operation name (e.g. 'gateway.charge')
 * @returns {{ end: Function, name: string }}
 */
Trace.prototype.span = function (name) {
    var self     = this;
    var startMs  = Date.now();
    var spanName = name;

    var handle = {
        name: spanName,

        /**
         * Closes the span and records the duration.
         * @param {Object} [meta]  - Optional metadata to attach (status codes, IDs, etc.)
         */
        end: function (meta) {
            var durationMs = Date.now() - startMs;
            var threshold  = THRESHOLDS[spanName] || THRESHOLDS._default;
            var severity   = durationMs >= threshold.critical ? 'critical'
                           : durationMs >= threshold.warn     ? 'warn'
                           : 'ok';

            var record = {
                name      : spanName,
                durationMs: durationMs,
                severity  : severity,
                meta      : meta || null
            };

            self.spans.push(record);

            // Immediate log for critical spans — don't wait for trace.finish()
            if (severity === 'critical') {
                Logger.error('CHECKOUT BOTTLENECK stage={0} span={1} duration={2}ms CRITICAL threshold={3}ms',
                    self.stage, spanName, durationMs, threshold.critical);
            } else if (severity === 'warn') {
                Logger.warn('CHECKOUT SLOW span={0} duration={1}ms (warn>{2}ms)',
                    spanName, durationMs, threshold.warn);
            }

            return record;
        }
    };

    return handle;
};

/**
 * Wraps a synchronous function call in a timing span automatically.
 *
 * @param  {string}   name   - Span name
 * @param  {Function} fn     - Function to time
 * @param  {Object}   [meta] - Optional metadata
 * @returns {*}  Return value of fn
 */
Trace.prototype.timed = function (name, fn, meta) {
    var span   = this.span(name);
    var result;
    var error;

    try {
        result = fn();
    } catch (e) {
        error = e;
    } finally {
        span.end(meta);
    }

    if (error) { throw error; }
    return result;
};

/**
 * Finishes the trace, logs the full breakdown, and returns a summary object.
 *
 * @returns {{
 *   stage       : string,
 *   totalMs     : number,
 *   spans       : Object[],
 *   bottlenecks : Object[],
 *   score       : 'fast'|'moderate'|'slow'|'critical'
 * }}
 */
Trace.prototype.finish = function () {
    var totalMs     = Date.now() - this.startMs;
    var bottlenecks = this.spans.filter(function (s) { return s.severity !== 'ok'; });

    // Overall score
    var hasCritical = bottlenecks.some(function (s) { return s.severity === 'critical'; });
    var hasWarn     = bottlenecks.some(function (s) { return s.severity === 'warn'; });
    var score = hasCritical ? 'critical'
              : hasWarn     ? 'slow'
              : totalMs > 500 ? 'moderate'
              : 'fast';

    // Build span breakdown string for log
    var breakdown = this.spans.map(function (s) {
        var flag = s.severity === 'critical' ? ' !!CRITICAL!!'
                 : s.severity === 'warn'     ? ' !SLOW!'
                 : '';
        return s.name + '=' + s.durationMs + 'ms' + flag;
    }).join(' | ');

    var logMsg = 'CHECKOUT TRACE stage={0} total={1}ms score={2} spans=[{3}]';

    if (score === 'critical' || score === 'slow') {
        Logger.warn(logMsg, this.stage, totalMs, score, breakdown);
    } else {
        Logger.info(logMsg, this.stage, totalMs, score, breakdown);
    }

    return {
        stage      : this.stage,
        totalMs    : totalMs,
        spans      : this.spans,
        bottlenecks: bottlenecks,
        score      : score
    };
};

// ─── Public API ───────────────────────────────────────────────────────────────

var CheckoutBottleneckProfiler = {

    /**
     * Starts a new trace for a checkout stage.
     *
     * @param  {string} stageName
     * @returns {Trace}
     */
    start: function (stageName) {
        return new Trace(stageName);
    },

    /**
     * Generates a bottleneck report from an array of trace summaries.
     * Useful for aggregating profiling data in a batch job or admin view.
     *
     * @param  {Object[]} traces  - Array of trace.finish() results
     * @returns {Object}  Aggregated report
     */
    report: function (traces) {
        var spanAgg = {};  // span name → { totalMs, count, criticalCount, warnCount }

        traces.forEach(function (trace) {
            (trace.spans || []).forEach(function (span) {
                if (!spanAgg[span.name]) {
                    spanAgg[span.name] = { totalMs: 0, count: 0, criticalCount: 0, warnCount: 0 };
                }
                var agg = spanAgg[span.name];
                agg.totalMs      += span.durationMs;
                agg.count++;
                if (span.severity === 'critical') { agg.criticalCount++; }
                if (span.severity === 'warn')     { agg.warnCount++; }
            });
        });

        var summary = Object.keys(spanAgg).map(function (name) {
            var agg = spanAgg[name];
            return {
                name            : name,
                avgMs           : Math.round(agg.totalMs / agg.count),
                count           : agg.count,
                criticalPct     : Math.round(agg.criticalCount / agg.count * 100),
                warnPct         : Math.round(agg.warnCount / agg.count * 100),
                threshold       : THRESHOLDS[name] || THRESHOLDS._default
            };
        }).sort(function (a, b) { return b.avgMs - a.avgMs; });

        return {
            topBottlenecks: summary.slice(0, 5),
            allSpans      : summary,
            traceCount    : traces.length
        };
    },

    THRESHOLDS: THRESHOLDS
};

module.exports = CheckoutBottleneckProfiler;
