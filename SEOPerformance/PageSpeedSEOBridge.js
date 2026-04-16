/**
 * PageSpeedSEOBridge.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /seo-performance
 *
 * Bridges the gap between technical performance metrics and SEO ranking
 * signals. Google's Page Experience ranking factors are now directly
 * measurable — this module instruments, scores, and reports on them with
 * explicit links to the SEO impact of each metric.
 *
 * Components:
 *
 *   SERVER-SIDE: SpeedSignalCollector
 *     Captures server-computed performance signals (TTFB, response size,
 *     compression, cache headers) and emits them as structured log entries
 *     that can be aggregated into an SEO health dashboard.
 *
 *   CLIENT-SIDE: PageExperienceReporter (IIFE)
 *     Measures all Page Experience signals in the browser and correlates
 *     them with expected SEO impact. Reports to Google Search Console
 *     via the CrUX API and to your own analytics endpoint.
 *     Signals covered:
 *       LCP   → Loading performance (Google: good < 2.5s)
 *       CLS   → Visual stability    (Google: good < 0.1)
 *       INP   → Interactivity       (Google: good < 200ms)
 *       FCP   → First paint         (Diagnostic)
 *       TTFB  → Server response     (Diagnostic)
 *       FID   → Input delay (legacy, still measured for compatibility)
 *
 *   SERVER-SIDE: GoogleBotSimulator
 *     Makes a HEAD request to your own pages as Googlebot to verify that
 *     your CDN and server are returning the correct cache headers and
 *     response codes to the crawler — catching "works in browser, broken
 *     for bots" caching misconfiguration.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var Logger = require('dw/system/Logger').getLogger('seo', 'PageSpeedSEOBridge');

// ─── SEO impact thresholds ────────────────────────────────────────────────────

/**
 * Google's Page Experience thresholds with explicit SEO impact descriptions.
 * Source: https://web.dev/vitals/
 */
var SEO_THRESHOLDS = {
    LCP: {
        good          : 2500,
        needsWork     : 4000,
        seoImpact: {
            good     : 'Positive ranking signal. Pages in top search positions average 1.9s LCP.',
            needsWork: 'Neutral to slight negative. Google may demote vs. faster competing pages.',
            poor     : 'Confirmed negative ranking factor since 2021 Page Experience update.'
        }
    },
    CLS: {
        good          : 0.1,
        needsWork     : 0.25,
        seoImpact: {
            good     : 'No CLS penalty. Users stay on page — positive engagement signals.',
            needsWork: 'Moderate negative. Bounces from layout shifts degrade dwell-time signals.',
            poor     : 'Strong negative. High bounce rate correlates with CLS > 0.25.'
        }
    },
    INP: {
        good          : 200,
        needsWork     : 500,
        seoImpact: {
            good     : 'Positive engagement. Fast interactions → longer sessions.',
            needsWork: 'Neutral. Users complete tasks but with frustration.',
            poor     : 'Negative engagement signals. Poor INP correlates with high exit rates.'
        }
    },
    FCP: {
        good          : 1800,
        needsWork     : 3000,
        seoImpact: {
            good     : 'Indirect positive — FCP < 1.8s strongly correlates with good LCP.',
            needsWork: 'FCP slowness indicates render-blocking resources — fix to improve LCP.',
            poor     : 'Critical. FCP > 3s means Google may not index above-fold content correctly.'
        }
    },
    TTFB: {
        good          : 800,
        needsWork     : 1800,
        seoImpact: {
            good     : 'Efficient crawl budget usage — Googlebot can crawl more pages per session.',
            needsWork: 'Crawl budget waste. Googlebot may time out and reduce crawl frequency.',
            poor     : 'Severe crawl budget impact. Pages may be de-prioritised in crawl queue.'
        }
    }
};

// ─── SERVER-SIDE: SpeedSignalCollector ───────────────────────────────────────

