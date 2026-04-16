/**
 * ScriptLoader.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /frontend-performance
 *
 * Client-side script loader that eliminates render-blocking JavaScript by:
 *   1. Loading non-critical scripts after the page is interactive
 *   2. Providing a priority queue (critical → high → normal → low → idle)
 *   3. Deferring analytics, chat widgets, and marketing tags to idle time
 *   4. Respecting Save-Data header and slow network connections
 *   5. Prefetching next-page scripts on hover/focus (speculative loading)
 *
 * This is a standalone, dependency-free ES5-compatible script.
 * Include it INLINE in <head> (it is tiny — ~2 KB minified).
 *
 * Usage:
 *   <!-- Inline ScriptLoader in <head> (prevents FOUC on deferred styles) -->
 *   <script>${inlinedScriptLoaderContent}</script>
 *
 *   <!-- Then schedule your scripts: -->
 *   <script>
 *     // Critical: loads immediately (replaces synchronous <script> tags)
 *     ScriptLoader.load('/js/vendors.js',          { priority: 'critical' });
 *     ScriptLoader.load('/js/storefront-common.js', { priority: 'critical' });
 *     ScriptLoader.load('/js/pdp.js',               { priority: 'high' });
 *
 *     // Deferred: loads after DOMContentLoaded
 *     ScriptLoader.load('/js/product-recommendations.js', { priority: 'normal' });
 *
 *     // Idle: loads when browser is free (requestIdleCallback)
 *     ScriptLoader.load('/js/analytics.js',    { priority: 'idle' });
 *     ScriptLoader.load('/js/live-chat.js',    { priority: 'idle' });
 *     ScriptLoader.load('/js/tag-manager.js',  { priority: 'idle' });
 *   </script>
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function (window, document) {
    'use strict';

    // ── Priority levels ───────────────────────────────────────────────────────

    var PRIORITY = {
        CRITICAL: 0,   // Load immediately — blocks nothing (async)
        HIGH    : 1,   // Load after DOM parsing begins
        NORMAL  : 2,   // Load after DOMContentLoaded
        LOW     : 3,   // Load after window.load
        IDLE    : 4    // Load during browser idle time
    };

    // ── Internal state ────────────────────────────────────────────────────────

    var _queue     = [];        // Pending script entries
    var _loaded    = {};        // src → true for already-loaded scripts
    var _loading   = {};        // src → true for in-flight requests
    var _callbacks = {};        // src → [callback fns]
    var _domReady  = false;
    var _winLoaded = false;

    // ── Network quality detection ─────────────────────────────────────────────

    /**
     * Returns true if the user is on a slow or data-saving connection.
     * On slow connections, IDLE priority scripts are skipped entirely.
     */
    function isSlowConnection() {
        var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!conn) { return false; }
        var slow = conn.saveData || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g';
        return Boolean(slow);
    }

    // ── Core loader ───────────────────────────────────────────────────────────

    /**
     * Injects a <script> tag and calls back when loaded.
     *
     * @param {string}   src
     * @param {Object}   opts
     * @param {Function} [callback]
     */
    function inject(src, opts, callback) {
        if (_loaded[src]) {
            if (callback) { callback(null, src); }
            return;
        }
        if (_loading[src]) {
            // Queue the callback for when this script finishes loading
            (_callbacks[src] = _callbacks[src] || []).push(callback);
            return;
        }

        _loading[src] = true;
        (_callbacks[src] = _callbacks[src] || []).push(callback);

        var script   = document.createElement('script');
        script.src   = src;
        script.async = true;

        if (opts.crossOrigin) { script.crossOrigin = opts.crossOrigin; }
        if (opts.integrity)   { script.integrity   = opts.integrity;   }
        if (opts.type)        { script.type         = opts.type;        }
        if (opts.id)          { script.id           = opts.id;          }

        script.onload = function () {
            _loaded[src]  = true;
            _loading[src] = false;
            (_callbacks[src] || []).forEach(function (cb) { if (cb) cb(null, src); });
            delete _callbacks[src];
        };

        script.onerror = function (err) {
            _loading[src] = false;
            (_callbacks[src] || []).forEach(function (cb) { if (cb) cb(err, src); });
            delete _callbacks[src];
            console.warn('[ScriptLoader] Failed to load:', src);
        };

        (document.head || document.documentElement).appendChild(script);
    }

    /**
     * Processes the queue and loads scripts whose conditions are now met.
     */
    function processQueue() {
        var remaining = [];

        _queue.forEach(function (entry) {
            var p = entry.priority;

            var canLoad =
                p === PRIORITY.CRITICAL ||
                (p === PRIORITY.HIGH   && _domReady) ||
                (p === PRIORITY.NORMAL && _domReady) ||
                (p === PRIORITY.LOW    && _winLoaded) ||
                (p === PRIORITY.IDLE   && _winLoaded && !isSlowConnection());

            if (canLoad) {
                if (p === PRIORITY.IDLE && 'requestIdleCallback' in window) {
                    // Defer to idle callback — avoids competing with user interactions
                    (function (e) {
                        window.requestIdleCallback(function () { inject(e.src, e.opts, e.callback); },
                            { timeout: 5000 });
                    }(entry));
                } else {
                    inject(entry.src, entry.opts, entry.callback);
                }
            } else {
                remaining.push(entry);
            }
        });

        _queue = remaining;
    }

    // ── DOM event wiring ──────────────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', function () {
        _domReady = true;
        processQueue();
    });

    window.addEventListener('load', function () {
        _winLoaded = true;
        processQueue();
    });

    // ── Prefetcher ────────────────────────────────────────────────────────────

    /**
     * Adds a <link rel="prefetch"> for a script URL.
     * Call this on anchor hover/focus to speculatively load next-page JS.
     *
     * @param {string} src
     */
    function prefetch(src) {
        if (_loaded[src] || document.querySelector('link[href="' + src + '"]')) { return; }
        var link = document.createElement('link');
        link.rel  = 'prefetch';
        link.href = src;
        link.as   = 'script';
        document.head.appendChild(link);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    var ScriptLoader = {

        /**
         * Schedules a script for loading at the given priority level.
         *
         * @param {string}   src
         * @param {Object}   [opts]
         * @param {string}   [opts.priority]    - 'critical'|'high'|'normal'|'low'|'idle'
         * @param {string}   [opts.crossOrigin] - 'anonymous'|'use-credentials'
         * @param {string}   [opts.integrity]   - SRI hash string
         * @param {Function} [callback]         - Called when script loads (err, src)
         */
        load: function (src, opts, callback) {
            var options  = opts || {};
            var priority = PRIORITY[String(options.priority || 'normal').toUpperCase()] || PRIORITY.NORMAL;

            _queue.push({ src: src, opts: options, priority: priority, callback: callback || null });
            processQueue();
        },

        /**
         * Loads multiple scripts in sequence (each waits for the previous).
         * Use for scripts with order dependencies.
         *
         * @param {string[]} srcs
         * @param {Object}   [opts]
         * @param {Function} [callback] - Called after ALL scripts load
         */
        sequence: function (srcs, opts, callback) {
            var remaining = srcs.slice();

            function next(err) {
                if (err || !remaining.length) {
                    if (callback) { callback(err); }
                    return;
                }
                ScriptLoader.load(remaining.shift(), opts, next);
            }

            next(null);
        },

        /**
         * Prefetches a script without executing it.
         * Ideal for hover/focus handlers on navigation links.
         *
         * @param {string} src
         */
        prefetch: prefetch,

        /**
         * Inline a small JS string immediately (for tiny runtime configs).
         * @param {string} code
         */
        inline: function (code) {
            var s    = document.createElement('script');
            s.textContent = code;
            (document.head || document.documentElement).appendChild(s);
        },

        /**
         * Returns true if a script URL has already been loaded.
         * @param  {string} src
         * @returns {boolean}
         */
        isLoaded: function (src) { return Boolean(_loaded[src]); },

        PRIORITY: PRIORITY
    };

    // ── Speculative loading on navigation hover ────────────────────────────────

    // Automatically prefetch page-specific JS bundles when a user
    // hovers over internal links (200 ms debounce to avoid noise)
    var _prefetchTimer = null;
    document.addEventListener('mouseover', function (e) {
        var anchor = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!anchor) { return; }

        var href = anchor.getAttribute('href') || '';
        if (!href || href.charAt(0) === '#' || /^https?:\/\//.test(href)) { return; }

        clearTimeout(_prefetchTimer);
        _prefetchTimer = setTimeout(function () {
            // Map URL patterns to their JS bundles — update to match your routes
            var bundleMap = {
                '/product/'  : '/js/pdp.js',
                '/category/' : '/js/plp.js',
                '/cart'      : '/js/cart.js',
                '/checkout'  : '/js/checkout.js'
            };

            Object.keys(bundleMap).forEach(function (pattern) {
                if (href.indexOf(pattern) !== -1) {
                    ScriptLoader.prefetch(bundleMap[pattern]);
                }
            });
        }, 200);
    });

    // ── Expose globally ───────────────────────────────────────────────────────

    window.ScriptLoader = ScriptLoader;

}(window, document));
