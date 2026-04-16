/**
 * LazyImageLoader.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /lazy-loading
 *
 * Lightweight, dependency-free lazy image loader using IntersectionObserver.
 * Designed for SFCC SFRA/SiteGenesis storefronts with Dynamic Imaging Service
 * (DIS) URLs.
 *
 * Features:
 *   - Zero jQuery / library dependency
 *   - Native IntersectionObserver (falls back to eager load for IE11)
 *   - Supports <img> elements and CSS background-image containers
 *   - LQIP (Low-Quality Image Placeholder) fade-in on load
 *   - Skeleton pulse animation before image loads
 *   - Integrates with SrcSetBuilder for responsive DIS images
 *
 * Usage (include once at bottom of page, before </body>):
 *   <script src="${URLUtils.staticURL('/js/LazyImageLoader.js')}"></script>
 *   <script>LazyImageLoader.init();</script>
 *
 * HTML markup:
 *   <!-- Standard lazy image -->
 *   <img
 *     class="lazy-img"
 *     data-src="https://cdn.example.com/image.jpg"
 *     data-srcset="...w 400, ...w 800"
 *     src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
 *     alt="Product image"
 *   />
 *
 *   <!-- Background image container -->
 *   <div
 *     class="lazy-bg"
 *     data-bg="https://cdn.example.com/hero-banner.jpg"
 *     aria-label="Hero banner"
 *   ></div>
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function (window, document) {
    'use strict';

    // ── Configuration ─────────────────────────────────────────────────────────

    var CONFIG = {
        imgSelector   : '.lazy-img',
        bgSelector    : '.lazy-bg',
        loadedClass   : 'lazy-loaded',
        loadingClass  : 'lazy-loading',
        errorClass    : 'lazy-error',
        rootMargin    : '0px 0px 200px 0px',  // Start loading 200px before viewport
        threshold     : 0.01,
        fadeInDuration: '0.4s'
    };

    // ── 1×1 GIF placeholder (inline, no network cost) ─────────────────────────
    var PLACEHOLDER_GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

    // ─── Style injection ──────────────────────────────────────────────────────

    function injectStyles() {
        var style = document.createElement('style');
        style.textContent = [
            '.lazy-img, .lazy-bg {',
            '  transition: opacity ' + CONFIG.fadeInDuration + ' ease;',
            '}',
            '.lazy-img:not(.lazy-loaded) {',
            '  opacity: 0;',
            '}',
            '.lazy-img.lazy-loaded {',
            '  opacity: 1;',
            '}',
            '.lazy-bg:not(.lazy-loaded) {',
            '  background-color: #f0f0f0;',
            '  background-image: none !important;',
            '}',
            '.lazy-bg.lazy-loaded {',
            '  opacity: 1;',
            '}',
            '.lazy-loading {',
            '  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);',
            '  background-size: 200% 100%;',
            '  animation: lazyPulse 1.5s infinite;',
            '}',
            '@keyframes lazyPulse {',
            '  0%   { background-position: 200% 0; }',
            '  100% { background-position: -200% 0; }',
            '}'
        ].join('\n');
        document.head.appendChild(style);
    }

    // ─── Core loading logic ───────────────────────────────────────────────────

    /**
     * Loads a lazy <img> element by swapping data-src → src and data-srcset → srcset.
     * @param {HTMLImageElement} img
     */
    function loadImage(img) {
        var src    = img.getAttribute('data-src');
        var srcset = img.getAttribute('data-srcset');
        var sizes  = img.getAttribute('data-sizes') || img.getAttribute('sizes');

        if (!src && !srcset) { return; }

        img.classList.add(CONFIG.loadingClass);

        var tempImg = new Image();

        tempImg.onload = function () {
            if (srcset) { img.srcset = srcset; }
            if (sizes)  { img.sizes  = sizes;  }
            if (src)    { img.src    = src;    }

            img.removeAttribute('data-src');
            img.removeAttribute('data-srcset');

            img.classList.remove(CONFIG.loadingClass);
            img.classList.add(CONFIG.loadedClass);
        };

        tempImg.onerror = function () {
            img.classList.remove(CONFIG.loadingClass);
            img.classList.add(CONFIG.errorClass);
        };

        // Kick off preload
        if (srcset) { tempImg.srcset = srcset; }
        tempImg.src = src || '';
    }

    /**
     * Loads a lazy background-image container.
     * @param {HTMLElement} el
     */
    function loadBackground(el) {
        var bgURL = el.getAttribute('data-bg');
        if (!bgURL) { return; }

        el.classList.add(CONFIG.loadingClass);

        var tempImg    = new Image();
        tempImg.onload = function () {
            el.style.backgroundImage = 'url("' + bgURL + '")';
            el.removeAttribute('data-bg');
            el.classList.remove(CONFIG.loadingClass);
            el.classList.add(CONFIG.loadedClass);
        };
        tempImg.onerror = function () {
            el.classList.remove(CONFIG.loadingClass);
            el.classList.add(CONFIG.errorClass);
        };
        tempImg.src = bgURL;
    }

    /**
     * Determines how to load an element and dispatches accordingly.
     * @param {HTMLElement} el
     */
    function loadElement(el) {
        if (el.tagName === 'IMG') {
            loadImage(el);
        } else {
            loadBackground(el);
        }
    }

    // ─── IntersectionObserver setup ───────────────────────────────────────────

    /**
     * Creates and returns an IntersectionObserver that loads elements as they
     * approach the viewport.
     *
     * @returns {IntersectionObserver}
     */
    function createObserver() {
        return new IntersectionObserver(function (entries, observer) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    loadElement(entry.target);
                    observer.unobserve(entry.target);
                }
            });
        }, {
            rootMargin: CONFIG.rootMargin,
            threshold : CONFIG.threshold
        });
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    var LazyImageLoader = {

        /**
         * Initialises lazy loading on the current document.
         * Call once after DOM ready.
         *
         * @param {Object} [opts] - Optional overrides for CONFIG
         */
        init: function (opts) {
            if (opts) {
                Object.keys(opts).forEach(function (k) {
                    if (CONFIG.hasOwnProperty(k)) { CONFIG[k] = opts[k]; }
                });
            }

            injectStyles();

            var selector = CONFIG.imgSelector + ', ' + CONFIG.bgSelector;
            var elements = Array.prototype.slice.call(document.querySelectorAll(selector));

            if (!elements.length) { return; }

            // IntersectionObserver not available (old browsers) — load all eagerly
            if (!('IntersectionObserver' in window)) {
                elements.forEach(loadElement);
                return;
            }

            var observer = createObserver();
            elements.forEach(function (el) {
                // Ensure images have a placeholder so layout is stable (prevents CLS)
                if (el.tagName === 'IMG' && !el.src) {
                    el.src = PLACEHOLDER_GIF;
                }
                observer.observe(el);
            });

            LazyImageLoader._observer = observer;
        },

        /**
         * Observes a newly added element (e.g. after AJAX content injection).
         * @param {HTMLElement} el
         */
        observe: function (el) {
            if (LazyImageLoader._observer) {
                LazyImageLoader._observer.observe(el);
            } else {
                loadElement(el);
            }
        },

        /**
         * Force-loads all remaining lazy elements immediately.
         * Useful before printing or for accessibility tools.
         */
        loadAll: function () {
            var selector = CONFIG.imgSelector + ', ' + CONFIG.bgSelector;
            var elements = Array.prototype.slice.call(document.querySelectorAll(selector));
            elements.forEach(loadElement);
        },

        _observer: null,
        CONFIG   : CONFIG
    };

    // ─── Auto-init on DOMContentLoaded ────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { LazyImageLoader.init(); });
    } else {
        LazyImageLoader.init();
    }

    // ─── Expose globally ──────────────────────────────────────────────────────

    window.LazyImageLoader = LazyImageLoader;

}(window, document));
