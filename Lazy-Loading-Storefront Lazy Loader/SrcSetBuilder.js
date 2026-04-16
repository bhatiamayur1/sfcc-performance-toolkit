/**
 * SrcSetBuilder.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /lazy-loading
 *
 * Generates responsive `srcset` and `sizes` attribute strings for SFCC
 * Dynamic Imaging Service (DIS) URLs.
 *
 * SFCC DIS supports URL-based image transformations. By appending parameters
 * such as `sw` (scene7 width), `sh` (height), and `q` (quality) to a DIS URL,
 * we can serve correctly-sized images at every breakpoint without storing
 * multiple source files.
 *
 * Usage (in an ISML template or controller):
 *   <isscript>
 *     var SrcSetBuilder = require('*/cartridge/scripts/perf/SrcSetBuilder');
 *   </isscript>
 *
 *   <img
 *     class="lazy-img"
 *     src="${pdict.product.images.small[0].url}"
 *     data-srcset="${SrcSetBuilder.product(pdict.product.images.large[0].url)}"
 *     data-sizes="${SrcSetBuilder.sizes('product-tile')}"
 *     alt="${pdict.product.name}"
 *   />
 *
 * Alternatively, use in a client-side context where DIS URLs are available:
 *   var srcset = SrcSetBuilder.build(baseURL, [400, 800, 1200], { q: 80 });
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─── DIS parameter map ────────────────────────────────────────────────────────

/**
 * DIS URL parameter names.
 * These are Scene7 / SFCC DIS conventions.
 */
var DIS_PARAMS = {
    width  : 'sw',
    height : 'sh',
    quality: 'q',
    format : 'fmt',
    crop   : 'crop'
};

// ─── Breakpoint presets ───────────────────────────────────────────────────────

/**
 * Width breakpoints (pixels) used for srcset generation.
 * Maps logical preset name → array of widths.
 */
var BREAKPOINT_PRESETS = {
    'product-tile'  : [200, 400, 600],
    'product-detail': [400, 800, 1200, 1600],
    'hero-banner'   : [600, 900, 1200, 1800, 2400],
    'thumbnail'     : [80, 160, 240],
    'category-tile' : [300, 600, 900]
};

/**
 * Sizes attribute presets — tells the browser which image width to request
 * at each viewport width. Keep in sync with your SCSS breakpoints.
 */
var SIZES_PRESETS = {
    'product-tile'  : '(max-width: 544px) 50vw, (max-width: 992px) 33vw, 25vw',
    'product-detail': '(max-width: 544px) 100vw, (max-width: 992px) 50vw, 40vw',
    'hero-banner'   : '100vw',
    'thumbnail'     : '80px',
    'category-tile' : '(max-width: 544px) 50vw, 33vw'
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strips existing DIS query parameters from a base URL so we can reapply them
 * cleanly. Removes sw, sh, q, fmt, and crop parameters.
 *
 * @param  {string} url
 * @returns {string} Clean base URL without DIS params
 */
function stripDISParams(url) {
    if (!url) { return ''; }
    var disKeys = Object.values ? Object.values(DIS_PARAMS) : ['sw', 'sh', 'q', 'fmt', 'crop'];
    var regex   = new RegExp('[&?](' + disKeys.join('|') + ')=[^&]*', 'g');
    return url.replace(regex, '').replace(/[?&]$/, '');
}

/**
 * Appends DIS parameters to a URL, handling existing query strings.
 *
 * @param  {string} baseURL
 * @param  {Object} params   - { sw, sh, q, fmt, ... }
 * @returns {string}
 */
function appendDISParams(baseURL, params) {
    var clean    = stripDISParams(baseURL);
    var hasQuery = clean.indexOf('?') !== -1;
    var parts    = [];

    Object.keys(params).forEach(function (key) {
        if (params[key] !== null && params[key] !== undefined) {
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
        }
    });

    if (!parts.length) { return clean; }
    return clean + (hasQuery ? '&' : '?') + parts.join('&');
}

// ─── Public API ───────────────────────────────────────────────────────────────

var SrcSetBuilder = {

    /**
     * Builds a `srcset` attribute string for a given DIS image URL.
     *
     * @param  {string}   baseURL   - DIS image URL (may already have params)
     * @param  {number[]} widths    - Array of widths in pixels
     * @param  {Object}   [opts]    - Additional DIS params ({ q, fmt, etc. })
     * @returns {string} Ready-to-use srcset attribute value
     *
     * @example
     * SrcSetBuilder.build('https://cdn.example.com/img.jpg', [400, 800, 1200], { q: 80 })
     * // → "https://cdn.example.com/img.jpg?sw=400&q=80 400w, ...?sw=800&q=80 800w, ..."
     */
    build: function (baseURL, widths, opts) {
        if (!baseURL || !Array.isArray(widths) || !widths.length) { return ''; }

        var defaults = { q: 80, fmt: 'jpg' };
        var options  = Object.assign({}, defaults, opts || {});

        return widths.map(function (w) {
            var params = Object.assign({}, options, { sw: w });
            // Remove height (sh) if not explicitly set — let DIS maintain aspect ratio
            if (!opts || opts.sh === undefined) { delete params.sh; }
            return appendDISParams(baseURL, params) + ' ' + w + 'w';
        }).join(', ');
    },

    /**
     * Builds srcset using a named breakpoint preset.
     *
     * @param  {string} baseURL
     * @param  {string} preset    - Key from BREAKPOINT_PRESETS
     * @param  {Object} [opts]    - DIS param overrides
     * @returns {string}
     */
    preset: function (baseURL, preset, opts) {
        var widths = BREAKPOINT_PRESETS[preset];
        if (!widths) {
            throw new Error('[SrcSetBuilder] Unknown preset "' + preset + '". ' +
                'Available: ' + Object.keys(BREAKPOINT_PRESETS).join(', '));
        }
        return SrcSetBuilder.build(baseURL, widths, opts);
    },

    /**
     * Convenience: product tile srcset (200w, 400w, 600w @ q=80).
     * @param  {string} baseURL
     * @returns {string}
     */
    productTile: function (baseURL) {
        return SrcSetBuilder.preset(baseURL, 'product-tile');
    },

    /**
     * Convenience: PDP main image srcset (400w → 1600w @ q=85).
     * @param  {string} baseURL
     * @returns {string}
     */
    productDetail: function (baseURL) {
        return SrcSetBuilder.preset(baseURL, 'product-detail', { q: 85 });
    },

    /**
     * Convenience: hero banner srcset (full-bleed responsive).
     * @param  {string} baseURL
     * @returns {string}
     */
    heroBanner: function (baseURL) {
        return SrcSetBuilder.preset(baseURL, 'hero-banner', { q: 85 });
    },

    /**
     * Returns the `sizes` attribute string for a given preset name.
     * @param  {string} preset
     * @returns {string}
     */
    sizes: function (preset) {
        return SIZES_PRESETS[preset] || '100vw';
    },

    /**
     * Adds a custom breakpoint preset at runtime.
     * @param {string}   name
     * @param {number[]} widths
     * @param {string}   sizesAttr
     */
    registerPreset: function (name, widths, sizesAttr) {
        BREAKPOINT_PRESETS[name] = widths;
        if (sizesAttr) { SIZES_PRESETS[name] = sizesAttr; }
    },

    /** Exposed for testing */
    _stripDISParams  : stripDISParams,
    _appendDISParams : appendDISParams,
    BREAKPOINT_PRESETS: BREAKPOINT_PRESETS,
    SIZES_PRESETS    : SIZES_PRESETS
};

module.exports = SrcSetBuilder;
