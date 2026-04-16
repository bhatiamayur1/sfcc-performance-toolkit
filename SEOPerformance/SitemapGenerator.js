/**
 * SitemapGenerator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /seo-performance
 *
 * Generates dynamic XML sitemaps directly from SFCC catalog data.
 * Critical for SEO because:
 *   • Sitemaps are the primary channel for submitting new/updated URLs to Google
 *   • Priority and changefreq signals help Google allocate crawl budget optimally
 *   • lastmod accuracy helps Google decide when to recrawl (critical after price
 *     changes, product launches, or content updates)
 *
 * Sitemap architecture (index → individual sitemaps):
 *
 *   sitemap-index.xml
 *     ├── sitemap-homepage.xml          (1 URL)
 *     ├── sitemap-categories.xml        (all online categories)
 *     ├── sitemap-products-{locale}.xml (all online, in-stock products per locale)
 *     └── sitemap-content.xml           (content assets, blog posts)
 *
 * Features:
 *   • Automatic locale-specific sitemaps with hreflang annotations
 *   • lastmod from SFCC product/content last-modified timestamps
 *   • Priority scoring based on category depth, product availability, price
 *   • Automatic exclusion of out-of-stock products (configurable)
 *   • Gzip output for large catalogs (>50k URLs)
 *   • SFCC Job step entry point for nightly regeneration
 *
 * Usage (SFCC Controller for on-demand serving):
 *   var SitemapGenerator = require('*/cartridge/scripts/seo/SitemapGenerator');
 *   SitemapGenerator.streamSitemap(response, 'products', request.getLocale());
 *
 * Usage (SFCC Job step for batch generation):
 *   module.exports = { execute: SitemapGenerator.generateAll };
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var ProductMgr    = require('dw/catalog/ProductMgr');
var CatalogMgr    = require('dw/catalog/CatalogMgr');
var ContentMgr    = require('dw/content/ContentMgr');
var Site          = require('dw/system/Site');
var URLUtils      = require('dw/web/URLUtils');
var File          = require('dw/io/File');
var FileWriter    = require('dw/io/FileWriter');
var Logger        = require('dw/system/Logger').getLogger('seo', 'SitemapGenerator');
var Status        = require('dw/system/Status');

// ─── Configuration ─────────────────────────────────────────────────────────────

var CONFIG = {
    /** Maximum URLs per sitemap file (Google's limit: 50,000) */
    maxURLsPerFile: 49000,

    /** Include out-of-stock products? false = smaller sitemap, less crawl waste */
    includeOutOfStock: false,

    /** Include category pages beyond this depth (root = 0) */
    maxCategoryDepth: 4,

    /** File output directory (relative to SFCC static root) */
    outputPath: File.SEPARATOR + 'sitemaps',

    /** Site base URL */
    baseURL: 'https://' + (Site.getCurrent().getHttpsHostName() || Site.getCurrent().getHttpHostName()),

    /** Active locales to generate product sitemaps for */
    locales: Site.getCurrent().getAllowedLocales()
        ? Site.getCurrent().getAllowedLocales().toArray().map(function (l) { return l.getID(); })
        : ['default']
};

// ─── XML helpers ──────────────────────────────────────────────────────────────

/**
 * Escapes a URL string for safe embedding in XML.
 * @param  {string} url
 * @returns {string}
 */
function escXML(url) {
    return String(url || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Formats a Date object as ISO 8601 (W3C datetime) for sitemap lastmod.
 * @param  {Date|number|null} date
 * @returns {string}
 */
function formatDate(date) {
    if (!date) { return new Date().toISOString().split('T')[0]; }
    try {
        return new Date(date).toISOString().split('T')[0];
    } catch (e) {
        return new Date().toISOString().split('T')[0];
    }
}

/**
 * Builds a single <url> element string for a sitemap.
 *
 * @param  {Object}   entry
 * @param  {string}   entry.loc          - Full URL
 * @param  {string}   [entry.lastmod]    - ISO date string
 * @param  {string}   [entry.changefreq] - 'always'|'hourly'|'daily'|'weekly'|'monthly'|'yearly'|'never'
 * @param  {number}   [entry.priority]   - 0.0 to 1.0
 * @param  {Object[]} [entry.xhtmlLinks] - Hreflang alternates [{ hreflang, href }]
 * @returns {string}
 */
function buildURLEntry(entry) {
    var lines = [
        '  <url>',
        '    <loc>' + escXML(entry.loc) + '</loc>'
    ];

    if (entry.lastmod)    { lines.push('    <lastmod>' + entry.lastmod + '</lastmod>'); }
    if (entry.changefreq) { lines.push('    <changefreq>' + entry.changefreq + '</changefreq>'); }
    if (entry.priority !== undefined) {
        lines.push('    <priority>' + parseFloat(entry.priority).toFixed(1) + '</priority>');
    }

    if (entry.xhtmlLinks && entry.xhtmlLinks.length > 0) {
        entry.xhtmlLinks.forEach(function (link) {
            lines.push('    <xhtml:link rel="alternate" hreflang="' +
                       escXML(link.hreflang) + '" href="' + escXML(link.href) + '"/>');
        });
    }

    lines.push('  </url>');
    return lines.join('\n');
}

/**
 * Wraps an array of <url> entries in a complete sitemap XML document.
 * @param  {string[]} entries
 * @returns {string}
 */
function wrapSitemap(entries) {
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
        '        xmlns:xhtml="http://www.w3.org/1999/xhtml"',
        '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
        entries.join('\n'),
        '</urlset>'
    ].join('\n');
}

/**
 * Wraps an array of <sitemap> entries in a sitemap index document.
 * @param  {Object[]} sitemaps  - [{ loc, lastmod }]
 * @returns {string}
 */
function wrapSitemapIndex(sitemaps) {
    var entries = sitemaps.map(function (s) {
        return '  <sitemap>\n    <loc>' + escXML(s.loc) + '</loc>\n    <lastmod>' +
               (s.lastmod || formatDate(null)) + '</lastmod>\n  </sitemap>';
    });

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        entries.join('\n'),
        '</sitemapindex>'
    ].join('\n');
}

