/**
 * DynamicContentPipeline.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /personalization-performance/dynamic-content
 *
 * The "Shell + Fragments" pipeline for delivering dynamic personalized content
 * without sacrificing page caching.
 *
 * The Core Problem:
 *   Adding ANY personalised content to a page traditionally requires the
 *   entire page to be un-cacheable (private, no-store). One tiny "Hello,
 *   Sarah!" in the header ruins full-page caching for the entire page.
 *
 * The Solution — Shell + Fragments Pattern:
 *
 *   SHELL (cached at CDN, fast)
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ Navigation (cached)                                          │
 *   │ ┌──────────────────────────┐  ← PLACEHOLDER: hero-banner    │
 *   │ │  [fragment-hero]         │                                 │
 *   │ └──────────────────────────┘                                 │
 *   │ Product grid (cached)                                        │
 *   │ ┌──────────────────────────┐  ← PLACEHOLDER: promo-bar      │
 *   │ │  [fragment-promo]        │                                 │
 *   │ └──────────────────────────┘                                 │
 *   │ Footer (cached)                                              │
 *   └──────────────────────────────────────────────────────────────┘
 *
 *   FRAGMENTS (fetched async after shell, personalised)
 *   /api/personalization/hero    → { segment: 'loyal', html: '...' }
 *   /api/personalization/promo   → { segment: 'loyal', html: '...' }
 *
 * Performance result:
 *   - Shell renders from CDN in < 5ms
 *   - Fragments arrive in parallel, ~100ms after shell
 *   - LCP is the shell content (fast), personalisation fills in after
 *   - Zero cache pollution — shell remains 100% cacheable
 *
 * Usage:
 *   var Pipeline = require('*/cartridge/scripts/personalization/DynamicContentPipeline');
 *
 *   // In a controller:
 *   var shellData = Pipeline.buildShell(pdict);
 *   var fragment  = Pipeline.renderFragment('hero-banner', segment);
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var Logger      = require('dw/system/Logger').getLogger('personalization', 'DynamicContent');
var URLUtils    = require('dw/web/URLUtils');
var Site        = require('dw/system/Site');
var SegCache    = require('*/cartridge/scripts/personalization/caching/SegmentedCacheManager');
var PSStrategy  = require('*/cartridge/scripts/personalization/strategies/PersonalizationStrategy');

// ─── Fragment registry ────────────────────────────────────────────────────────

/**
 * Registry of all personalizable content fragments.
 * Each fragment defines:
 *   - endpoint: API URL the client fetches to hydrate this slot
 *   - cacheable: whether server-side caching is enabled
 *   - ttl: cache duration in seconds
 *   - priority: 'high' fragments are fetched before 'low' on slow connections
 *   - fallback: static HTML to show if the fragment fails to load
 */
var FRAGMENT_REGISTRY = {
    'hero-banner': {
        endpoint : '/Personalization-HeroBanner',
        cacheable: true,
        ttl      : 300,
        priority : 'high',
        fallback : '<div class="hero-banner hero-banner--default"></div>'
    },
    'promo-bar': {
        endpoint : '/Personalization-PromoBar',
        cacheable: true,
        ttl      : 120,
        priority : 'high',
        fallback : ''
    },
    'product-recommendations': {
        endpoint : '/Personalization-Recommendations',
        cacheable: true,
        ttl      : 180,
        priority : 'low',
        fallback : ''
    },
    'loyalty-widget': {
        endpoint : '/Personalization-LoyaltyWidget',
        cacheable: false,   // Loyalty points are individual — never cache
        ttl      : 0,
        priority : 'low',
        fallback : ''
    },
    'cart-upsell': {
        endpoint : '/Personalization-CartUpsell',
        cacheable: false,   // Cart-specific — never cache
        ttl      : 0,
        priority : 'high',
        fallback : ''
    }
};

// ─── Shell builder ────────────────────────────────────────────────────────────

/**
 * Builds the cacheable shell HTML with placeholder elements for fragments.
 * The shell renders immediately from CDN. Fragments hydrate asynchronously.
 *
 * @param  {Object} pdict     - SFCC page dictionary
 * @param  {Array}  fragments - Fragment names to include placeholders for
 * @returns {{ html: string, fragmentMap: Object, cacheHeaders: Object }}
 */
function buildShell(pdict, fragments) {
    var fragmentNames = fragments || Object.keys(FRAGMENT_REGISTRY);
    var fragmentMap   = {};
    var placeholders  = [];

    fragmentNames.forEach(function (name) {
        var reg = FRAGMENT_REGISTRY[name];
        if (!reg) { return; }

        var fragmentURL = URLUtils.url(reg.endpoint.replace('/', '')).toString();

        fragmentMap[name] = {
            url     : fragmentURL,
            priority: reg.priority,
            fallback: reg.fallback,
            ttl     : reg.ttl
        };

        // Placeholder element — client JS replaces this with fragment HTML
        placeholders.push([
            '<div',
            ' id="ps-fragment-' + name + '"',
            ' data-fragment="' + name + '"',
            ' data-endpoint="' + fragmentURL + '"',
            ' data-priority="' + reg.priority + '"',
            ' aria-live="polite"',
            '>',
            reg.fallback || '',   // Show fallback immediately to prevent CLS
            '</div>'
        ].join(''));
    });

    // Inline fragment loader script — tiny, inlined so it runs before body
    var loaderScript = buildFragmentLoaderScript(fragmentMap);

    return {
        fragmentPlaceholders : placeholders.join('\n'),
        fragmentMap          : fragmentMap,
        loaderScript         : loaderScript
    };
}

// ─── Fragment renderer (server-side) ─────────────────────────────────────────

