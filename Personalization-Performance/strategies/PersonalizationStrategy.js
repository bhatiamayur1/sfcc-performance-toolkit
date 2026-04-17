/**
 * PersonalizationStrategy.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /personalization-performance/strategies
 *
 * Performance-first personalization engine for SFCC. Solves the central
 * tension of personalization: the more you personalize, the harder it is
 * to cache, and the harder it is to cache, the slower every page becomes.
 *
 * Core insight — the "Personalization Performance Matrix":
 *
 *   ┌─────────────────────┬──────────────────────┬────────────────────────┐
 *   │ Content type        │ Caching approach      │ Delivery method        │
 *   ├─────────────────────┼──────────────────────┼────────────────────────┤
 *   │ Fully anonymous     │ Full-page CDN cache   │ CDN edge (< 5ms)       │
 *   │ Segment-based       │ N cached variants     │ Edge with Vary header  │
 *   │ Attribute-based     │ Shell + fragment API  │ ESI / client fetch     │
 *   │ Individual-based    │ Never cache           │ SSR per request        │
 *   └─────────────────────┴──────────────────────┴────────────────────────┘
 *
 * This module classifies every content request into one of these tiers
 * and routes it to the appropriate delivery mechanism.
 *
 * Usage:
 *   var PSEngine = require('*/cartridge/scripts/personalization/PersonalizationStrategy');
 *
 *   var tier = PSEngine.classify(customer, request);
 *   var config = PSEngine.getDeliveryConfig(tier);
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var CacheMgr  = require('dw/system/CacheMgr');
var Site      = require('dw/system/Site');
var Logger    = require('dw/system/Logger').getLogger('personalization', 'PSEngine');

// ─── Personalization tiers ────────────────────────────────────────────────────

var TIER = {
    ANONYMOUS  : 'ANONYMOUS',   // No personalization — full-page cache
    SEGMENT    : 'SEGMENT',     // Segment-based — N cached variants
    ATTRIBUTE  : 'ATTRIBUTE',   // Profile attributes — shell + API fragments
    INDIVIDUAL : 'INDIVIDUAL'   // Unique per user — never cache
};

// ─── Customer segments ────────────────────────────────────────────────────────

/**
 * The finite set of customer segments used for SEGMENT-tier caching.
 * Keep this list small (< 20) — each segment multiplies your cache space.
 * Large segment counts destroy cache efficiency.
 */
var SEGMENTS = {
    NEW_VISITOR    : 'new-visitor',
    RETURNING      : 'returning',
    LOYAL          : 'loyal',            // 5+ orders
    VIP            : 'vip',              // High LTV customer group
    SALE_HUNTER    : 'sale-hunter',      // Clicks sale content heavily
    ABANDONER      : 'abandoner',        // Cart abandoner (last 7 days)
    REACTIVATION   : 'reactivation',     // Was loyal, not bought in 90+ days
    WHOLESALE      : 'wholesale',        // B2B customer group
    STAFF          : 'staff',            // Employee discount group
    ANONYMOUS      : 'anonymous'         // Not logged in
};

// ─── Segment classifier ───────────────────────────────────────────────────────

/**
 * Classifies a SFCC customer into a single segment.
 * Segments are mutually exclusive and ordered by specificity.
 *
 * @param  {dw.customer.Customer} customer
 * @returns {string}  One of SEGMENTS values
 */
