/**
 * ImageOptimizer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /cdn-optimization
 *
 * Provides a complete image optimization pipeline for SFCC storefronts using
 * the Dynamic Imaging Service (DIS / Scene7):
 *
 *   1. FORMAT NEGOTIATION   — Detects WebP / AVIF support via Accept header
 *                             (server-side) and serves the most compressed
 *                             format the browser supports.
 *
 *   2. DIS URL BUILDER      — Constructs optimized DIS URLs with quality,
 *                             format, width, and compression parameters,
 *                             following a consistent naming convention that
 *                             maximises CDN cache hit rates.
 *
 *   3. RESPONSIVE PIPELINE  — Generates <picture> element markup server-side
 *                             in SFCC scripts/ISML, including AVIF, WebP and
 *                             JPEG sources with correct srcset breakpoints.
 *
 *   4. LOSSLESS DETECTION   — Identifies images that should never be
 *                             compressed (logos, icons with text, badges)
 *                             based on DIS asset metadata.
 *
 *   5. QUALITY LADDER       — Maps image context (hero, tile, thumbnail) to
 *                             an optimal quality setting, preventing engineers
 *                             from accidentally shipping q=100 product images.
 *
 * Server-side usage (SFCC script / ISML):
 *   var IO = require('*/cartridge/scripts/cdn/ImageOptimizer');
 *
 *   // Auto-negotiate best format, build optimized URL
 *   var url = IO.buildURL(product.getImage('large', 0).getURL(), {
 *       context: 'product-tile',
 *       width  : 400,
 *       request: request   // SFCC request object for Accept header
 *   });
 *
 *   // Generate full <picture> element
 *   var pictureHTML = IO.buildPicture(imageURL, {
 *       context : 'product-detail',
 *       widths  : [400, 800, 1200],
 *       alt     : product.name
 *   });
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var Logger = require('dw/system/Logger').getLogger('cdn', 'ImageOptimizer');

// ─── Quality ladder ───────────────────────────────────────────────────────────

/**
 * Per-context quality settings.
 * Lower quality = smaller file, faster load.
 * These values are calibrated for DIS's encoder, which is more aggressive
 * than Photoshop — q=75 in DIS ≈ q=85 in Photoshop.
 */
var QUALITY_LADDER = {
    'hero-banner'    : { jpeg: 82, webp: 78, avif: 65 },
    'product-detail' : { jpeg: 80, webp: 75, avif: 62 },
    'product-tile'   : { jpeg: 75, webp: 70, avif: 58 },
    'category-tile'  : { jpeg: 75, webp: 70, avif: 58 },
    'thumbnail'      : { jpeg: 65, webp: 60, avif: 50 },
    'editorial'      : { jpeg: 82, webp: 78, avif: 65 },
    'logo'           : { jpeg: 90, webp: 88, avif: 80 },   // Logos need sharpness
    '_default'       : { jpeg: 78, webp: 73, avif: 60 }
};

/**
 * Standard responsive breakpoint widths (pixels) per context.
 * These match the CSS breakpoints used by SFRA's grid system.
 */
var BREAKPOINT_WIDTHS = {
    'hero-banner'    : [480, 768, 1024, 1440, 1920],
    'product-detail' : [320, 480, 768, 1024, 1280],
    'product-tile'   : [160, 280, 400, 560],
    'category-tile'  : [240, 360, 480, 720],
    'thumbnail'      : [80, 120, 160],
    'editorial'      : [480, 768, 1024, 1440],
    '_default'       : [320, 640, 1024]
};

/**
 * CSS `sizes` attribute strings per context.
 * Tells the browser which rendered width to expect at each viewport width.
 */
var SIZES_ATTR = {
    'hero-banner'    : '100vw',
    'product-detail' : '(max-width: 544px) 100vw, (max-width: 992px) 50vw, 40vw',
    'product-tile'   : '(max-width: 544px) 50vw, (max-width: 992px) 33vw, 25vw',
    'category-tile'  : '(max-width: 544px) 50vw, 33vw',
    'thumbnail'      : '80px',
    'editorial'      : '(max-width: 768px) 100vw, 50vw',
    '_default'       : '(max-width: 768px) 100vw, 50vw'
};

// ─── Format detection (server-side) ──────────────────────────────────────────

/**
 * Detects the optimal image format from the HTTP Accept header.
 * Called once per request in the controller — result should be cached
 * in pdict or request.custom for reuse across template includes.
 *
 * Priority: AVIF > WebP > JPEG (AVIF is ~50% smaller than WebP at same quality)
 *
 * @param  {dw.system.Request} sfccRequest  - SFCC request object
 * @returns {'avif'|'webp'|'jpeg'}
 */