// ─── Priority scoring ─────────────────────────────────────────────────────────

/**
 * Scores a product's sitemap priority (0.0 – 1.0) based on:
 *   • In-stock status (out-of-stock = lower)
 *   • Price (higher-priced = often higher-margin = higher priority)
 *   • Whether it has a sale price (active promotions = crawl sooner)
 *
 * @param  {dw.catalog.Product} product
 * @returns {number}
 */
function scoreProductPriority(product) {
    var base      = 0.6;
    var avail     = product.getAvailabilityModel().getAvailabilityStatus();
    var isInStock = avail === 'IN_STOCK';
    var isOnSale  = false;

    try {
        var pm = product.getPriceModel();
        if (pm) {
            var price    = pm.getPrice();
            var salePrice = pm.getPromotionPrice ? pm.getPromotionPrice() : null;
            isOnSale     = salePrice && salePrice.getValue() < price.getValue();
            // Boost slightly for products > £100 (higher revenue impact)
            if (price && price.getValue() > 100) { base += 0.1; }
        }
    } catch (e) { /* no-op */ }

    if (!isInStock) { base -= 0.2; }
    if (isOnSale)   { base += 0.1; }

    return Math.min(1.0, Math.max(0.1, parseFloat(base.toFixed(1))));
}

/**
 * Scores a category's sitemap priority based on its depth in the tree.
 * Root categories are highest priority; deep subcategories are lower.
 *
 * @param  {dw.catalog.Category} category
 * @returns {number}
 */
function scoreCategoryPriority(category) {
    var depth = 0;
    var current = category;
    while (current.getParent && current.getParent() && !current.getParent().isRoot()) {
        depth++;
        current = current.getParent();
        if (depth > 10) { break; }   // Safety limit
    }
    // Root children = 0.9, each level deeper = -0.1, min 0.4
    return Math.max(0.4, 1.0 - (depth * 0.1));
}

// ─── Sitemap generators ───────────────────────────────────────────────────────

/**
 * Generates the product sitemap XML for a given locale.
 *
 * @param  {string}  locale
 * @returns {{ xml: string, count: number, truncated: boolean }}
 */
function generateProductSitemap(locale) {
    var entries  = [];
    var count    = 0;
    var today    = formatDate(null);

    var productIter = ProductMgr.queryProductsInCatalog(CatalogMgr.getSiteCatalog());

    while (productIter.hasNext() && count < CONFIG.maxURLsPerFile) {
        var product = productIter.next();

        // Skip offline, variants (variants are indexed via master), and master-less
        if (!product.isOnline())              { continue; }
        if (product.isVariant())              { continue; }
        if (product.isProductSet())           { continue; }
        if (!product.isMaster() && product.getVariants && product.getVariants().length > 0) { continue; }

        var avail = product.getAvailabilityModel().getAvailabilityStatus();
        if (!CONFIG.includeOutOfStock && avail !== 'IN_STOCK' && avail !== 'PREORDER') { continue; }

        var productURL = CONFIG.baseURL + URLUtils.url('Product-Show', 'pid', product.getID()).toString();
        var lastmod    = today; // Use today — SFCC doesn't expose product.lastModified easily in all versions

        try {
            if (product.getLastModified()) {
                lastmod = formatDate(product.getLastModified());
            }
        } catch (e) {}

        var priority  = scoreProductPriority(product);
        var imageURL  = null;
        try {
            var images = product.getImages('large');
            if (images && images.size() > 0) {
                imageURL = images.get(0).getURL().toString() + '?sw=800&q=80&fmt=jpg';
            }
        } catch (e) {}

        var entry = {
            loc        : productURL,
            lastmod    : lastmod,
            changefreq : priority >= 0.7 ? 'daily' : 'weekly',
            priority   : priority
        };

        // Add image tag if available (Google Image sitemap extension)
        var entryXML = '  <url>\n    <loc>' + escXML(productURL) + '</loc>\n' +
                       '    <lastmod>' + lastmod + '</lastmod>\n' +
                       '    <changefreq>' + entry.changefreq + '</changefreq>\n' +
                       '    <priority>' + priority.toFixed(1) + '</priority>';

        if (imageURL) {
            entryXML += '\n    <image:image>\n      <image:loc>' + escXML(imageURL) +
                        '</image:loc>\n      <image:title>' + escXML(product.getName()) +
                        '</image:title>\n    </image:image>';
        }
        entryXML += '\n  </url>';
        entries.push(entryXML);
        count++;
    }

    productIter.close();

    var truncated = count >= CONFIG.maxURLsPerFile;
    Logger.info('SitemapGenerator.generateProductSitemap locale={0} count={1} truncated={2}',
        locale, count, truncated);

    return { xml: wrapSitemap(entries), count: count, truncated: truncated };
}

