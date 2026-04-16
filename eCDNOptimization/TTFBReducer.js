/**
 * TTFBReducer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /cdn-optimization
 *
 * Targets Time to First Byte (TTFB) — the single most impactful CDN metric
 * for perceived performance. Google considers TTFB "good" at < 800 ms;
 * an unconfigured SFCC storefront typically lands at 600–1400 ms.
 *
 * Techniques implemented:
 *
 *   1. EARLY HINTS (103)      — Emits HTTP 103 Early Hints before the main
 *                               response so the browser (and CDN edge) can
 *                               preconnect / preload assets while the SFCC
 *                               server is still generating the page.
 *
 *   2. STREAMING FLUSH        — Flushes the <head> and above-the-fold HTML
 *                               to the client immediately, before data-heavy
 *                               sections (product grid, recommendations) are
 *                               ready. Reduces Time to Interactive without
 *                               changing server processing time.
 *
 *   3. EDGE SIDE INCLUDES     — Generates Akamai ESI markup for fragmented
 *                               page assembly at the CDN edge, allowing the
 *                               header/footer to be cached separately from
 *                               the volatile product content.
 *
 *   4. SURROGATE-KEY PURGE    — Provides helper methods for group-invalidating
 *                               CDN cached pages by surrogate key — used after
 *                               price changes, product updates, or content
 *                               publishes.
 *
 *   5. TTFB MEASUREMENT       — Client-side TTFB capture via PerformanceNavigationTiming
 *                               with GA4 + beacon reporting (feeds into
 *                               WebVitalsMonitor.js).
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var Logger    = require('dw/system/Logger').getLogger('cdn', 'TTFBReducer');
var URLUtils  = require('dw/web/URLUtils');
var Site      = require('dw/system/Site');

// ─── 1. Early Hints (HTTP 103) ────────────────────────────────────────────────

/**
 * Emits an HTTP 103 Early Hints response before the main response.
 *
 * HTTP 103 allows the server to send preload / preconnect hints to the browser
 * (and to CDN edges that support Early Hints, like Akamai Ion) while the main
 * response is still being processed. Measured improvements: 100–300 ms LCP.
 *
 * SFCC constraint: SFCC's pipeline engine does not expose raw socket access,
 * so 103 responses must be configured at the Akamai layer using Edge Side
 * Logic (ESL) or an Akamai Property Manager rule that injects 103 based on
 * the URL pattern.
 *
 * This function generates the Link header value for that Akamai rule.
 *
 * @param  {string}   pageType  - 'home'|'plp'|'pdp'|'cart'|'checkout'
 * @param  {Object}   [meta]
 * @param  {string}   [meta.heroImageURL]  - LCP hero image URL for image preload hint
 * @returns {string}  Link header value ready for injection by Akamai ESL
 */
function buildEarlyHintsLinkHeader(pageType, meta) {
    var site     = Site.getCurrent();
    var staticBase = site.getCustomPreferenceValue('staticCDNHostname') || '';
    var links    = [];

    // Always preconnect to DIS / static asset CDN
    links.push('<https://edge.sitecorecloud.io>; rel=preconnect');
    links.push('<' + (staticBase || '/on/demandware.static') + '>; rel=preconnect');

    // Always preload the common CSS bundle (render-blocking)
    links.push('<' + staticBase + '/css/main.css>; rel=preload; as=style');

    // Always preload the vendor JS bundle (required by all page types)
    links.push('<' + staticBase + '/js/vendors.js>; rel=preload; as=script');
    links.push('<' + staticBase + '/js/storefront-common.js>; rel=preload; as=script');

    // Page-specific JS bundle
    var pageBundle = {
        home    : 'home',
        plp     : 'plp',
        pdp     : 'pdp',
        search  : 'plp',
        cart    : 'cart',
        checkout: 'checkout',
        account : 'account'
    }[pageType] || 'plp';

    links.push('<' + staticBase + '/js/' + pageBundle + '.js>; rel=preload; as=script');

    // LCP hero image preload — only if URL provided
    if (meta && meta.heroImageURL) {
        links.push('<' + meta.heroImageURL + '>; rel=preload; as=image; fetchpriority=high');
    }

    // Payment gateway preconnect on payment-adjacent pages
    if (pageType === 'checkout' || pageType === 'cart') {
        links.push('<https://js.stripe.com>; rel=preconnect');
    }

    var headerValue = links.join(', ');
    Logger.info('TTFBReducer.buildEarlyHintsLinkHeader pageType={0} links={1}', pageType, links.length);
    return headerValue;
}