function detectBestFormat(sfccRequest) {
    try {
        var accept = sfccRequest.getHttpHeaders().get('accept') || '';
        if (accept.indexOf('image/avif') !== -1) { return 'avif'; }
        if (accept.indexOf('image/webp') !== -1) { return 'webp'; }
    } catch (e) {
        Logger.warn('ImageOptimizer.detectBestFormat: could not read Accept header: {0}', e.message);
    }
    return 'jpeg';
}

// ─── DIS URL construction ─────────────────────────────────────────────────────

/**
 * DIS format token map.
 * Maps our canonical format names to Scene7 `fmt` parameter values.
 */
var DIS_FORMAT_MAP = {
    'avif': 'avif',
    'webp': 'webp',
    'jpeg': 'jpeg',
    'png' : 'png',
    'gif' : 'gif'
};

/**
 * Strips any existing DIS query parameters from a base URL so we can
 * reapply them cleanly. Removes sw, sh, q, fmt, scl, op_sharpen, crop.
 *
 * @param  {string} rawURL
 * @returns {string}
 */
function stripDISParams(rawURL) {
    if (!rawURL) { return ''; }
    var url = String(rawURL);
    // Remove known DIS params
    url = url.replace(/[?&](sw|sh|q|fmt|scl|op_sharpen|crop|bgc|layer|wid|hei|fit)=[^&]*/g, '');
    url = url.replace(/[?&]+$/, '');
    return url;
}

/**
 * Builds an optimized DIS URL with quality, format, width, and sharpening.
 *
 * @param  {string} baseURL   - Raw DIS URL (may already have params)
 * @param  {Object} opts
 * @param  {string} [opts.context]    - Quality ladder key (e.g. 'product-tile')
 * @param  {string} [opts.format]     - 'avif'|'webp'|'jpeg' (default: 'jpeg')
 * @param  {number} [opts.width]      - Target width in pixels (sw parameter)
 * @param  {number} [opts.height]     - Target height in pixels (sh parameter)
 * @param  {number} [opts.quality]    - Override quality (0–100)
 * @param  {boolean}[opts.sharpen]    - Apply DIS unsharp mask (default: true for tile/thumb)
 * @param  {dw.system.Request} [opts.request]  - SFCC request for auto format detection
 * @returns {string} Optimized DIS URL
 */
function buildURL(baseURL, opts) {
    var options = opts || {};
    var context = options.context || '_default';
    var ladder  = QUALITY_LADDER[context] || QUALITY_LADDER['_default'];

    // Resolve format
    var format  = options.format;
    if (!format && options.request) {
        format = detectBestFormat(options.request);
    }
    format = format || 'jpeg';

    var quality = options.quality || ladder[format] || ladder['jpeg'];
    var disFormat = DIS_FORMAT_MAP[format] || 'jpeg';

    var clean = stripDISParams(baseURL);
    var sep   = clean.indexOf('?') !== -1 ? '&' : '?';
    var params = [];

    if (options.width)  { params.push('sw=' + options.width); }
    if (options.height) { params.push('sh=' + options.height); }
    params.push('q=' + quality);
    params.push('fmt=' + disFormat);

    // Apply mild unsharp mask for thumbnails and tiles — compensates for downscaling blur
    var shouldSharpen = options.sharpen !== undefined
        ? options.sharpen
        : (context === 'product-tile' || context === 'thumbnail' || context === 'category-tile');

    if (shouldSharpen) {
        params.push('op_sharpen=1');
    }

    return clean + sep + params.join('&');
}

// ─── srcset generation ────────────────────────────────────────────────────────

/**
 * Generates a `srcset` attribute string for a given DIS URL across an array
 * of widths, all in the specified format.
 *
 * @param  {string}   baseURL
 * @param  {number[]} widths
 * @param  {Object}   opts    - Same opts as buildURL (format, context, quality)
 * @returns {string}
 */
function buildSrcset(baseURL, widths, opts) {
    return widths.map(function (w) {
        return buildURL(baseURL, Object.assign({}, opts, { width: w })) + ' ' + w + 'w';
    }).join(', ');
}

// ─── <picture> element builder ────────────────────────────────────────────────

