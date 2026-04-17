/**
 * HeadlessMonitor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /headless-performance/monitoring
 *
 * Performance monitoring purpose-built for SFCC headless storefronts.
 * Measures what matters in a React + SCAPI stack that traditional
 * SFCC monitoring misses:
 *
 *   • SPA route change performance (the "soft navigation" problem)
 *   • SCAPI call latency with endpoint-level breakdown
 *   • React render time per page type
 *   • Hydration performance (SSR → client takeover timing)
 *   • Edge cache hit rate from response headers
 *   • Data waterfall detection (sequential API calls)
 *
 * Usage (in _app.jsx or layout.tsx):
 *   import { HeadlessMonitor } from '@/lib/sfcc/HeadlessMonitor'
 *   HeadlessMonitor.init({ siteId: 'MySite', pageType: 'pdp', debug: isDev })
 *
 * Usage (instrument an API call):
 *   const product = await HeadlessMonitor.trackAPICall(
 *     'getProduct',
 *     () => optimizer.getProduct(pid)
 *   )
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use client';

// ─── Metric definitions ───────────────────────────────────────────────────────

const THRESHOLDS = {
    // Core Web Vitals (headless storefronts must meet same targets as traditional)
    LCP       : { good: 2500,  poor: 4000  },
    CLS       : { good: 0.1,   poor: 0.25  },
    INP       : { good: 200,   poor: 500   },
    FCP       : { good: 1800,  poor: 3000  },
    TTFB      : { good: 800,   poor: 1800  },

    // Headless-specific
    SCAPI_CALL      : { good: 200,  poor: 800   },  // Individual SCAPI call
    SCAPI_COMPOSITE : { good: 300,  poor: 1200  },  // Composite multi-call
    ROUTE_CHANGE    : { good: 200,  poor: 1000  },  // SPA navigation
    HYDRATION       : { good: 50,   poor: 300   },  // SSR hydration time
    REACT_RENDER    : { good: 50,   poor: 200   },  // Component render time
    EDGE_CACHE_RATE : { good: 0.8,  poor: 0.5   }   // Edge cache hit rate (ratio)
};

function rate(name, value) {
    const t = THRESHOLDS[name];
    if (!t) { return 'unknown'; }
    if (name === 'EDGE_CACHE_RATE') {
        return value >= t.good ? 'good' : value >= t.poor ? 'needs-improvement' : 'poor';
    }
    return value <= t.good ? 'good' : value <= t.poor ? 'needs-improvement' : 'poor';
}

// ─── Internal state ───────────────────────────────────────────────────────────

let _config        = {};
let _apiCalls      = [];
let _routeChanges  = [];
let _cacheHits     = 0;
let _cacheMisses   = 0;
let _routeStart    = 0;
let _initialized   = false;

// ─── HeadlessMonitor ──────────────────────────────────────────────────────────

export const HeadlessMonitor = {

    /**
     * Initialises the monitor. Call once in your app root component.
     *
     * @param {Object}  config
     * @param {string}  config.siteId       - SFCC site ID
     * @param {string}  [config.pageType]   - 'pdp'|'plp'|'home'|'search'|'cart'
     * @param {string}  [config.endpoint]   - Beacon URL for analytics
     * @param {boolean} [config.debug]      - Log to console
     * @param {Function}[config.onMetric]   - Custom callback per metric
     */
    init(config = {}) {
        if (_initialized && typeof window === 'undefined') { return; }
        _config      = config;
        _initialized = true;

        this._attachWebVitals();
        this._attachRouteChangeObserver();
        this._attachHydrationObserver();
        this._attachEdgeCacheMonitor();

        if (config.debug) {
            console.info('[HeadlessMonitor] Initialised', config);
        }
    },

    // ── Web Vitals ────────────────────────────────────────────────────────────

    _attachWebVitals() {
        if (typeof window === 'undefined') { return; }

        const script   = document.createElement('script');
        script.src     = 'https://unpkg.com/web-vitals@3/dist/web-vitals.iife.js';
        script.async   = true;
        script.onload  = () => {
            const wv = window.webVitals;
            if (!wv) { return; }
            ['onLCP', 'onCLS', 'onINP', 'onFCP', 'onTTFB'].forEach(fn => {
                if (wv[fn]) { wv[fn](m => this._report(m.name, m.value, { id: m.id })); }
            });
        };
        document.head.appendChild(script);
    },

    // ── SPA Route change tracking ─────────────────────────────────────────────

    _attachRouteChangeObserver() {
        if (typeof window === 'undefined') { return; }

        // Next.js router events
        const tryNext = () => {
            if (!window.__NEXT_DATA__) { return false; }
            try {
                const Router = require('next/router').default;
                Router.events.on('routeChangeStart', () => { _routeStart = performance.now(); });
                Router.events.on('routeChangeComplete', (url) => {
                    const duration = performance.now() - _routeStart;
                    _routeChanges.push({ url, duration, ts: Date.now() });
                    this._report('ROUTE_CHANGE', duration, { url });
                });
                return true;
            } catch { return false; }
        };

        // Fallback: Navigation API (Chrome 102+)
        if (!tryNext() && 'navigation' in window) {
            window.navigation.addEventListener('navigate', () => {
                _routeStart = performance.now();
            });
            window.navigation.addEventListener('navigatesuccess', () => {
                const duration = performance.now() - _routeStart;
                this._report('ROUTE_CHANGE', duration, { url: window.location.href });
            });
        }
    },

    // ── Hydration timing ──────────────────────────────────────────────────────

    _attachHydrationObserver() {
        if (typeof window === 'undefined') { return; }

        try {
            const obs = new PerformanceObserver(list => {
                list.getEntries().forEach(entry => {
                    if (entry.name.includes('hydrat')) {
                        this._report('HYDRATION', entry.duration, { name: entry.name });
                    }
                });
            });
            obs.observe({ type: 'measure', buffered: true });
        } catch { /* unsupported */ }
    },

    // ── Edge cache monitoring ─────────────────────────────────────────────────

    _attachEdgeCacheMonitor() {
        if (typeof window === 'undefined') { return; }

        // Intercept fetch to read X-Cache response headers
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
            const res = await originalFetch(...args);

            const xCache = res.headers.get('X-Cache') || res.headers.get('CF-Cache-Status') || '';
            const isHit  = /hit/i.test(xCache);

            if (isHit)  { _cacheHits++; }
            else        { _cacheMisses++; }

            const total   = _cacheHits + _cacheMisses;
            const hitRate = total > 0 ? _cacheHits / total : 0;

            if (total % 10 === 0) {
                this._report('EDGE_CACHE_RATE', hitRate, { hits: _cacheHits, misses: _cacheMisses });
            }

            return res;
        };
    },

    // ── SCAPI call instrumentation ────────────────────────────────────────────

    /**
     * Wraps a SCAPI call and records its latency.
     * Use this in your data-fetching layer, not in React components.
     *
     * @param  {string}   callName  - Descriptive name (e.g. 'getProduct', 'search')
     * @param  {Function} fn        - Async function to wrap
     * @param  {Object}   [meta]    - Extra context (productId, query, etc.)
     * @returns {Promise<any>}
     */
    async trackAPICall(callName, fn, meta = {}) {
        const start = performance.now();
        let result, error;

        try {
            result = await fn();
        } catch (err) {
            error = err;
        }

        const duration = performance.now() - start;
        const record   = { callName, duration, meta, ts: Date.now(), error: error?.message };

        _apiCalls.push(record);

        // Keep only last 100 calls in memory
        if (_apiCalls.length > 100) { _apiCalls.shift(); }

        this._report('SCAPI_CALL', duration, { callName, ...meta });

        // Detect waterfall: if two calls finish within 5ms, they ran in parallel (good)
        // If consecutive calls are separated by >50ms, it's a waterfall (bad)
        this._detectWaterfall(_apiCalls);

        if (error) { throw error; }
        return result;
    },

    _detectWaterfall(calls) {
        if (calls.length < 2) { return; }

        const last = calls[calls.length - 1];
        const prev = calls[calls.length - 2];
        const gap  = last.ts - (prev.ts + prev.duration);

        if (gap > 50) {
            const msg = `[HeadlessMonitor] API WATERFALL detected: "${prev.callName}" → "${last.callName}" gap=${gap.toFixed(0)}ms`;
            if (_config.debug) { console.warn(msg); }

            // Report as a synthetic metric
            this._report('WATERFALL_DETECTED', gap, {
                prev: prev.callName,
                next: last.callName
            });
        }
    },

    // ── React render time ─────────────────────────────────────────────────────

    /**
     * Marks the start of a React component render. Call in useMemo/useEffect.
     * @param  {string} componentName
     * @returns {Function}  End marker — call when render is complete
     *
     * @example
     * function ProductDetail({ product }) {
     *   const endMark = HeadlessMonitor.startRenderMark('ProductDetail')
     *   useEffect(() => { endMark() }, [])
     *   return <div>...</div>
     * }
     */
    startRenderMark(componentName) {
        const start = performance.now();
        return () => {
            const duration = performance.now() - start;
            this._report('REACT_RENDER', duration, { component: componentName });
        };
    },

    // ── Reporter ──────────────────────────────────────────────────────────────

    _report(metricName, value, meta = {}) {
        const rating  = rate(metricName, value);
        const payload = {
            name    : metricName,
            value   : metricName === 'CLS' ? value : Math.round(value),
            rating,
            pageType: _config.pageType || 'unknown',
            siteId  : _config.siteId   || 'unknown',
            url     : typeof window !== 'undefined' ? window.location.href : '',
            ts      : Date.now(),
            ...meta
        };

        if (_config.debug) {
            const emoji = rating === 'good' ? '✅' : rating === 'needs-improvement' ? '⚠️' : '❌';
            console.log(`[HeadlessMonitor] ${emoji} ${metricName}`, Math.round(value), rating, meta);
        }

        if (typeof _config.onMetric === 'function') {
            _config.onMetric(payload);
        }

        // GA4
        if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
            window.gtag('event', `headless_${metricName.toLowerCase()}`, {
                value          : payload.value,
                metric_rating  : rating,
                page_type      : _config.pageType,
                non_interaction: true
            });
        }

        // Beacon
        if (_config.endpoint && typeof window !== 'undefined' && navigator.sendBeacon) {
            navigator.sendBeacon(
                _config.endpoint,
                new Blob([JSON.stringify(payload)], { type: 'application/json' })
            );
        }
    },

    // ── Diagnostics ───────────────────────────────────────────────────────────

    /**
     * Returns a diagnostics summary for debugging.
     * @returns {Object}
     */
    getDiagnostics() {
        const totalCalls = _apiCalls.length;
        const avgLatency = totalCalls
            ? _apiCalls.reduce((s, c) => s + c.duration, 0) / totalCalls
            : 0;

        const slowCalls = _apiCalls
            .filter(c => c.duration > THRESHOLDS.SCAPI_CALL.poor)
            .map(c => ({ callName: c.callName, duration: Math.round(c.duration), ...c.meta }));

        return {
            apiCalls    : { total: totalCalls, avgLatencyMs: Math.round(avgLatency), slowCalls },
            edgeCache   : { hits: _cacheHits, misses: _cacheMisses, hitRate: (_cacheHits / Math.max(1, _cacheHits + _cacheMisses)).toFixed(2) },
            routeChanges: _routeChanges.slice(-5),
            thresholds  : THRESHOLDS
        };
    }
};

export { THRESHOLDS };