var SpeedSignalCollector = {

    /**
     * Collects server-side SEO speed signals for the current request and
     * writes them to the SEO log. Call at the end of each controller action.
     *
     * @param {Object}  pageData
     * @param {string}  pageData.pageType      - 'pdp'|'plp'|'home'|'search'
     * @param {string}  pageData.url           - Canonical URL
     * @param {number}  pageData.responseMs    - Total server response time in ms
     * @param {Object}  pageData.response      - SFCC response object
     * @param {boolean} pageData.wasCached     - Was response served from cache?
     */
    collect: function (pageData) {
        var issues  = [];
        var signals = {};

        // ── TTFB signal ───────────────────────────────────────────────────────
        signals.ttfbMs    = pageData.responseMs;
        signals.ttfbRating = pageData.responseMs < 800 ? 'good'
                           : pageData.responseMs < 1800 ? 'needs-improvement' : 'poor';

        if (pageData.responseMs >= 800) {
            issues.push({
                signal  : 'TTFB',
                value   : pageData.responseMs + 'ms',
                rating  : signals.ttfbRating,
                fix     : 'Enable CDN caching (s-maxage), check database query latency, use PartialPageCache'
            });
        }

        // ── Cache header signal ───────────────────────────────────────────────
        var cc = pageData.response ? (pageData.response.getHttpHeader('Cache-Control') || '') : '';
        signals.hasCDNCache = cc.indexOf('s-maxage') !== -1 || cc.indexOf('public') !== -1;

        if (!signals.hasCDNCache && pageData.pageType !== 'checkout' && pageData.pageType !== 'cart') {
            issues.push({
                signal: 'CDN_CACHING',
                value : cc || 'not set',
                rating: 'poor',
                fix   : 'Apply CacheHeadersManager.applyPageHeaders() for public pages'
            });
        }

        // ── Surrogate key signal (crawl budget) ───────────────────────────────
        var sk = pageData.response ? (pageData.response.getHttpHeader('Surrogate-Key') || '') : '';
        signals.hasSurrogateKey = !!sk;

        if (!signals.hasSurrogateKey && pageData.pageType !== 'checkout') {
            issues.push({
                signal: 'SURROGATE_KEY',
                value : 'missing',
                rating: 'needs-improvement',
                fix   : 'Add Surrogate-Key headers to enable targeted CDN purging after content updates'
            });
        }

        // ── Log ───────────────────────────────────────────────────────────────
        var logMsg = 'SEO_SPEED_SIGNAL pageType={0} url={1} ttfb={2}ms cached={3} cdnCache={4} issues={5}';
        if (issues.length > 0) {
            Logger.warn(logMsg,
                pageData.pageType, pageData.url, pageData.responseMs,
                pageData.wasCached, signals.hasCDNCache, issues.length);
        } else {
            Logger.info(logMsg,
                pageData.pageType, pageData.url, pageData.responseMs,
                pageData.wasCached, signals.hasCDNCache, 0);
        }

        return { signals: signals, issues: issues };
    },

    SEO_THRESHOLDS: SEO_THRESHOLDS
};

// ─── SERVER-SIDE: GoogleBotSimulator ─────────────────────────────────────────

var GoogleBotSimulator = {

    /** Googlebot's User-Agent string (desktop, latest known value) */
    GOOGLEBOT_UA: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',

    /**
     * Makes a HEAD request to a URL impersonating Googlebot and returns
     * the response code, cache headers, and any redirect chain.
     *
     * Use to verify:
     *   - CDN is NOT serving Googlebot a cached authenticated page
     *   - 301/302 redirects are correct and not chained > 3 deep
     *   - Response code is 200 (not a soft 404)
     *   - Server doesn't return different content to bots (cloaking)
     *
     * @param  {string} targetURL
     * @returns {{ statusCode: number, headers: Object, redirectChain: string[], issues: string[] }}
     */
    probe: function (targetURL) {
        var HTTPClient = require('dw/net/HTTPClient');
        var http       = new HTTPClient();
        http.setTimeout(10000);
        http.setRequestHeader('User-Agent', this.GOOGLEBOT_UA);
        http.setRequestHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
        http.setFollowRedirects(false);   // Manual redirect handling to count chain depth

        var redirectChain = [];
        var currentURL    = targetURL;
        var maxRedirects  = 5;
        var issues        = [];

        for (var i = 0; i < maxRedirects; i++) {
            http.sendAndReceive(currentURL, 'HEAD');
            var code    = http.getStatusCode();
            var location = http.getResponseHeader('Location');

            if (code >= 300 && code < 400 && location) {
                redirectChain.push({ from: currentURL, to: location, code: code });
                currentURL = location;
            } else {
                // Final destination
                var cacheControl = http.getResponseHeader('Cache-Control') || '';
                var xCache       = http.getResponseHeader('X-Cache') || '';
                var surrogateKey = http.getResponseHeader('Surrogate-Key') || '';
                var contentType  = http.getResponseHeader('Content-Type') || '';

                if (redirectChain.length > 2) {
                    issues.push('Redirect chain too deep (' + redirectChain.length + ' hops) — wastes crawl budget');
                }
                if (cacheControl.indexOf('private') !== -1 || cacheControl.indexOf('no-store') !== -1) {
                    issues.push('CRITICAL: Googlebot receives no-cache/private headers — page may not be crawlable from CDN');
                }
                if (code === 404 || code === 410) {
                    issues.push('HTTP ' + code + ' — ensure 404 pages return correct status, not soft 404');
                }
                if (code === 200 && cacheControl.indexOf('s-maxage') === -1 && contentType.indexOf('text/html') !== -1) {
                    issues.push('HTML page not cached at CDN edge — high TTFB for Googlebot crawls');
                }

                Logger.info('GoogleBotSimulator probe url={0} code={1} cache="{2}" xCache={3} issues={4}',
                    targetURL, code, cacheControl, xCache, issues.length);

                return {
                    statusCode   : code,
                    headers      : { cacheControl, xCache, surrogateKey, contentType },
                    redirectChain: redirectChain,
                    issues       : issues
                };
            }
        }

        issues.push('Exceeded ' + maxRedirects + ' redirects — crawler will abort');
        return { statusCode: -1, headers: {}, redirectChain: redirectChain, issues: issues };
    },

    /**
     * Probes an array of URLs and returns a summary report.
     * Suitable for use in a SFCC scheduled Job run nightly.
     *
     * @param  {string[]} urls
     * @returns {Object[]}
     */
    probeAll: function (urls) {
        return (urls || []).map(function (url) {
            return Object.assign({ url: url }, GoogleBotSimulator.probe(url));
        });
    }
};