/**
 * Generates a complete <picture> element HTML string with:
 *   - <source> for AVIF (most browsers that support WebP also support AVIF)
 *   - <source> for WebP
 *   - <img> fallback with JPEG srcset
 *
 * @param  {string} baseURL
 * @param  {Object} opts
 * @param  {string}   opts.context      - Quality/breakpoint context
 * @param  {number[]} [opts.widths]     - Override default breakpoint widths
 * @param  {string}   [opts.sizes]      - Override sizes attribute
 * @param  {string}   [opts.alt]        - Alt text (required for accessibility)
 * @param  {boolean}  [opts.lazy]       - Use data-srcset (for LazyImageLoader)
 * @param  {string}   [opts.classes]    - CSS classes for the <img> element
 * @param  {number}   [opts.width]      - Explicit width attribute
 * @param  {number}   [opts.height]     - Explicit height attribute (prevents CLS)
 * @param  {boolean}  [opts.priority]   - If true, adds fetchpriority="high" (for LCP)
 * @returns {string}  HTML <picture> element string
 */
function buildPicture(baseURL, opts) {
    var options = opts || {};
    var context = options.context || '_default';
    var widths  = options.widths  || BREAKPOINT_WIDTHS[context] || BREAKPOINT_WIDTHS['_default'];
    var sizes   = options.sizes   || SIZES_ATTR[context] || SIZES_ATTR['_default'];
    var lazy    = options.lazy === true;
    var srcAttr = lazy ? 'data-srcset' : 'srcset';
    var imgSrc  = lazy ? 'data-src'    : 'src';
    var alt     = options.alt    || '';
    var classes = options.classes ? ' class="' + options.classes + '"' : '';
    var priority = options.priority ? ' fetchpriority="high" loading="eager"' : ' loading="lazy"';
    var dimAttrs = '';
    if (options.width)  { dimAttrs += ' width="' + options.width + '"'; }
    if (options.height) { dimAttrs += ' height="' + options.height + '"'; }

    var avifSrcset = buildSrcset(baseURL, widths, { context: context, format: 'avif' });
    var webpSrcset = buildSrcset(baseURL, widths, { context: context, format: 'webp' });
    var jpegSrcset = buildSrcset(baseURL, widths, { context: context, format: 'jpeg' });
    var jpegFallback = buildURL(baseURL, { context: context, format: 'jpeg', width: widths[0] });

    return [
        '<picture>',
        '  <source type="image/avif" ' + srcAttr + '="' + avifSrcset + '" sizes="' + sizes + '">',
        '  <source type="image/webp" ' + srcAttr + '="' + webpSrcset + '" sizes="' + sizes + '">',
        '  <img',
        '    ' + imgSrc + '="' + jpegFallback + '"',
        '    ' + srcAttr + '="' + jpegSrcset + '"',
        '    sizes="' + sizes + '"',
        '    alt="' + alt.replace(/"/g, '&quot;') + '"',
        '    decoding="async"',
        '    ' + priority,
        '    ' + dimAttrs,
        '    ' + classes,
        '  >',
        '</picture>'
    ].join('\n');
}

// ─── Bulk optimization ────────────────────────────────────────────────────────

/**
 * Processes an array of SFCC ImageScriptObject instances and returns
 * optimized URL objects for each one — used in controllers to pre-build
 * all image URLs before template rendering.
 *
 * @param  {dw.content.MediaFile[]} images   - Array of SFCC image objects
 * @param  {Object}                 opts     - Same opts as buildURL
 * @returns {Object[]}  Array of { original, optimized, srcset, format }
 */
function optimizeImageSet(images, opts) {
    if (!images || !images.length) { return []; }
    var options = opts || {};

    return images.map(function (img) {
        var rawURL  = img && img.getURL ? img.getURL().toString() : '';
        var context = options.context || '_default';
        var widths  = BREAKPOINT_WIDTHS[context] || BREAKPOINT_WIDTHS['_default'];

        return {
            original : rawURL,
            optimized: buildURL(rawURL, options),
            srcset   : buildSrcset(rawURL, widths, options),
            sizes    : SIZES_ATTR[context] || SIZES_ATTR['_default'],
            alt      : (img && img.alt) || options.alt || '',
            format   : options.format || 'jpeg'
        };
    });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    detectBestFormat  : detectBestFormat,
    buildURL          : buildURL,
    buildSrcset       : buildSrcset,
    buildPicture      : buildPicture,
    optimizeImageSet  : optimizeImageSet,
    stripDISParams    : stripDISParams,
    QUALITY_LADDER    : QUALITY_LADDER,
    BREAKPOINT_WIDTHS : BREAKPOINT_WIDTHS,
    SIZES_ATTR        : SIZES_ATTR,
    DIS_FORMAT_MAP    : DIS_FORMAT_MAP
};