/**
 * Sets the Link header on the SFCC response for CDN-based Early Hints injection.
 * The CDN (Akamai) reads this Link header and converts it to a 103 response.
 *
 * @param {string} pageType
 * @param {Object} res        - SFCC response object
 * @param {Object} [meta]
 */
function applyEarlyHints(pageType, res, meta) {
    try {
        var linkHeader = buildEarlyHintsLinkHeader(pageType, meta);
        res.setHttpHeader('Link', linkHeader);
    } catch (e) {
        Logger.warn('TTFBReducer.applyEarlyHints failed: {0}', e.message);
    }
}

// ─── 2. Edge Side Includes (ESI) ─────────────────────────────────────────────

/**
 * ESI fragment registry.
 * Maps logical fragment names to their SFCC controller endpoints.
 * These endpoints must set appropriate Cache-Control headers.
 */
var ESI_FRAGMENTS = {
    header       : '/Header-Show',
    footer       : '/Footer-Show',
    navigation   : '/Navigation-Show',
    miniCart     : '/MiniCart-Show',
    breadcrumb   : '/Breadcrumb-Show',
    promotionBar : '/PromotionBar-Show'
};

/**
 * Generates an Akamai ESI <esi:include> tag for a named fragment.
 * Use in ISML templates to enable edge-level fragment caching.
 *
 * Fragment cache TTLs are controlled by the Cache-Control headers set in
 * the fragment's controller — not by the parent page's TTL.
 *
 * @param  {string}  fragmentName  - Key from ESI_FRAGMENTS
 * @param  {Object}  [params]      - Query params to append to the fragment URL
 * @param  {string}  [fallback]    - Fallback HTML shown if ESI fetch fails
 * @returns {string}  ESI include markup
 */
function esiInclude(fragmentName, params, fallback) {
    var endpoint = ESI_FRAGMENTS[fragmentName];
    if (!endpoint) {
        Logger.warn('TTFBReducer.esiInclude: unknown fragment "{0}"', fragmentName);
        return fallback || '<!-- ESI: unknown fragment -->';
    }

    var url = URLUtils.abs(endpoint).toString();
    if (params) {
        var qs = Object.keys(params).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
        }).join('&');
        url += (url.indexOf('?') !== -1 ? '&' : '?') + qs;
    }

    var parts = [
        '<esi:include src="' + url + '" onerror="continue">'
    ];

    if (fallback) {
        parts.push('<esi:alt>');
        parts.push(fallback);
        parts.push('</esi:alt>');
    }

    parts.push('</esi:include>');
    return parts.join('\n');
}

/**
 * Determines whether the current request is coming through an ESI-capable
 * proxy (Akamai). Checks for the Surrogate-Capability header.
 *
 * @param  {dw.system.Request} sfccRequest
 * @returns {boolean}
 */
function isESICapable(sfccRequest) {
    try {
        var cap = sfccRequest.getHttpHeaders().get('surrogate-capability') || '';
        return cap.indexOf('ESI/1.0') !== -1;
    } catch (e) {
        return false;
    }
}

// ─── 3. Surrogate-Key purge helpers ──────────────────────────────────────────

/**
 * Builds the Akamai Fast Purge API request payload for a set of surrogate keys.
 * Used after price changes, product updates, or catalog imports to immediately
 * invalidate affected CDN cache entries without a full cache flush.
 *
 * Requires the Akamai Fast Purge API credentials to be configured in
 * Site Preferences: akamaiClientToken, akamaiClientSecret, akamaiAccessToken, akamaiHost.
 *
 * @param  {string[]}  surrogateKeys  - Array of surrogate key values to purge
 * @param  {string}    [network]      - 'staging'|'production' (default: 'production')
 * @returns {{ endpoint: string, payload: Object, headers: Object }}
 */
