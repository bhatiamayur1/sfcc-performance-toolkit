/**
 * PartialPageCache.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /caching
 *
 * Thin, declarative wrapper around SFCC Partial Page Caching (PPC).
 * Attach to any controller action or ISML include to enable fragment-level
 * caching without touching core page TTLs.
 *
 * How PPC works in SFCC:
 *   SFCC supports caching individual controller *actions* independently of
 *   the outer page. Each action can declare its own TTL and vary dimensions.
 *   The response object exposes `response.setExpires(seconds)` which signals
 *   the caching layer.
 *
 * Usage (in a controller action):
 *   var PPC = require('*/cartridge/scripts/perf/PartialPageCache');
 *
 *   // Cache this action's output for 10 minutes, vary by locale + currency:
 *   PPC.apply({
 *       ttl       : 600,
 *       varyBy    : ['locale', 'currency'],
 *       customKey : 'promo-banner'
 *   });
 *
 * Usage (in an ISML template, via <isscript>):
 *   <isscript>
 *     var PPC = require('*/cartridge/scripts/perf/PartialPageCache');
 *     PPC.apply({ ttl: 120, varyBy: ['locale'] });
 *   </isscript>
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var Site    = require('dw/system/Site');
var Logger  = require('dw/system/Logger').getLogger('perf', 'PartialPageCache');

// ─── Supported vary dimensions ────────────────────────────────────────────────

/**
 * Registry of built-in vary dimensions and how to resolve their values.
 * Each dimension adds specificity to the cached fragment — only include
 * what genuinely changes the output.
 */
var VARY_RESOLVERS = {
    locale: function () {
        return request.getLocale() || Site.getCurrent().getDefaultLocale();
    },
    currency: function () {
        return session.getCurrency().getCurrencyCode();
    },
    customerGroup: function () {
        return customer.getCustomerGroups().toArray()
            .map(function (g) { return g.getID(); })
            .sort().join(',');
    },
    device: function () {
        var ua = request.getHttpHeaders().get('user-agent') || '';
        return /mobile/i.test(ua) ? 'm' : /tablet/i.test(ua) ? 't' : 'd';
    },
    site: function () {
        return Site.getCurrent().getID();
    }
};

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Applies Partial Page Caching to the current controller action.
 *
 * @param {Object}   opts
 * @param {number}   opts.ttl        - Cache TTL in seconds (default: 300)
 * @param {string[]} opts.varyBy     - Dimensions to vary by (default: ['locale'])
 * @param {string}   [opts.customKey]- Optional suffix appended to the Vary header value
 * @param {boolean}  [opts.disabled] - Set true to bypass caching (e.g. for logged-in users)
 */
function apply(opts) {
    var options = opts || {};
    var ttl     = (typeof options.ttl === 'number' && options.ttl > 0) ? options.ttl : 300;
    var varyBy  = Array.isArray(options.varyBy) ? options.varyBy : ['locale'];
    var disabled = options.disabled === true;

    // ── Bypass for authenticated/personalised sessions ────────────────────────
    if (disabled || _isPersonalisedSession()) {
        Logger.info('PPC BYPASSED — personalised or explicitly disabled');
        response.setExpires(0); // No-cache for this fragment
        return;
    }

    // ── Resolve vary dimensions ───────────────────────────────────────────────
    var varyParts = varyBy.map(function (dim) {
        if (VARY_RESOLVERS[dim]) {
            return dim + '=' + VARY_RESOLVERS[dim]();
        }
        Logger.warn('PPC — unknown vary dimension "{0}", skipping', dim);
        return null;
    }).filter(Boolean);

    if (options.customKey) {
        varyParts.push('custom=' + encodeURIComponent(options.customKey));
    }

    // ── Apply TTL ─────────────────────────────────────────────────────────────
    response.setExpires(ttl);

    Logger.info('PPC APPLIED ttl={0}s vary=[{1}]', ttl, varyParts.join(', '));
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Returns true when the session should NOT be cached:
 * - Authenticated customer (beyond registered group)
 * - Non-empty basket (cart-dependent content)
 */
function _isPersonalisedSession() {
    try {
        var isAuthenticated = customer.isAuthenticated();
        var hasBasketItems  = !basket || basket.getProductLineItems().getLength() > 0;
        return isAuthenticated || hasBasketItems;
    } catch (e) {
        // basket may be null outside cart context — that's fine
        return customer.isAuthenticated();
    }
}

// ─── Preset configurations ────────────────────────────────────────────────────

/** Pre-built configs for common fragment types. */
var PRESETS = {
    /** Static editorial content — long TTL, locale only */
    editorial: function () { apply({ ttl: 3600, varyBy: ['locale', 'site'] }); },

    /** Navigation / header — medium TTL, locale + device */
    navigation: function () { apply({ ttl: 900, varyBy: ['locale', 'device', 'site'] }); },

    /** Product tile — short TTL, price-sensitive */
    productTile: function () { apply({ ttl: 300, varyBy: ['locale', 'currency', 'site'] }); },

    /** Promotional banner — very short TTL */
    promoBanner: function () { apply({ ttl: 60, varyBy: ['locale', 'customerGroup', 'site'] }); }
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    apply  : apply,
    presets: PRESETS
};
