/**
 * CacheHeadersManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /cdn-optimization
 *
 * Applies the correct HTTP cache headers to every SFCC response type so that
 * Akamai (or any CDN in front of your storefront) can cache aggressively while
 * still delivering fresh content when it matters.
 *
 * Header strategy overview:
 *
 *   Asset type               │ Cache-Control                       │ TTL
 *   ─────────────────────────┼─────────────────────────────────────┼──────────
 *   Hashed JS/CSS bundles    │ public, max-age=31536000, immutable │ 1 year
 *   DIS images (versioned)   │ public, max-age=86400, s-maxage=... │ 24 h edge
 *   Static fonts             │ public, max-age=31536000, immutable │ 1 year
 *   PLP (anonymous)          │ public, s-maxage=600               │ 10 min edge
 *   PDP (anonymous)          │ public, s-maxage=300               │ 5 min edge
 *   PDP (authenticated)      │ private, no-store                  │ never
 *   API / AJAX responses     │ private, no-cache                  │ never
 *   Cart / Checkout          │ private, no-store                  │ never
 *
 * Usage (in a SFCC pipeline / controller):
 *   var CHM = require('*/cartridge/scripts/cdn/CacheHeadersManager');
 *   CHM.applyPageHeaders('plp', res, { authenticated: customer.isAuthenticated() });
 *
 *   // Or for a static asset response:
 *   CHM.applyAssetHeaders('js-hashed', res);
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var Logger = require('dw/system/Logger').getLogger('cdn', 'CacheHeadersManager');

// ─── Header profiles ──────────────────────────────────────────────────────────

/**
 * Complete cache header profiles.
 * Keys are logical names used throughout the codebase.
 *
 * Fields:
 *   cacheControl  {string}    — value for Cache-Control header
 *   vary          {string[]}  — list of Vary header tokens
 *   surrogateKey  {string}    — Akamai / Fastly surrogate-key tag for group purging
 *   edgeTTL       {number}    — CDN cache TTL in seconds (s-maxage or Surrogate-Control)
 *   browserTTL    {number}    — Browser cache TTL in seconds (max-age)
 */