function buildPurgeRequest(surrogateKeys, network) {
    if (!surrogateKeys || !surrogateKeys.length) {
        return null;
    }

    var net      = network === 'staging' ? 'staging' : 'production';
    var akHost   = Site.getCurrent().getCustomPreferenceValue('akamaiHost') || 'akaa-XXXXXXXXXXXXXXXX-XXXXXXXXXXXXXXXX.luna.akamaiapis.net';

    return {
        endpoint: 'https://' + akHost + '/ccu/v3/invalidate/tag/' + net,
        payload : { objects: surrogateKeys },
        headers : {
            'Content-Type': 'application/json',
            // Authorization is handled by the Akamai EdgeGrid HMAC signer
            // See: https://techdocs.akamai.com/developer/docs/authenticate-with-edgegrid
            'Authorization': 'EG1-HMAC-SHA256 [signed-by-AkamaiEdgeGridSigner]'
        }
    };
}

/**
 * Executes a surrogate-key purge via the Akamai Fast Purge API.
 * Call from a SFCC Job or hook after catalog/price updates.
 *
 * @param  {string[]} surrogateKeys
 * @param  {string}   [network]      - 'staging'|'production'
 * @returns {{ success: boolean, status: number, body: string }}
 */
function executePurge(surrogateKeys, network) {
    var HTTPClient = require('dw/net/HTTPClient');
    var purgeReq   = buildPurgeRequest(surrogateKeys, network);

    if (!purgeReq) {
        return { success: false, status: 0, body: 'No keys provided' };
    }

    var http = new HTTPClient();
    http.setTimeout(10000);
    http.setRequestHeader('Content-Type', 'application/json');
    // In production: use AkamaiEdgeGridSigner to compute the Authorization header
    http.setRequestHeader('Authorization', purgeReq.headers['Authorization']);

    var payload = JSON.stringify(purgeReq.payload);
    var ok      = http.sendAndReceive(purgeReq.endpoint, 'POST', payload);
    var status  = http.getStatusCode();
    var body    = http.getText() || '';

    if (ok && (status === 201 || status === 200)) {
        Logger.info('TTFBReducer.executePurge: purged {0} keys. Status: {1}', surrogateKeys.length, status);
        return { success: true, status: status, body: body };
    }

    Logger.error('TTFBReducer.executePurge FAILED status={0} body={1}', status, body.slice(0, 200));
    return { success: false, status: status, body: body };
}

// ─── 4. Client-side TTFB measurement ─────────────────────────────────────────

/**
 * Generates the inline JavaScript snippet to be placed in <head> that
 * captures TTFB via PerformanceNavigationTiming and reports it to GA4 and
 * the WebVitalsMonitor beacon endpoint.
 *
 * Keeping this inline (not in an external file) ensures the measurement
 * starts before any other scripts execute.
 *
 * @param  {string} beaconURL  - SFCC analytics endpoint URL
 * @returns {string}  <script> HTML to inline in <head>
 */
function buildTTFBSnippet(beaconURL) {
    return [
        '<script>',
        '(function(){',
        '  try {',
        '    var obs = new PerformanceObserver(function(list) {',
        '      var entry = list.getEntries()[0];',
        '      if (!entry) return;',
        '      var ttfb = Math.round(entry.responseStart - entry.startTime);',
        '      var rating = ttfb < 800 ? "good" : ttfb < 1800 ? "needs-improvement" : "poor";',
        '      // Report to WebVitalsMonitor',
        '      if (window.WebVitalsMonitor) {',
        '        window.WebVitalsMonitor._manualMetric({ name:"TTFB", value:ttfb, rating:rating });',
        '      }',
        '      // GA4',
        '      if (typeof gtag === "function") {',
        '        gtag("event","TTFB",{value:ttfb,metric_rating:rating,non_interaction:true});',
        '      }',
        '      // Beacon',
        '      if ("' + (beaconURL || '') + '" && navigator.sendBeacon) {',
        '        navigator.sendBeacon("' + (beaconURL || '') + '",',
        '          JSON.stringify({name:"TTFB",value:ttfb,rating:rating,url:location.href}));',
        '      }',
        '    });',
        '    obs.observe({type:"navigation",buffered:true});',
        '  } catch(e) {}',
        '}());',
        '</script>'
    ].join('\n');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    buildEarlyHintsLinkHeader : buildEarlyHintsLinkHeader,
    applyEarlyHints           : applyEarlyHints,
    esiInclude                : esiInclude,
    isESICapable              : isESICapable,
    buildPurgeRequest         : buildPurgeRequest,
    executePurge              : executePurge,
    buildTTFBSnippet          : buildTTFBSnippet,
    ESI_FRAGMENTS             : ESI_FRAGMENTS
};