/**
 * Renders a single personalised fragment for a given segment.
 * Called by individual fragment controller endpoints.
 *
 * Uses SegmentedCacheManager to cache results per segment.
 *
 * @param  {string}   fragmentName  - Name from FRAGMENT_REGISTRY
 * @param  {string}   segment       - Customer segment
 * @param  {Function} renderFn      - () => HTML string for this segment
 * @param  {Object}   [opts]
 * @param  {string}   [opts.locale]
 * @param  {string}   [opts.currency]
 * @returns {{ html: string, segment: string, cached: boolean, latencyMs: number }}
 */
function renderFragment(fragmentName, segment, renderFn, opts) {
    var options    = opts || {};
    var reg        = FRAGMENT_REGISTRY[fragmentName];
    var start      = Date.now();

    if (!reg) {
        Logger.warn('DynamicContentPipeline: unknown fragment "{0}"', fragmentName);
        return { html: '', segment: segment, cached: false, latencyMs: 0 };
    }

    // Non-cacheable fragments (loyalty, cart) — always render fresh
    if (!reg.cacheable) {
        var freshHTML = renderFn(segment);
        Logger.info('DCP FRESH fragment={0} seg={1} latency={2}ms',
            fragmentName, segment, Date.now() - start);
        return { html: freshHTML, segment: segment, cached: false, latencyMs: Date.now() - start };
    }

    // Cacheable fragments — use segmented cache
    var dims   = { locale: options.locale, currency: options.currency };
    var html   = SegCache.getOrRender(
        'fragment:' + fragmentName,
        segment,
        renderFn,
        { ttl: reg.ttl, dims: dims }
    );

    var latencyMs = Date.now() - start;
    Logger.info('DCP fragment={0} seg={1} latency={2}ms', fragmentName, segment, latencyMs);

    return {
        html      : html || reg.fallback || '',
        segment   : segment,
        cached    : true,
        latencyMs : latencyMs
    };
}

// ─── Fragment loader script ───────────────────────────────────────────────────

/**
 * Generates a tiny inline JavaScript snippet that hydrates all fragment
 * placeholders after the shell HTML is parsed by the browser.
 *
 * Features:
 *   - High-priority fragments fetched immediately
 *   - Low-priority fragments deferred to requestIdleCallback
 *   - Graceful fallback on fragment fetch failure
 *   - No dependencies (vanilla JS, < 2KB)
 *
 * @param  {Object} fragmentMap  - { name: { url, priority, fallback } }
 * @returns {string}  HTML <script> tag (inline)
 */
function buildFragmentLoaderScript(fragmentMap) {
    var fragmentJSON = JSON.stringify(fragmentMap);

    return [
        '<script id="ps-fragment-loader">',
        '(function(fragments,doc){',
        '  var segment=getCookie("sfcc_segment")||"anonymous";',
        '  function getCookie(n){',
        '    var m=doc.cookie.match("(^|;)\\s*"+n+"=([^;]+)");',
        '    return m?decodeURIComponent(m[2]):null;',
        '  }',
        '  function loadFragment(name,cfg){',
        '    var el=doc.getElementById("ps-fragment-"+name);',
        '    if(!el)return;',
        '    var url=cfg.url+"?segment="+encodeURIComponent(segment)+"&format=ajax";',
        '    fetch(url,{headers:{"X-Requested-With":"XMLHttpRequest","X-PS-Segment":segment}})',
        '      .then(function(r){return r.ok?r.text():Promise.reject(r.status);})',
        '      .then(function(html){',
        '        el.innerHTML=html;',
        '        el.classList.add("ps-loaded");',
        '        el.dispatchEvent(new CustomEvent("ps:loaded",{bubbles:true,detail:{name:name,segment:segment}}));',
        '      })',
        '      .catch(function(){',
        '        el.classList.add("ps-fallback");',
        '        el.dispatchEvent(new CustomEvent("ps:fallback",{bubbles:true,detail:{name:name}}));',
        '      });',
        '  }',
        '  var high=[],low=[];',
        '  Object.keys(fragments).forEach(function(k){',
        '    (fragments[k].priority==="high"?high:low).push(k);',
        '  });',
        '  high.forEach(function(k){loadFragment(k,fragments[k]);});',
        '  if(typeof requestIdleCallback!=="undefined"){',
        '    requestIdleCallback(function(){low.forEach(function(k){loadFragment(k,fragments[k]);});},{timeout:3000});',
        '  } else {',
        '    setTimeout(function(){low.forEach(function(k){loadFragment(k,fragments[k]);});},300);',
        '  }',
        '})(' + fragmentJSON + ',document);',
        '</script>'
    ].join('\n');
}

// ─── A/B test support ────────────────────────────────────────────────────────

/**
 * Determines which content variant to show for an A/B test.
 * Uses a deterministic hash of the customer ID / session ID so the same
 * user always sees the same variant — no session flickering.
 *
 * @param  {string} testId       - A/B test identifier
 * @param  {string} userId       - SFCC customer ID or anonymous session ID
 * @param  {string[]} variants   - Array of variant identifiers
 * @returns {string}  Chosen variant
 */
function assignABVariant(testId, userId, variants) {
    if (!variants || !variants.length) { return null; }

    // Simple deterministic hash: sum of char codes mod variant count
    var hash = (testId + '|' + userId).split('').reduce(function (acc, ch) {
        return (acc * 31 + ch.charCodeAt(0)) & 0x7fffffff;
    }, 0);

    return variants[hash % variants.length];
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    buildShell              : buildShell,
    renderFragment          : renderFragment,
    buildFragmentLoaderScript: buildFragmentLoaderScript,
    assignABVariant         : assignABVariant,
    FRAGMENT_REGISTRY       : FRAGMENT_REGISTRY
};