var PROFILES = {

    // ── Static assets (content-hashed filenames) ──────────────────────────

    'js-hashed': {
        cacheControl: 'public, max-age=31536000, immutable',
        vary        : [],
        surrogateKey: 'static-js',
        edgeTTL     : 31536000,
        browserTTL  : 31536000
    },

    'css-hashed': {
        cacheControl: 'public, max-age=31536000, immutable',
        vary        : [],
        surrogateKey: 'static-css',
        edgeTTL     : 31536000,
        browserTTL  : 31536000
    },

    'font': {
        cacheControl: 'public, max-age=31536000, immutable',
        vary        : [],
        surrogateKey: 'static-font',
        edgeTTL     : 31536000,
        browserTTL  : 31536000
    },

    // ── SFCC DIS images ───────────────────────────────────────────────────

    'dis-image': {
        // s-maxage overrides max-age at the CDN; browser gets a shorter TTL
        cacheControl: 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600',
        vary        : ['Accept'],   // Vary on Accept so WebP and JPEG are cached separately
        surrogateKey: 'dis-image',
        edgeTTL     : 86400,
        browserTTL  : 3600
    },

    'dis-image-editorial': {
        // Editorial images change only on content publish → longer TTL
        cacheControl: 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
        vary        : ['Accept'],
        surrogateKey: 'dis-editorial',
        edgeTTL     : 604800,       // 7 days
        browserTTL  : 86400
    },

    // ── HTML pages (anonymous) ────────────────────────────────────────────

    'page-home': {
        cacheControl: 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
        vary        : ['Accept-Encoding', 'Accept-Language'],
        surrogateKey: 'page-home',
        edgeTTL     : 300,
        browserTTL  : 0
    },

    'page-plp': {
        cacheControl: 'public, max-age=0, s-maxage=600, stale-while-revalidate=120',
        vary        : ['Accept-Encoding', 'Accept-Language'],
        surrogateKey: 'page-plp',
        edgeTTL     : 600,
        browserTTL  : 0
    },

    'page-pdp': {
        cacheControl: 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
        vary        : ['Accept-Encoding', 'Accept-Language'],
        surrogateKey: 'page-pdp',
        edgeTTL     : 300,
        browserTTL  : 0
    },

    'page-search': {
        cacheControl: 'public, max-age=0, s-maxage=180, stale-while-revalidate=60',
        vary        : ['Accept-Encoding', 'Accept-Language'],
        surrogateKey: 'page-search',
        edgeTTL     : 180,
        browserTTL  : 0
    },

    // ── HTML pages (authenticated / personalised) — never cached at CDN ──

    'page-authenticated': {
        cacheControl: 'private, no-cache, no-store, must-revalidate',
        vary        : [],
        surrogateKey: null,
        edgeTTL     : 0,
        browserTTL  : 0
    },

    // ── Checkout, cart — absolute no-cache ────────────────────────────────

    'page-cart': {
        cacheControl: 'private, no-store',
        vary        : [],
        surrogateKey: null,
        edgeTTL     : 0,
        browserTTL  : 0
    },

    'page-checkout': {
        cacheControl: 'private, no-store',
        vary        : [],
        surrogateKey: null,
        edgeTTL     : 0,
        browserTTL  : 0
    },

    // ── AJAX / API responses ──────────────────────────────────────────────

    'api-private': {
        cacheControl: 'private, no-cache',
        vary        : [],
        surrogateKey: null,
        edgeTTL     : 0,
        browserTTL  : 0
    },

    'api-public': {
        // Used for cacheable JSON fragments (e.g. navigation, promotions)
        cacheControl: 'public, max-age=0, s-maxage=120, stale-while-revalidate=60',
        vary        : ['Accept-Encoding', 'Accept-Language'],
        surrogateKey: 'api-fragment',
        edgeTTL     : 120,
        browserTTL  : 0
    }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Selects the correct page profile for the current request context.
 *
 * @param  {string}  pageType       - Logical page type key
 * @param  {Object}  ctx
 * @param  {boolean} ctx.authenticated - Is the current session authenticated?
 * @param  {boolean} ctx.hasBasket     - Does the session have a non-empty basket?
 * @returns {string} Profile key
 */
function resolvePageProfile(pageType, ctx) {
    if (ctx.authenticated || ctx.hasBasket) {
        return 'page-authenticated';
    }
    var profileKey = 'page-' + pageType;
    return PROFILES[profileKey] ? profileKey : 'page-plp';
}

/**
 * Applies headers from a profile to a SFCC response object.
 *
 * @param {Object}  profile  - Profile object from PROFILES
 * @param {Object}  res      - SFCC response object (dw.system.Response)
 * @param {Object}  [meta]   - Extra Surrogate-Key values to tag (for group purging)
 */
function applyHeaders(profile, res, meta) {
    if (!res || !profile) { return; }

    res.setHttpHeader('Cache-Control', profile.cacheControl);

    if (profile.vary && profile.vary.length > 0) {
        res.setHttpHeader('Vary', profile.vary.join(', '));
    }

    if (profile.surrogateKey) {
        var keys = [profile.surrogateKey];

        // Append entity-specific surrogate keys for fine-grained CDN purging
        if (meta && meta.productID)  { keys.push('product-' + meta.productID); }
        if (meta && meta.categoryID) { keys.push('category-' + meta.categoryID); }
        if (meta && meta.locale)     { keys.push('locale-' + meta.locale); }

        // Akamai uses Edge-Control; Fastly uses Surrogate-Key
        res.setHttpHeader('Surrogate-Key', keys.join(' '));
        res.setHttpHeader('Edge-Control',  'max-age=' + profile.edgeTTL);
    }

    // Timing-Allow-Origin: lets the browser report real CDN timing via Resource Timing API
    res.setHttpHeader('Timing-Allow-Origin', '*');

    Logger.info('CacheHeadersManager: applied profile "{0}" — {1}', profile.cacheControl);
}

// ─── Public API ───────────────────────────────────────────────────────────────

var CacheHeadersManager = {

    /**
     * Applies cache headers for an HTML page response.
     *
     * @param {string}  pageType  - 'home'|'plp'|'pdp'|'search'|'cart'|'checkout'
     * @param {Object}  res       - SFCC response object
     * @param {Object}  [ctx]     - Context flags
     * @param {boolean} [ctx.authenticated]
     * @param {boolean} [ctx.hasBasket]
     * @param {string}  [ctx.productID]   - For Surrogate-Key tagging on PDP
     * @param {string}  [ctx.categoryID]  - For Surrogate-Key tagging on PLP
     * @param {string}  [ctx.locale]
     */
    applyPageHeaders: function (pageType, res, ctx) {
        var context     = ctx || {};
        var profileKey  = resolvePageProfile(pageType, context);
        var profile     = PROFILES[profileKey];

        applyHeaders(profile, res, context);
        return profile;
    },

    /**
     * Applies cache headers for a static asset response.
     *
     * @param {string} assetType  - Profile key (e.g. 'js-hashed', 'dis-image', 'font')
     * @param {Object} res        - SFCC response object
     */
    applyAssetHeaders: function (assetType, res) {
        var profile = PROFILES[assetType];
        if (!profile) {
            Logger.warn('CacheHeadersManager.applyAssetHeaders: unknown asset type "{0}"', assetType);
            profile = PROFILES['api-private'];  // Fail safe: no-cache
        }
        applyHeaders(profile, res, null);
        return profile;
    },

    /**
     * Applies headers for a public cacheable API/AJAX fragment.
     * @param {Object} res
     * @param {number} [edgeTTL]  - Override default edge TTL (seconds)
     */
    applyFragmentHeaders: function (res, edgeTTL) {
        var profile = Object.assign({}, PROFILES['api-public']);
        if (edgeTTL) {
            profile.edgeTTL      = edgeTTL;
            profile.cacheControl = 'public, max-age=0, s-maxage=' + edgeTTL + ', stale-while-revalidate=' + Math.round(edgeTTL / 4);
        }
        applyHeaders(profile, res, null);
        return profile;
    },

    /**
     * Applies private no-store headers — safe fallback for any personalised response.
     * @param {Object} res
     */
    applyPrivateHeaders: function (res) {
        applyHeaders(PROFILES['page-authenticated'], res, null);
    },

    /**
     * Returns the profile for external inspection / testing without modifying a response.
     * @param  {string} profileKey
     * @returns {Object|null}
     */
    getProfile: function (profileKey) {
        return PROFILES[profileKey] || null;
    },

    PROFILES: PROFILES
};

module.exports = CacheHeadersManager;