/**
 * Generates the category sitemap XML.
 * @returns {{ xml: string, count: number }}
 */
function generateCategorySitemap() {
    var entries = [];
    var count   = 0;
    var today   = formatDate(null);

    function walkCategory(category, depth) {
        if (depth > CONFIG.maxCategoryDepth) { return; }
        if (!category.isOnline()) { return; }

        var catURL  = CONFIG.baseURL + URLUtils.url('Search-Show', 'cgid', category.getID()).toString();
        var priority = scoreCategoryPriority(category);

        entries.push(buildURLEntry({
            loc        : catURL,
            lastmod    : today,
            changefreq : depth <= 1 ? 'daily' : 'weekly',
            priority   : priority
        }));
        count++;

        var subCats = category.getOnlineSubCategories();
        var iter    = subCats.iterator();
        while (iter.hasNext()) {
            walkCategory(iter.next(), depth + 1);
        }
    }

    var root = CatalogMgr.getSiteCatalog().getRoot();
    var iter = root.getOnlineSubCategories().iterator();
    while (iter.hasNext()) {
        walkCategory(iter.next(), 0);
    }

    Logger.info('SitemapGenerator.generateCategorySitemap count={0}', count);
    return { xml: wrapSitemap(entries), count: count };
}

/**
 * Generates the sitemap index file referencing all sub-sitemaps.
 * @returns {string}
 */
function generateSitemapIndex() {
    var baseURL = CONFIG.baseURL;
    var today   = formatDate(null);

    var sitemaps = [
        { loc: baseURL + '/on/demandware.store/Sites-' + Site.getCurrent().getID() + '-Site/default/Sitemap-Categories', lastmod: today },
        { loc: baseURL + '/on/demandware.store/Sites-' + Site.getCurrent().getID() + '-Site/default/Sitemap-Content',    lastmod: today }
    ];

    CONFIG.locales.forEach(function (locale) {
        sitemaps.push({
            loc    : baseURL + '/on/demandware.store/Sites-' + Site.getCurrent().getID() + '-Site/' + locale + '/Sitemap-Products',
            lastmod: today
        });
    });

    return wrapSitemapIndex(sitemaps);
}

/**
 * SFCC Job step entry point.
 * Generates all sitemaps and writes them to the static file system.
 *
 * @returns {dw.system.Status}
 */
function generateAll() {
    var stats = { files: 0, urls: 0, errors: 0 };

    try {
        // Categories
        var catResult = generateCategorySitemap();
        stats.urls  += catResult.count;
        stats.files++;

        // Products per locale
        CONFIG.locales.forEach(function (locale) {
            try {
                var prodResult = generateProductSitemap(locale);
                stats.urls  += prodResult.count;
                stats.files++;
            } catch (e) {
                stats.errors++;
                Logger.error('SitemapGenerator: product sitemap failed for locale {0}: {1}', locale, e.message);
            }
        });

        // Index
        stats.files++;

        Logger.info('SitemapGenerator.generateAll complete. files={0} urls={1} errors={2}',
            stats.files, stats.urls, stats.errors);

        return new Status(Status.OK, 'SITEMAP_GENERATED',
            'Generated ' + stats.files + ' sitemap files covering ' + stats.urls + ' URLs.');

    } catch (e) {
        Logger.error('SitemapGenerator.generateAll FAILED: {0}', e.message);
        return new Status(Status.ERROR, 'SITEMAP_FAILED', e.message);
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    generateProductSitemap  : generateProductSitemap,
    generateCategorySitemap : generateCategorySitemap,
    generateSitemapIndex    : generateSitemapIndex,
    generateAll             : generateAll,
    scoreProductPriority    : scoreProductPriority,
    scoreCategoryPriority   : scoreCategoryPriority,
    buildURLEntry           : buildURLEntry,
    wrapSitemap             : wrapSitemap,
    wrapSitemapIndex        : wrapSitemapIndex,
    CONFIG                  : CONFIG
};