function classifySegment(customer) {
    if (!customer || !customer.isAuthenticated()) { return SEGMENTS.ANONYMOUS; }

    var profile    = customer.getProfile();
    var groups     = customer.getCustomerGroups().toArray().map(function (g) { return g.getID(); });
    var orderCount = profile ? (profile.getCustom().orderCount || 0) : 0;

    // High-specificity checks first
    if (groups.indexOf('Staff') !== -1)      { return SEGMENTS.STAFF; }
    if (groups.indexOf('Wholesale') !== -1)  { return SEGMENTS.WHOLESALE; }
    if (groups.indexOf('VIP') !== -1)        { return SEGMENTS.VIP; }

    // Behaviour-based
    if (orderCount >= 5) {
        var lastOrderDays = profile && profile.getCustom().daysSinceLastOrder;
        if (lastOrderDays && lastOrderDays > 90) { return SEGMENTS.REACTIVATION; }
        return SEGMENTS.LOYAL;
    }

    if (orderCount > 0) {
        var cartAbandonedAt = profile && profile.getCustom().lastCartAbandonedAt;
        if (cartAbandonedAt) {
            var abandonDays = Math.floor((Date.now() - cartAbandonedAt) / 86400000);
            if (abandonDays <= 7) { return SEGMENTS.ABANDONER; }
        }
        return SEGMENTS.RETURNING;
    }

    return SEGMENTS.NEW_VISITOR;
}

// ─── Tier classifier ──────────────────────────────────────────────────────────

/**
 * Classifies a page request into a personalization tier.
 * The tier determines caching strategy and delivery mechanism.
 *
 * @param  {dw.customer.Customer} customer
 * @param  {dw.system.Request}    sfccRequest
 * @param  {Object}               [opts]
 * @param  {boolean}              [opts.hasBasket]    - Non-empty basket present
 * @param  {string}               [opts.pageType]     - 'home'|'plp'|'pdp'|'cart'|'checkout'
 * @returns {{ tier: string, segment: string, reason: string }}
 */
function classify(customer, sfccRequest, opts) {
    var options  = opts || {};
    var pageType = options.pageType || 'unknown';

    // Cart/checkout — always individual (session-specific data)
    if (pageType === 'cart' || pageType === 'checkout') {
        return { tier: TIER.INDIVIDUAL, segment: null, reason: 'session-specific page' };
    }

    // Authenticated with VIP/wholesale group — attribute tier (price-book specific)
    if (customer && customer.isAuthenticated()) {
        var groups = customer.getCustomerGroups().toArray().map(function (g) { return g.getID(); });
        if (groups.indexOf('VIP') !== -1 || groups.indexOf('Wholesale') !== -1) {
            return { tier: TIER.ATTRIBUTE, segment: classifySegment(customer), reason: 'price-sensitive group' };
        }

        // Non-empty basket — content depends on basket state
        if (options.hasBasket) {
            return { tier: TIER.ATTRIBUTE, segment: classifySegment(customer), reason: 'active basket' };
        }

        // Authenticated but segment-safe — use SEGMENT tier
        var segment = classifySegment(customer);
        return { tier: TIER.SEGMENT, segment: segment, reason: 'authenticated, segment-safe' };
    }

    // Anonymous — full-page cache (best performance)
    return { tier: TIER.ANONYMOUS, segment: SEGMENTS.ANONYMOUS, reason: 'anonymous visitor' };
}

// ─── Delivery configuration per tier ─────────────────────────────────────────

/**
 * Returns the optimal delivery configuration for a personalization tier.
 *
 * @param  {string} tier   - One of TIER values
 * @param  {string} [segment]
 * @returns {{
 *   cacheStrategy: string,
 *   edgeTTL: number,
 *   browserTTL: number,
 *   varyHeaders: string[],
 *   surrogateKeyPrefix: string,
 *   fragmentEndpoints: string[],
 *   esiEnabled: boolean,
 *   preloadFragments: string[]
 * }}
 */