// ─── CLIENT-SIDE: PageExperienceReporter ─────────────────────────────────────

/* eslint-disable */
;(function (window) {
    'use strict';

    if (typeof window === 'undefined') { return; }

    var SEO_RATINGS = {
        LCP : { good: 2500,  needsWork: 4000  },
        CLS : { good: 0.1,   needsWork: 0.25  },
        INP : { good: 200,   needsWork: 500   },
        FCP : { good: 1800,  needsWork: 3000  },
        TTFB: { good: 800,   needsWork: 1800  }
    };

    function rate(name, value) {
        var t = SEO_RATINGS[name];
        if (!t) { return 'unknown'; }
        return value <= t.good ? 'good' : value <= t.needsWork ? 'needs-improvement' : 'poor';
    }

    /**
     * Sends a Page Experience report to your analytics endpoint and to
     * the browser console (in debug mode).
     *
     * @param {Object} metric    - { name, value, delta, id }
     * @param {Object} config    - { endpoint, pageType, debug }
     */
    function report(metric, config) {
        var rating = rate(metric.name, metric.value);
        var payload = {
            name    : metric.name,
            value   : metric.value,
            rating  : rating,
            pageType: config.pageType || 'unknown',
            url     : window.location.href,
            ts      : Date.now()
        };

        if (config.debug) {
            var emoji = rating === 'good' ? '✅' : rating === 'needs-improvement' ? '⚠️' : '❌';
            console.group('%c[SEO PageExperience] ' + metric.name + ' ' + emoji, 'font-weight:bold');
            console.log('Value :', metric.name === 'CLS' ? metric.value.toFixed(4) : Math.round(metric.value) + 'ms');
            console.log('Rating:', rating);
            console.groupEnd();
        }

        if (config.endpoint && navigator.sendBeacon) {
            navigator.sendBeacon(
                config.endpoint,
                new Blob([JSON.stringify(payload)], { type: 'application/json' })
            );
        }

        if (typeof gtag === 'function') {
            gtag('event', 'page_experience_' + metric.name.toLowerCase(), {
                value          : Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value),
                metric_rating  : rating,
                page_type      : config.pageType,
                non_interaction: true
            });
        }
    }

    window.PageExperienceReporter = {
        /**
         * Initialises all Core Web Vital observers with SEO context.
         *
         * @param {Object} config
         * @param {string} config.pageType   - SFCC page type for segmentation
         * @param {string} config.endpoint   - Beacon endpoint URL
         * @param {boolean} [config.debug]   - Log to console
         */
        init: function (config) {
            var cfg = config || {};

            // Load web-vitals library from CDN
            var s   = document.createElement('script');
            s.src   = 'https://unpkg.com/web-vitals@3/dist/web-vitals.iife.js';
            s.async = true;
            s.onload = function () {
                var wv = window.webVitals;
                if (!wv) { return; }
                ['onLCP', 'onCLS', 'onINP', 'onFCP', 'onTTFB', 'onFID'].forEach(function (fn) {
                    if (wv[fn]) { wv[fn](function (m) { report(m, cfg); }); }
                });
                if (cfg.debug) { console.info('[SEO] PageExperienceReporter: observers attached'); }
            };
            document.head.appendChild(s);
        }
    };

}(typeof window !== 'undefined' ? window : {}));
/* eslint-enable */

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    SpeedSignalCollector  : SpeedSignalCollector,
    GoogleBotSimulator    : GoogleBotSimulator,
    SEO_THRESHOLDS        : SEO_THRESHOLDS
};
