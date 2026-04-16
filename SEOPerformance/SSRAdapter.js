/**
 * SSRAdapter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /seo-performance
 *
 * Server-Side Rendering (SSR) adapter for SFCC PWA Kit / headless storefronts.
 * Solves the core SEO risk of SPA-based SFCC implementations: Googlebot
 * receiving a blank HTML shell instead of indexable content.
 *
 * Covers:
 *
 *   1. SSR DETECTION MIDDLEWARE
 *      Detects bot traffic (Googlebot, Bingbot, social crawlers) and routes
 *      to a pre-rendered or SSR path, while serving the SPA to real users.
 *
 *   2. METADATA SSR INJECTOR
 *      For SFCC PWA Kit: intercepts the SSR render cycle and injects
 *      computed SEO metadata (title, meta tags, JSON-LD, canonical, hreflang)
 *      into the server-rendered HTML stream before it leaves the origin,
 *      so Googlebot sees complete metadata without JavaScript execution.
 *
 *   3. HYDRATION GUARD
 *      Client-side utility that prevents React hydration from overwriting
 *      server-injected SEO metadata tags. The metadata rendered by SSR
 *      stays in the DOM until a genuine client-side route change.
 *
 *   4. RENDER-BLOCKING SCRIPT AUDIT
 *      Scans the SSR HTML output for render-blocking scripts and stylesheets
 *      that would delay Googlebot's First Contentful Paint measurement,
 *      logging actionable fixes.
 *
 *   5. CRAWL BUDGET PRERENDER MAP
 *      Generates a prerender priority map from SFCC catalog data, identifying
 *      which URLs should be server-rendered on first request vs. deferred —
 *      based on traffic, revenue, and link depth signals.
 *
 * Usage (SFCC PWA Kit — app/ssr.js):
 *   import { SSRAdapter } from './scripts/seo/SSRAdapter'
 *
 *   export const get = SSRAdapter.wrapSSRHandler(async (req, res) => {
 *       // Your existing PWA Kit SSR handler
 *   })
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─── Bot detection ────────────────────────────────────────────────────────────

/**
 * Known crawler and bot User-Agent patterns.
 * Comprehensive list covering SEO bots, social crawlers, and monitoring agents.
 */
var BOT_PATTERNS = [
    // Search engine crawlers
    /googlebot/i,
    /bingbot/i,
    /slurp/i,         // Yahoo
    /duckduckbot/i,
    /baiduspider/i,
    /yandexbot/i,
    /sogou/i,
    /exabot/i,
    /facebot/i,
    /ia_archiver/i,   // Alexa

    // Social network crawlers (need SSR for og: tags)
    /facebookexternalhit/i,
    /twitterbot/i,
    /linkedinbot/i,
    /pinterestbot/i,
    /whatsapp/i,
    /telegrambot/i,
    /slackbot/i,
    /discordbot/i,

    // SEO audit tools
    /screaming frog/i,
    /ahrefsbot/i,
    /semrushbot/i,
    /mj12bot/i,
    /dotbot/i,

    // Lighthouse / PageSpeed (need real rendering)
    /chrome-lighthouse/i,

    // Generic
    /spider/i,
    /crawl/i,
    /prerender/i
];

/**
 * Returns true if the request's User-Agent belongs to a known bot.
 *
 * @param  {string} userAgent
 * @returns {boolean}
 */
function isBot(userAgent) {
    if (!userAgent) { return false; }
    var ua = String(userAgent);
    return BOT_PATTERNS.some(function (pattern) { return pattern.test(ua); });
}

/**
 * Determines the type of bot for routing decisions.
 *
 * @param  {string} userAgent
 * @returns {'googlebot'|'social'|'seo-tool'|'other-bot'|'human'}
 */
function getBotType(userAgent) {
    if (!userAgent) { return 'human'; }
    var ua = userAgent.toLowerCase();
    if (/googlebot/i.test(ua) || /google page speed/i.test(ua)) { return 'googlebot'; }
    if (/facebookexternalhit|twitterbot|linkedinbot|pinterestbot|whatsapp|telegram|slack|discord/i.test(ua)) { return 'social'; }
    if (/ahrefsbot|semrushbot|screaming frog|dotbot|mj12bot/i.test(ua)) { return 'seo-tool'; }
    if (isBot(ua)) { return 'other-bot'; }
    return 'human';
}

// ─── Metadata SSR injector ────────────────────────────────────────────────────