function getDeliveryConfig(tier, segment) {
    switch (tier) {
        case TIER.ANONYMOUS:
            return {
                cacheStrategy      : 'full-page',
                edgeTTL            : 600,        // 10 min — full-page CDN cache
                browserTTL         : 0,
                varyHeaders        : ['Accept-Encoding', 'Accept-Language'],
                surrogateKeyPrefix : 'anon',
                fragmentEndpoints  : [],
                esiEnabled         : false,
                preloadFragments   : []
            };

        case TIER.SEGMENT:
            return {
                cacheStrategy      : 'segmented',
                edgeTTL            : 300,        // 5 min — per-segment variant cached
                browserTTL         : 0,
                varyHeaders        : ['X-Customer-Segment', 'Accept-Encoding'],
                surrogateKeyPrefix : 'seg:' + (segment || 'unknown'),
                fragmentEndpoints  : ['/api/personalization/hero', '/api/personalization/promotions'],
                esiEnabled         : true,
                preloadFragments   : ['hero']
            };

        case TIER.ATTRIBUTE:
            return {
                cacheStrategy      : 'shell-fragments',
                edgeTTL            : 300,        // 5 min for the page shell
                browserTTL         : 0,
                varyHeaders        : ['X-Customer-Segment', 'Accept-Encoding'],
                surrogateKeyPrefix : 'attr:' + (segment || 'unknown'),
                fragmentEndpoints  : [
                    '/api/personalization/pricing',
                    '/api/personalization/hero',
                    '/api/personalization/promotions',
                    '/api/personalization/recommendations'
                ],
                esiEnabled         : true,
                preloadFragments   : ['hero', 'pricing']
            };

        case TIER.INDIVIDUAL:
        default:
            return {
                cacheStrategy      : 'no-cache',
                edgeTTL            : 0,
                browserTTL         : 0,
                varyHeaders        : [],
                surrogateKeyPrefix : null,
                fragmentEndpoints  : [],
                esiEnabled         : false,
                preloadFragments   : []
            };
    }
}

// ─── Segment cookie helpers ───────────────────────────────────────────────────

/**
 * Reads the segment from the request cookie — set client-side to avoid
 * adding the customer classification to the server hot path.
 *
 * @param  {dw.system.Request} sfccRequest
 * @returns {string|null}
 */
function readSegmentFromCookie(sfccRequest) {
    try {
        var cookies = sfccRequest.getHttpCookies();
        var cookie  = cookies.get('sfcc_segment');
        return cookie ? cookie.getValue() : null;
    } catch (e) {
        return null;
    }
}

/**
 * Generates the Set-Cookie header value for persisting the segment.
 * 24-hour expiry — recomputed on next login/session.
 *
 * @param  {string} segment
 * @returns {string}  Header value
 */
function buildSegmentCookie(segment) {
    return 'sfcc_segment=' + segment +
           '; Path=/; Max-Age=86400; SameSite=Lax; Secure';
}

// ─── Performance metrics ──────────────────────────────────────────────────────

/**
 * Records personalization tier usage for monitoring.
 * Used to understand what % of traffic is hitting each cache tier.
 *
 * @param {string} tier
 * @param {string} pageType
 */
function recordTierUsage(tier, pageType) {
    var key = 'ps_tier_' + tier + '_' + pageType;
    try {
        var entry = CacheMgr.get(key) || { count: 0 };
        entry.count++;
        CacheMgr.put(key, entry, 3600);
    } catch (e) { /* non-fatal */ }
}

/**
 * Returns tier usage statistics for the monitoring dashboard.
 * @returns {Object}
 */
function getTierStats() {
    var tiers     = Object.values(TIER);
    var pageTypes = ['home', 'plp', 'pdp', 'search', 'cart', 'checkout'];
    var stats     = {};

    tiers.forEach(function (tier) {
        stats[tier] = {};
        pageTypes.forEach(function (pt) {
            try {
                var entry = CacheMgr.get('ps_tier_' + tier + '_' + pt);
                stats[tier][pt] = entry ? entry.count : 0;
            } catch (e) {
                stats[tier][pt] = 0;
            }
        });
    });

    return stats;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    classify              : classify,
    classifySegment       : classifySegment,
    getDeliveryConfig     : getDeliveryConfig,
    readSegmentFromCookie : readSegmentFromCookie,
    buildSegmentCookie    : buildSegmentCookie,
    recordTierUsage       : recordTierUsage,
    getTierStats          : getTierStats,
    TIER                  : TIER,
    SEGMENTS              : SEGMENTS
};
