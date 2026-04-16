/**
 * WebVitalsMonitor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /frontend-performance
 *
 * Measures and reports all Core Web Vitals (LCP, CLS, FID/INP, TTFB, FCP)
 * using the web-vitals library, then sends results to:
 *   - Google Analytics 4 (via gtag)
 *   - A custom SFCC analytics endpoint
 *   - The browser console (development mode)
 *
 * The monitor also decorates each report with SFCC-specific dimensions
 * (page type, locale, currency, A/B test bucket) to enable segmented
 * performance analysis in GA4 or your data warehouse.
 *
 * Usage (load with ScriptLoader at 'normal' or 'high' priority):
 *   ScriptLoader.load('/js/WebVitalsMonitor.js', { priority: 'high' });
 *
 *   <!-- Or include directly before </body> -->
 *   <script src="${URLUtils.staticURL('/js/WebVitalsMonitor.js')}"></script>
 *   <script>
 *     WebVitalsMonitor.init({
 *       pageType : '${pdict.CurrentPageMetaData.pageDesignType}',
 *       locale   : '${pdict.CurrentLocale.id}',
 *       currency : '${session.currency.currencyCode}',
 *       debug    : ${isDevEnvironment}
 *     });
 *   </script>
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function (window) {
    'use strict';

    // ── Thresholds (Google's recommended values) ───────────────────────────────

    var THRESHOLDS = {
        LCP : { good: 2500,  needsImprovement: 4000  },
        FID : { good: 100,   needsImprovement: 300   },
        INP : { good: 200,   needsImprovement: 500   },
        CLS : { good: 0.1,   needsImprovement: 0.25  },
        TTFB: { good: 800,   needsImprovement: 1800  },
        FCP : { good: 1800,  needsImprovement: 3000  }
    };

    // ── Internal state ────────────────────────────────────────────────────────

    var _config  = {};
    var _reports = {};   // Accumulates metric values for batch reporting

    // ── Rating helper ─────────────────────────────────────────────────────────

    /**
     * Returns 'good' | 'needs-improvement' | 'poor' for a metric value.
     * @param  {string} name
     * @param  {number} value
     * @returns {string}
     */
    function getRating(name, value) {
        var t = THRESHOLDS[name];
        if (!t) { return 'unknown'; }
        if (value <= t.good) { return 'good'; }
        if (value <= t.needsImprovement) { return 'needs-improvement'; }
        return 'poor';
    }

    // ── Dimension builder ─────────────────────────────────────────────────────

    /**
     * Builds the SFCC-specific custom dimensions attached to every report.
     * Maps to GA4 custom dimensions configured in your property.
     */
    function buildDimensions() {
        return {
            page_type      : _config.pageType    || 'unknown',
            locale         : _config.locale      || 'unknown',
            currency       : _config.currency    || 'unknown',
            ab_bucket      : _config.abBucket    || 'control',
            customer_type  : _config.customerType || 'guest',
            connection_type: (navigator.connection && navigator.connection.effectiveType) || 'unknown'
        };
    }

    // ── Reporters ─────────────────────────────────────────────────────────────

    /**
     * Sends a metric to Google Analytics 4 via gtag event.
     * Requires GA4 tag to be loaded (can be async — this queues in dataLayer).
     */
    function reportToGA4(metric) {
        var dims = buildDimensions();

        if (typeof window.gtag === 'function') {
            window.gtag('event', metric.name, {
                value                  : Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value),
                metric_id              : metric.id,
                metric_value           : metric.value,
                metric_delta           : metric.delta,
                metric_rating          : getRating(metric.name, metric.value),
                non_interaction        : true,   // Don't affect bounce rate
                page_type              : dims.page_type,
                sfcc_locale            : dims.locale,
                sfcc_currency          : dims.currency,
                sfcc_ab_bucket         : dims.ab_bucket,
                sfcc_customer_type     : dims.customer_type,
                effective_connection   : dims.connection_type
            });
        } else {
            // GA4 not yet loaded — push to dataLayer for GTM
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push({
                event         : 'web_vital',
                vital_name    : metric.name,
                vital_value   : metric.value,
                vital_rating  : getRating(metric.name, metric.value),
                vital_id      : metric.id,
                page_type     : dims.page_type
            });
        }
    }

    /**
     * Sends a metric to a custom SFCC analytics endpoint.
     * Uses navigator.sendBeacon for reliable delivery on page unload.
     */
    function reportToEndpoint(metric) {
        if (!_config.endpoint) { return; }

        var payload = JSON.stringify({
            name    : metric.name,
            value   : metric.value,
            delta   : metric.delta,
            id      : metric.id,
            rating  : getRating(metric.name, metric.value),
            url     : window.location.href,
            ts      : Date.now(),
            dims    : buildDimensions()
        });

        if (navigator.sendBeacon) {
            navigator.sendBeacon(_config.endpoint, new Blob([payload], { type: 'application/json' }));
        } else {
            // Fallback for Safari < 11.1
            var xhr = new XMLHttpRequest();
            xhr.open('POST', _config.endpoint, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(payload);
        }
    }

    /**
     * Console reporter (development / debug mode only).
     */
    function reportToConsole(metric) {
        var rating = getRating(metric.name, metric.value);
        var emoji  = rating === 'good' ? '✅' : rating === 'needs-improvement' ? '⚠️' : '❌';
        var value  = metric.name === 'CLS'
            ? metric.value.toFixed(4)
            : Math.round(metric.value) + ' ms';

        console.group('%c[WebVitals] ' + metric.name + ' ' + emoji, 'font-weight:bold');
        console.log('Value  :', value);
        console.log('Rating :', rating);
        console.log('Delta  :', metric.delta);
        console.log('Dims   :', buildDimensions());
        console.groupEnd();
    }

    // ── Master reporter ───────────────────────────────────────────────────────

    function onMetric(metric) {
        _reports[metric.name] = metric;

        reportToGA4(metric);
        reportToEndpoint(metric);

        if (_config.debug) {
            reportToConsole(metric);
        }
    }

    // ── web-vitals integration ────────────────────────────────────────────────

    /**
     * Loads the web-vitals library from a CDN and attaches all metric observers.
     * We load it at 'low' priority — it should never block critical rendering.
     */
    function loadWebVitals() {
        var SCRIPT_URL = 'https://unpkg.com/web-vitals@3/dist/web-vitals.attribution.iife.js';

        // Already loaded via npm build? Use the global.
        if (window.webVitals) {
            attachObservers(window.webVitals);
            return;
        }

        var script   = document.createElement('script');
        script.src   = SCRIPT_URL;
        script.async = true;
        script.onload = function () {
            if (window.webVitals) {
                attachObservers(window.webVitals);
            }
        };
        document.head.appendChild(script);
    }

    /**
     * Attaches all Core Web Vitals observers.
     * Attribution mode gives us element-level detail for debugging.
     * @param {Object} wv - web-vitals module
     */
    function attachObservers(wv) {
        // Primary CWV
        if (wv.onLCP)  { wv.onLCP(onMetric,  { reportAllChanges: false }); }
        if (wv.onCLS)  { wv.onCLS(onMetric,  { reportAllChanges: false }); }
        if (wv.onINP)  { wv.onINP(onMetric,  { reportAllChanges: false }); }
        if (wv.onFID)  { wv.onFID(onMetric);  }  // Legacy; INP is the successor

        // Diagnostic metrics
        if (wv.onFCP)  { wv.onFCP(onMetric);  }
        if (wv.onTTFB) { wv.onTTFB(onMetric); }

        if (_config.debug) {
            console.log('[WebVitals] Observers attached. Monitoring:', Object.keys(THRESHOLDS).join(', '));
        }
    }

    // ── LCP element annotator ─────────────────────────────────────────────────

    /**
     * Adds a data attribute to the LCP candidate element so you can identify
     * it in DOM snapshots and Lighthouse audits.
     * Call this early — before LCP is finalised.
     */
    function annotateLCPElement() {
        if (!('PerformanceObserver' in window)) { return; }

        try {
            var obs = new PerformanceObserver(function (list) {
                var entries = list.getEntries();
                var last    = entries[entries.length - 1];
                if (last && last.element) {
                    last.element.setAttribute('data-lcp-element', 'true');
                }
            });
            obs.observe({ type: 'largest-contentful-paint', buffered: true });
        } catch (e) { /* unsupported */ }
    }

    // ── CLS debugger ─────────────────────────────────────────────────────────

    /**
     * Logs every layout shift with the offending element.
     * Only active in debug mode — never in production.
     */
    function attachCLSDebugger() {
        if (!_config.debug || !('PerformanceObserver' in window)) { return; }

        try {
            var obs = new PerformanceObserver(function (list) {
                list.getEntries().forEach(function (entry) {
                    if (!entry.hadRecentInput) {
                        entry.sources.forEach(function (src) {
                            if (src.node) {
                                console.warn('[CLS Shift] value=' + entry.value.toFixed(4), src.node);
                                src.node.style.outline = '3px solid red';  // Visual highlight
                            }
                        });
                    }
                });
            });
            obs.observe({ type: 'layout-shift', buffered: true });
        } catch (e) { /* unsupported */ }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    var WebVitalsMonitor = {

        /**
         * Initialises the monitor.
         *
         * @param {Object}  opts
         * @param {string}  opts.pageType     - SFCC page type (homepage|plp|pdp|cart|checkout)
         * @param {string}  opts.locale       - Active SFCC locale (e.g. en_GB)
         * @param {string}  opts.currency     - Active currency code (e.g. GBP)
         * @param {string}  [opts.abBucket]   - A/B test bucket identifier
         * @param {string}  [opts.customerType] - 'guest'|'registered'|'vip'
         * @param {string}  [opts.endpoint]   - Custom beacon endpoint URL
         * @param {boolean} [opts.debug]      - Enable console logging + CLS visual overlay
         */
        init: function (opts) {
            _config = opts || {};

            annotateLCPElement();
            attachCLSDebugger();

            // Load web-vitals after page is interactive
            if (document.readyState === 'complete') {
                loadWebVitals();
            } else {
                window.addEventListener('load', loadWebVitals);
            }
        },

        /**
         * Returns the accumulated metric reports (for in-page dashboards / tests).
         * @returns {Object.<string, Object>}
         */
        getReports: function () { return _reports; },

        /**
         * Manually trigger a report flush (e.g. before SPA route change).
         */
        flush: function () {
            Object.keys(_reports).forEach(function (name) {
                reportToEndpoint(_reports[name]);
            });
        },

        THRESHOLDS: THRESHOLDS
    };

    window.WebVitalsMonitor = WebVitalsMonitor;

}(window));