/**
 * Injects SEO metadata into an SSR HTML string.
 *
 * Used in SFCC PWA Kit's ssr.js to ensure the HTML sent to Googlebot
 * contains all required meta tags, even if the React component tree
 * hasn't emitted them yet (e.g. if data fetching is deferred).
 *
 * @param  {string}  html         - Server-rendered HTML string
 * @param  {Object}  seoHead      - Output from MetadataManager.build*Head()
 * @param  {Object}  [opts]
 * @param  {boolean} [opts.replaceExisting]  - Replace existing <title> if present
 * @returns {string} HTML with injected metadata
 */
function injectMetadataIntoHTML(html, seoHead, opts) {
    if (!html || !seoHead) { return html || ''; }
    var options = opts || {};

    var injection = [
        seoHead.titleTag,
        seoHead.metaTags,
        seoHead.canonicalTag,
        seoHead.hreflangTags,
        seoHead.jsonLd
    ].filter(Boolean).join('\n');

    // If replaceExisting: remove any <title> already in the HTML
    var processedHTML = html;
    if (options.replaceExisting) {
        processedHTML = processedHTML.replace(/<title[^>]*>[\s\S]*?<\/title>/i, '');
        // Remove existing canonical
        processedHTML = processedHTML.replace(/<link[^>]+rel=["']canonical["'][^>]*>/gi, '');
    }

    // Inject immediately after <head> (or before </head> if <head> not found)
    if (/<head[^>]*>/i.test(processedHTML)) {
        processedHTML = processedHTML.replace(/(<head[^>]*>)/i, '$1\n' + injection + '\n');
    } else if (/<\/head>/i.test(processedHTML)) {
        processedHTML = processedHTML.replace(/<\/head>/i, injection + '\n</head>');
    } else {
        // No <head> at all — prepend
        processedHTML = injection + '\n' + processedHTML;
    }

    return processedHTML;
}

// ─── SSR handler wrapper ──────────────────────────────────────────────────────

/**
 * Wraps a SFCC PWA Kit SSR handler function with:
 *   - Bot detection and routing
 *   - Performance timing headers
 *   - SEO metadata injection post-render
 *   - Render-blocking script audit (dev only)
 *
 * @param  {Function} handler    - Your existing async (req, res) => void handler
 * @param  {Object}   [config]
 * @param  {Function} [config.getMetadata]  - async (req) => seoHead object
 * @param  {boolean}  [config.auditScripts] - Log render-blocking issues
 * @returns {Function}
 */
function wrapSSRHandler(handler, config) {
    var cfg = config || {};

    return async function ssrHandlerWrapper(req, res) {
        var startMs  = Date.now();
        var ua       = req.headers && req.headers['user-agent'] || '';
        var botType  = getBotType(ua);
        var isSearch = botType === 'googlebot' || botType === 'other-bot';

        // Add bot-type context to response headers for debugging
        res.setHeader('X-Bot-Type', botType);

        // For Googlebot: intercept the response body to inject metadata
        if (isSearch && cfg.getMetadata) {
            var originalSend = res.send.bind(res);
            var originalEnd  = res.end.bind(res);
            var buffer       = '';

            res.send = function (body) {
                buffer += (body || '');
                return res;
            };
            res.end = async function (body) {
                if (body) { buffer += body; }

                try {
                    var seoHead = await cfg.getMetadata(req);
                    var finalHTML = injectMetadataIntoHTML(buffer, seoHead, { replaceExisting: true });

                    if (cfg.auditScripts) {
                        auditRenderBlockingScripts(finalHTML, req.url);
                    }

                    res.setHeader('X-SSR-Metadata-Injected', 'true');
                    originalEnd(finalHTML);
                } catch (e) {
                    console.error('[SSRAdapter] Metadata injection failed:', e.message);
                    originalEnd(buffer);
                }
            };
        }

        await handler(req, res);

        var durationMs = Date.now() - startMs;
        res.setHeader('Server-Timing', 'ssr;dur=' + durationMs + ';desc="SSR"');
        res.setHeader('X-SSR-Duration', durationMs + 'ms');
    };
}

// ─── Render-blocking script audit ─────────────────────────────────────────────

/**
 * Scans an HTML string for render-blocking resources and logs actionable fixes.
 * Run in development to catch issues before they reach production.
 *
 * @param {string} html   - Rendered HTML string
 * @param {string} [url]  - Page URL for context in log messages
 */
function auditRenderBlockingScripts(html, url) {
    var issues = [];

    // Synchronous <script> tags in <head> (no defer/async)
    var syncScripts = html.match(/<head[\s\S]*?<\/head>/i);
    if (syncScripts) {
        var headContent = syncScripts[0];
        var blockingScripts = headContent.match(/<script(?![^>]*(async|defer|type=["']module["']))[^>]*src=[^>]+>/gi) || [];
        blockingScripts.forEach(function (tag) {
            issues.push({
                type: 'RENDER_BLOCKING_SCRIPT',
                element: tag.slice(0, 120),
                fix: 'Add async or defer attribute, or move to bottom of <body>'
            });
        });
    }

    // <link rel="stylesheet"> without media=print trick (render-blocking CSS)
    var blockingCSS = html.match(/<link[^>]+rel=["']stylesheet["'][^>]*(?!media=["']print["'])[^>]*>/gi) || [];
    blockingCSS.forEach(function (tag) {
        if (!tag.includes('media="print"') && !tag.includes("media='print'")) {
            issues.push({
                type: 'RENDER_BLOCKING_CSS',
                element: tag.slice(0, 120),
                fix: 'Inline critical CSS and defer main stylesheet using <link rel="preload" as="style" onload="...">'
            });
        }
    });

    if (issues.length > 0) {
        console.warn('[SSRAdapter] Render-blocking resources detected on ' + (url || 'page') + ':');
        issues.forEach(function (issue, i) {
            console.warn('  ' + (i + 1) + '. [' + issue.type + '] ' + issue.element);
            console.warn('     Fix: ' + issue.fix);
        });
    } else {
        console.info('[SSRAdapter] No render-blocking resources detected on ' + (url || 'page'));
    }

    return issues;
}

// ─── Client-side hydration guard (browser IIFE) ───────────────────────────────

/* eslint-disable */
;(function (window, document) {
    'use strict';
    if (typeof window === 'undefined') { return; }

    /**
     * HydrationGuard
     *
     * Protects server-injected SEO metadata from being overwritten during
     * React hydration or client-side route transitions.
     *
     * On first load: SSR metadata is already correct — guard it.
     * On route change: allow React (react-helmet / next/head) to take over.
     *
     * Usage (in your PWA Kit app root):
     *   HydrationGuard.init()
     *
     *   // When a client-side navigation starts:
     *   HydrationGuard.release()
     */
    var HydrationGuard = {
        _protected: false,
        _snapshots: {},

        /**
         * Snapshots the current <head> metadata and sets up a MutationObserver
         * to restore it if React replaces it during hydration.
         */
        init: function () {
            var self = this;
            self._protected = true;

            // Snapshot key SEO tags
            ['title', 'link[rel="canonical"]', 'meta[name="description"]',
             'meta[property="og:title"]', 'script[type="application/ld+json"]']
                .forEach(function (selector) {
                    var el = document.querySelector(selector);
                    if (el) { self._snapshots[selector] = el.outerHTML; }
                });

            // Observe <head> for mutations during hydration
            var observer = new MutationObserver(function (mutations) {
                if (!self._protected) { return; }

                mutations.forEach(function (mutation) {
                    // If a key SEO element was removed, restore it
                    mutation.removedNodes.forEach(function (node) {
                        if (!node.tagName) { return; }
                        var tag = node.tagName.toLowerCase();
                        if (tag === 'title' || tag === 'link' || tag === 'meta' || tag === 'script') {
                            var key = Object.keys(self._snapshots).find(function (s) {
                                return node.outerHTML && node.outerHTML === self._snapshots[s];
                            });
                            if (key) {
                                // Restore the removed SEO element
                                var div = document.createElement('div');
                                div.innerHTML = self._snapshots[key];
                                var restored = div.firstChild;
                                if (restored) {
                                    document.head.insertBefore(restored, document.head.firstChild);
                                    console.debug('[HydrationGuard] Restored SEO element:', key);
                                }
                            }
                        }
                    });
                });
            });

            observer.observe(document.head, { childList: true, subtree: false });
            this._observer = observer;
        },

        /** Releases the guard (call on client-side route change). */
        release: function () {
            this._protected = false;
            this._snapshots = {};
            if (this._observer) { this._observer.disconnect(); }
        }
    };

    window.HydrationGuard = HydrationGuard;

}(typeof window !== 'undefined' ? window : {}, typeof document !== 'undefined' ? document : {}));
/* eslint-enable */

// ─── Crawl budget prerender map ────────────────────────────────────────────────

var CrawlBudgetMapper = {

    /**
     * Priority tiers for SSR vs. deferred rendering.
     * Higher priority = render on first request (warm SSR).
     * Lower priority = render on demand or prerender nightly.
     */
    PRIORITY_TIERS: {
        CRITICAL   : 1,  // Homepage, top 20 category pages, top 100 PDPs by revenue
        HIGH       : 2,  // All category pages, top 500 PDPs, search landing pages
        STANDARD   : 3,  // Long-tail PDPs, filtered PLPs
        LOW        : 4,  // Pagination pages (noindex), refinement combos
        NORENDER   : 5   // Cart, checkout, account (private, never index)
    },

    /**
     * Classifies a URL's crawl budget priority based on its pattern.
     *
     * @param  {string} url
     * @param  {Object} [hints]  - Optional hints from analytics ({ sessions, revenue })
     * @returns {{ priority: number, tier: string, shouldSSR: boolean, reason: string }}
     */
    classify: function (url, hints) {
        var path = url.replace(/^https?:\/\/[^/]+/, '').toLowerCase();

        // Never render private pages
        if (/\/(cart|checkout|account|login|order)/.test(path)) {
            return { priority: 5, tier: 'NORENDER', shouldSSR: false,
                     reason: 'Private page — never crawled' };
        }

        // Homepage — always critical
        if (path === '/' || path === '') {
            return { priority: 1, tier: 'CRITICAL', shouldSSR: true,
                     reason: 'Homepage — highest crawl priority' };
        }

        // Pagination (noindex) — low priority SSR
        if (/[?&]start=\d+/.test(path) && !/start=0/.test(path)) {
            return { priority: 4, tier: 'LOW', shouldSSR: false,
                     reason: 'Paginated page — noindex, no SSR needed' };
        }

        // Search with many refinements — low (many duplicate-ish URLs)
        var refinementCount = (path.match(/prefn\d+/g) || []).length;
        if (refinementCount >= 2) {
            return { priority: 4, tier: 'LOW', shouldSSR: false,
                     reason: 'Multi-refinement URL — noindex recommended' };
        }

        // Category pages — high priority
        if (/\/(c|category|womens|mens|kids|sale)\//.test(path) || /cgid=/.test(path)) {
            return { priority: 2, tier: 'HIGH', shouldSSR: true,
                     reason: 'Category page — high crawl value' };
        }

        // Product pages — standard (or CRITICAL if high revenue)
        if (/\/(p|product)\/|pid=/.test(path)) {
            if (hints && hints.revenue > 10000) {
                return { priority: 1, tier: 'CRITICAL', shouldSSR: true,
                         reason: 'High-revenue PDP — critical SSR priority' };
            }
            if (hints && hints.sessions > 1000) {
                return { priority: 2, tier: 'HIGH', shouldSSR: true,
                         reason: 'High-traffic PDP — high SSR priority' };
            }
            return { priority: 3, tier: 'STANDARD', shouldSSR: true,
                     reason: 'Standard PDP' };
        }

        // Search pages
        if (/\/search|q=/.test(path)) {
            return { priority: 2, tier: 'HIGH', shouldSSR: true,
                     reason: 'Search landing page — high SEO value for long-tail queries' };
        }

        // Content / editorial
        return { priority: 3, tier: 'STANDARD', shouldSSR: true,
                 reason: 'Content page — standard SSR priority' };
    },

    /**
     * Builds a prioritised prerender sitemap from an array of URLs.
     * Returns URLs sorted by priority (CRITICAL first) with SSR flags.
     *
     * @param  {string[]} urls
     * @returns {Object[]}  Sorted array of { url, priority, tier, shouldSSR, reason }
     */
    buildPrerenderMap: function (urls) {
        var mapped = (urls || []).map(function (url) {
            return Object.assign({ url: url }, CrawlBudgetMapper.classify(url));
        });

        return mapped.sort(function (a, b) { return a.priority - b.priority; });
    }
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    isBot                    : isBot,
    getBotType               : getBotType,
    injectMetadataIntoHTML   : injectMetadataIntoHTML,
    wrapSSRHandler           : wrapSSRHandler,
    auditRenderBlockingScripts: auditRenderBlockingScripts,
    CrawlBudgetMapper        : CrawlBudgetMapper,
    BOT_PATTERNS             : BOT_PATTERNS
};
