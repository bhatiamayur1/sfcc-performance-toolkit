/**
 * MetadataManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /seo-performance
 *
 * Generates and injects all SEO-critical <head> metadata for SFCC page types.
 * Covers:
 *
 *   1. TITLE & META DESCRIPTION
 *      Builds optimised, keyword-enriched title and description strings for
 *      Product, Category, Search, Homepage and Content pages. Falls back
 *      gracefully through a hierarchy (page-level → site-level → defaults).
 *
 *   2. CANONICAL URLS
 *      Emits canonical <link> tags that resolve SFCC URL parameter noise
 *      (sorting, pagination, refinements) to the clean indexable URL.
 *      Prevents duplicate-content penalties on paginated PLPs and
 *      multi-refinement facet URLs.
 *
 *   3. OPEN GRAPH & TWITTER CARDS
 *      Generates complete og: and twitter: meta tags using product/category
 *      data from SFCC objects. Ensures correct image dimensions for
 *      social sharing previews.
 *
 *   4. HREFLANG (MULTI-LOCALE)
 *      Builds hreflang <link> tags for all active locales so Google serves
 *      the correct language variant to each market.
 *
 *   5. JSON-LD STRUCTURED DATA
 *      Emits schema.org JSON-LD for Product, BreadcrumbList, Organization,
 *      and SearchAction types — the most impactful structured data types
 *      for e-commerce organic traffic.
 *
 * Usage (in a SFCC controller):
 *   var Meta = require('*/cartridge/scripts/seo/MetadataManager');
 *
 *   pdict.seoHead = Meta.buildProductHead({
 *       product : product,
 *       category: currentCategory,
 *       request : request,
 *       pageNum : parseInt(httpParams.start, 10) || 1
 *   });
 *
 * Usage (in ISML htmlHead.isml):
 *   <isprint value="${pdict.seoHead.titleTag}"       encoding="off"/>
 *   <isprint value="${pdict.seoHead.metaTags}"       encoding="off"/>
 *   <isprint value="${pdict.seoHead.canonicalTag}"   encoding="off"/>
 *   <isprint value="${pdict.seoHead.hreflangTags}"   encoding="off"/>
 *   <isprint value="${pdict.seoHead.jsonLd}"         encoding="off"/>
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var Site     = require('dw/system/Site');
var URLUtils = require('dw/web/URLUtils');
var Logger   = require('dw/system/Logger').getLogger('seo', 'MetadataManager');

// ─── Configuration ─────────────────────────────────────────────────────────────

var CONFIG = {
    /** Maximum title length before truncation (Google displays ~60 chars) */
    maxTitleLength: 60,

    /** Maximum meta description length (Google displays ~155 chars) */
    maxDescLength: 155,

    /** Separator between page-specific and brand segments in title tags */
    titleSeparator: ' | ',

    /** Default OG image dimensions (Scene7 DIS parameters) */
    ogImageWidth : 1200,
    ogImageHeight: 630,

    /** Twitter card type */
    twitterCard: 'summary_large_image',

    /** Site name appended to all title tags */
    siteName: Site.getCurrent().getCustomPreferenceValue('seoSiteName')
              || Site.getCurrent().getName()
};

// ─── String helpers ────────────────────────────────────────────────────────────

/**
 * Truncates a string at the last word boundary before maxLen characters.
 * Appends '…' if truncated.
 *
 * @param  {string} str
 * @param  {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen) {
    if (!str) { return ''; }
    var s = String(str).replace(/\s+/g, ' ').trim();
    if (s.length <= maxLen) { return s; }
    var cut = s.lastIndexOf(' ', maxLen - 1);
    return (cut > 0 ? s.slice(0, cut) : s.slice(0, maxLen - 1)) + '…';
}

/**
 * Escapes a string for safe embedding in HTML attribute values.
 * @param  {string} str
 * @returns {string}
 */
function escAttr(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Escapes a string for safe embedding in a JSON-LD <script> block.
 * Must escape </script> sequences to prevent XSS.
 * @param  {string} str
 * @returns {string}
 */
function escJsonLd(str) {
    return String(str || '').replace(/<\/script>/gi, '<\\/script>');
}

// ─── Canonical URL builder ─────────────────────────────────────────────────────

/**
 * Builds the canonical URL for a page, stripping non-canonical parameters.
 *
 * SFCC adds many URL params (start, srule, prefn1, prefv1, sz, format, source…)
 * that should not appear in the canonical — they create thousands of duplicate
 * URL variants that Google may de-index.
 *
 * Canonical params (retained):
 *   cgid, pid, q, lang, locale
 *
 * @param  {dw.system.Request} sfccRequest
 * @param  {string[]}          [extraCanonicalParams]  Additional params to retain
 * @returns {string}  Canonical URL string
 */
function buildCanonical(sfccRequest, extraCanonicalParams) {
    var CANONICAL_PARAMS = ['cgid', 'pid', 'q', 'lang', 'locale'].concat(extraCanonicalParams || []);

    try {
        var reqURL    = sfccRequest.getHttpURL().toString();
        var urlObj    = new (require('dw/web/URL'))(reqURL);
        var path      = urlObj.pathname || reqURL.split('?')[0];
        var rawQuery  = urlObj.search ? urlObj.search.slice(1) : '';

        // Keep only canonical query params
        var cleanQuery = rawQuery
            .split('&')
            .filter(function (part) {
                if (!part) { return false; }
                var key = part.split('=')[0];
                return CANONICAL_PARAMS.indexOf(key) !== -1;
            })
            .join('&');

        // Ensure HTTPS and correct host
        var proto = 'https';
        var host  = sfccRequest.getHttpHost();
        var canonical = proto + '://' + host + path + (cleanQuery ? '?' + cleanQuery : '');
        return canonical;

    } catch (e) {
        Logger.warn('MetadataManager.buildCanonical error: {0}', e.message);
        return URLUtils.abs('Home-Show').toString();
    }
}

// ─── Hreflang builder ─────────────────────────────────────────────────────────

/**
 * Generates hreflang <link> tags for all active locales on the current site.
 * Each tag points to the locale-specific URL for the same page.
 *
 * @param  {string} currentPath  - URL path of the current page (without locale prefix)
 * @returns {string}  HTML string of <link rel="alternate" hreflang="..."> tags
 */
function buildHreflangTags(currentPath) {
    var locales = Site.getCurrent().getAllowedLocales();
    if (!locales || locales.length <= 1) { return ''; }

    var tags = [];
    var proto = 'https';
    var host  = Site.getCurrent().getHttpsHostName()
                || Site.getCurrent().getHttpHostName();

    locales.toArray().forEach(function (locale) {
        // Convert SFCC locale format (en_GB) to BCP 47 (en-GB) for hreflang
        var hreflangCode = locale.getID().replace('_', '-');
        var localePath   = '/' + locale.getID().toLowerCase() + currentPath;

        // x-default points to the default/primary locale
        if (locale.getID() === Site.getCurrent().getDefaultLocale()) {
            tags.push('<link rel="alternate" hreflang="x-default" href="' +
                      escAttr(proto + '://' + host + currentPath) + '">');
        }

        tags.push('<link rel="alternate" hreflang="' + escAttr(hreflangCode) +
                  '" href="' + escAttr(proto + '://' + host + localePath) + '">');
    });

    return tags.join('\n');
}

// ─── JSON-LD schema builders ───────────────────────────────────────────────────

/**
 * Builds a schema.org/Product JSON-LD object for a SFCC product.
 * Includes offers (price, availability), brand, image, rating.
 *
 * @param  {dw.catalog.Product} product
 * @param  {string}             pageURL
 * @returns {Object}  Plain JS object (will be JSON.stringify'd)
 */
function buildProductSchema(product, pageURL) {
    var priceModel = product.getPriceModel();
    var price      = priceModel ? priceModel.getPrice() : null;
    var images     = product.getImages('large');
    var imageURL   = images && images.size() > 0
        ? images.get(0).getURL().toString() + '?sw=1200&q=82&fmt=jpg'
        : null;

    var schema = {
        '@context'   : 'https://schema.org',
        '@type'      : 'Product',
        'name'       : product.getName(),
        'description': truncate(product.getLongDescription()
                        ? product.getLongDescription().getMarkup()
                              .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
                        : product.getShortDescription() || '', 300),
        'url'        : pageURL,
        'sku'        : product.getID(),
        'mpn'        : product.getManufacturerSKU() || product.getID()
    };

    if (imageURL) { schema['image'] = imageURL; }

    if (product.getBrand()) {
        schema['brand'] = { '@type': 'Brand', 'name': product.getBrand() };
    }

    if (price && price.getValue() > 0) {
        var availability = product.getAvailabilityModel().getAvailabilityStatus();
        schema['offers'] = {
            '@type'           : 'Offer',
            'price'           : price.getValue().toFixed(2),
            'priceCurrency'   : price.getCurrencyCode(),
            'availability'    : availability === 'IN_STOCK'
                ? 'https://schema.org/InStock'
                : availability === 'PREORDER'
                ? 'https://schema.org/PreOrder'
                : 'https://schema.org/OutOfStock',
            'url'             : pageURL,
            'priceValidUntil' : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
                                    .toISOString().split('T')[0]
        };
    }

    // Aggregate rating — from custom attributes (set by reviews integration)
    var ratingValue = product.getCustom().ratingValue;
    var ratingCount = product.getCustom().ratingCount;
    if (ratingValue && ratingCount) {
        schema['aggregateRating'] = {
            '@type'      : 'AggregateRating',
            'ratingValue': parseFloat(ratingValue).toFixed(1),
            'reviewCount': parseInt(ratingCount, 10)
        };
    }

    return schema;
}

/**
 * Builds a schema.org/BreadcrumbList JSON-LD for the current page.
 *
 * @param  {Array<{ name: string, url: string }>} crumbs
 * @returns {Object}
 */
function buildBreadcrumbSchema(crumbs) {
    return {
        '@context'       : 'https://schema.org',
        '@type'          : 'BreadcrumbList',
        'itemListElement': crumbs.map(function (crumb, i) {
            return {
                '@type'   : 'ListItem',
                'position': i + 1,
                'name'    : crumb.name,
                'item'    : crumb.url
            };
        })
    };
}

/**
 * Builds a schema.org/WebSite SearchAction JSON-LD (enables Google Sitelinks Search).
 *
 * @returns {Object}
 */
function buildSiteSearchSchema() {
    var searchURL = URLUtils.abs('Search-Show').toString();
    return {
        '@context': 'https://schema.org',
        '@type'   : 'WebSite',
        'name'    : CONFIG.siteName,
        'url'     : URLUtils.abs('Home-Show').toString(),
        'potentialAction': {
            '@type'       : 'SearchAction',
            'target'      : {
                '@type'     : 'EntryPoint',
                'urlTemplate': searchURL + '?q={search_term_string}'
            },
            'query-input' : 'required name=search_term_string'
        }
    };
}

/**
 * Wraps one or more schema objects in a <script type="application/ld+json"> block.
 * Supports both single objects and arrays (graph pattern).
 *
 * @param  {Object|Object[]} schemaObj
 * @returns {string}  HTML string
 */
function wrapJsonLd(schemaObj) {
    var json = JSON.stringify(Array.isArray(schemaObj) ? { '@graph': schemaObj } : schemaObj, null, 2);
    return '<script type="application/ld+json">\n' + escJsonLd(json) + '\n</script>';
}

// ─── Head builders per page type ──────────────────────────────────────────────

/**
 * Builds the complete SEO <head> payload for a Product Detail Page.
 *
 * @param  {Object} opts
 * @param  {dw.catalog.Product}  opts.product
 * @param  {dw.catalog.Category} opts.category
 * @param  {dw.system.Request}   opts.request
 * @param  {Array}               [opts.breadcrumbs]  - [{ name, url }]
 * @returns {Object}  { titleTag, metaTags, canonicalTag, hreflangTags, jsonLd }
 */
function buildProductHead(opts) {
    var product  = opts.product;
    var category = opts.category;
    var req      = opts.request;

    var productName = product.getName() || '';
    var brand       = product.getBrand() || '';
    var catName     = category ? category.getDisplayName() : '';

    // Title: "Blue Slim-Fit Jeans — Levi's | YourBrand" (≤60 chars)
    var titleBase = [brand, productName].filter(Boolean).join(' ');
    if (catName) { titleBase = productName + ' — ' + catName; }
    var title = truncate(titleBase, CONFIG.maxTitleLength - CONFIG.siteName.length - CONFIG.titleSeparator.length)
                + CONFIG.titleSeparator + CONFIG.siteName;

    // Description: pull from custom SEO attribute → longDescription → shortDescription
    var rawDesc = product.getCustom().seoDescription
        || (product.getLongDescription()
            ? product.getLongDescription().getMarkup().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
            : '')
        || product.getShortDescription()
        || '';
    var description = truncate(rawDesc, CONFIG.maxDescLength);

    var pageURL   = buildCanonical(req);
    var images    = product.getImages('large');
    var ogImage   = images && images.size() > 0
        ? images.get(0).getURL().toString()
          + '?sw=' + CONFIG.ogImageWidth + '&sh=' + CONFIG.ogImageHeight + '&q=82&fmt=jpg'
        : null;

    // Price for og:price meta
    var priceModel = product.getPriceModel();
    var price      = priceModel ? priceModel.getPrice() : null;

    var metas = [
        '<meta name="description" content="' + escAttr(description) + '">',
        '<meta name="robots" content="index, follow">',
        '',
        // Open Graph
        '<meta property="og:type"        content="product">',
        '<meta property="og:title"       content="' + escAttr(title) + '">',
        '<meta property="og:description" content="' + escAttr(description) + '">',
        '<meta property="og:url"         content="' + escAttr(pageURL) + '">',
        '<meta property="og:site_name"   content="' + escAttr(CONFIG.siteName) + '">'
    ];

    if (ogImage) {
        metas.push('<meta property="og:image"        content="' + escAttr(ogImage) + '">');
        metas.push('<meta property="og:image:width"  content="' + CONFIG.ogImageWidth + '">');
        metas.push('<meta property="og:image:height" content="' + CONFIG.ogImageHeight + '">');
        metas.push('<meta property="og:image:alt"    content="' + escAttr(productName) + '">');
    }

    if (price && price.getValue() > 0) {
        metas.push('<meta property="product:price:amount"   content="' + price.getValue().toFixed(2) + '">');
        metas.push('<meta property="product:price:currency" content="' + price.getCurrencyCode() + '">');
    }

    // Twitter Card
    metas.push('');
    metas.push('<meta name="twitter:card"        content="' + CONFIG.twitterCard + '">');
    metas.push('<meta name="twitter:title"       content="' + escAttr(title) + '">');
    metas.push('<meta name="twitter:description" content="' + escAttr(description) + '">');
    if (ogImage) {
        metas.push('<meta name="twitter:image" content="' + escAttr(ogImage) + '">');
    }

    var twitterHandle = Site.getCurrent().getCustomPreferenceValue('seoTwitterHandle');
    if (twitterHandle) {
        metas.push('<meta name="twitter:site" content="' + escAttr(twitterHandle) + '">');
    }

    // Breadcrumb schema
    var breadcrumbs = opts.breadcrumbs || [];
    if (breadcrumbs.length === 0 && category) {
        breadcrumbs = [
            { name: 'Home',      url: URLUtils.abs('Home-Show').toString() },
            { name: catName,     url: URLUtils.abs('Search-Show', 'cgid', category.getID()).toString() },
            { name: productName, url: pageURL }
        ];
    }

    var schemas = [
        buildProductSchema(product, pageURL),
        buildBreadcrumbSchema(breadcrumbs)
    ];

    return {
        titleTag    : '<title>' + escAttr(title) + '</title>',
        metaTags    : metas.join('\n'),
        canonicalTag: '<link rel="canonical" href="' + escAttr(pageURL) + '">',
        hreflangTags: buildHreflangTags(req.getHttpPath()),
        jsonLd      : wrapJsonLd(schemas)
    };
}

/**
 * Builds the complete SEO <head> payload for a Product Listing Page (PLP / Category).
 *
 * Handles pagination canonical correctly:
 *   Page 1 → canonical = /womens/tops (no ?start param)
 *   Page 2 → canonical = /womens/tops?start=24
 *   Adds rel="prev" / rel="next" pagination links.
 *
 * @param  {Object} opts
 * @param  {dw.catalog.Category} opts.category
 * @param  {dw.system.Request}   opts.request
 * @param  {number}              [opts.pageNum]    - 1-based current page number
 * @param  {number}              [opts.pageSize]   - Products per page
 * @param  {number}              [opts.totalCount] - Total product count
 * @returns {Object}
 */
function buildCategoryHead(opts) {
    var category   = opts.category;
    var req        = opts.request;
    var pageNum    = opts.pageNum  || 1;
    var pageSize   = opts.pageSize || 24;
    var totalCount = opts.totalCount || 0;
    var totalPages = Math.ceil(totalCount / pageSize);

    var catName    = category ? category.getDisplayName() : '';
    var rawDesc    = category ? (
        category.getCustom().seoDescription
        || category.getDescription()
        || ''
    ) : '';

    var title = pageNum > 1
        ? truncate(catName, 40) + ' — Page ' + pageNum + CONFIG.titleSeparator + CONFIG.siteName
        : truncate(catName, CONFIG.maxTitleLength - CONFIG.siteName.length - CONFIG.titleSeparator.length)
          + CONFIG.titleSeparator + CONFIG.siteName;

    var description = truncate(rawDesc, CONFIG.maxDescLength);

    // Canonical for page 1 has no start param; subsequent pages include start
    var baseCatURL = URLUtils.abs('Search-Show', 'cgid', category.getID()).toString();
    var canonical  = pageNum > 1
        ? baseCatURL + '?start=' + ((pageNum - 1) * pageSize)
        : baseCatURL;

    var metas = [
        '<meta name="description" content="' + escAttr(description) + '">',
        '<meta name="robots" content="' + (pageNum > 1 ? 'noindex, follow' : 'index, follow') + '">',
        '',
        '<meta property="og:type"        content="website">',
        '<meta property="og:title"       content="' + escAttr(title) + '">',
        '<meta property="og:description" content="' + escAttr(description) + '">',
        '<meta property="og:url"         content="' + escAttr(canonical) + '">',
        '<meta property="og:site_name"   content="' + escAttr(CONFIG.siteName) + '">'
    ];

    var paginationLinks = [];
    if (pageNum > 1) {
        var prevStart = (pageNum - 2) * pageSize;
        var prevURL   = pageNum === 2 ? baseCatURL : baseCatURL + '?start=' + prevStart;
        paginationLinks.push('<link rel="prev" href="' + escAttr(prevURL) + '">');
    }
    if (pageNum < totalPages) {
        var nextStart = pageNum * pageSize;
        paginationLinks.push('<link rel="next" href="' + escAttr(baseCatURL + '?start=' + nextStart) + '">');
    }

    return {
        titleTag       : '<title>' + escAttr(title) + '</title>',
        metaTags       : metas.join('\n'),
        canonicalTag   : '<link rel="canonical" href="' + escAttr(canonical) + '">'
                         + (paginationLinks.length ? '\n' + paginationLinks.join('\n') : ''),
        hreflangTags   : buildHreflangTags(req.getHttpPath()),
        jsonLd         : wrapJsonLd(buildBreadcrumbSchema([
            { name: 'Home',   url: URLUtils.abs('Home-Show').toString() },
            { name: catName,  url: baseCatURL }
        ]))
    };
}

/**
 * Builds SEO <head> for the Homepage.
 * Includes Organization schema and SearchAction schema.
 *
 * @param  {dw.system.Request} req
 * @returns {Object}
 */
function buildHomepageHead(req) {
    var title = Site.getCurrent().getCustomPreferenceValue('seoHomepageTitle')
                || CONFIG.siteName + ' — Official Store';
    var description = truncate(
        Site.getCurrent().getCustomPreferenceValue('seoHomepageDescription') || '',
        CONFIG.maxDescLength
    );

    var siteURL = URLUtils.abs('Home-Show').toString();
    var logoURL = Site.getCurrent().getCustomPreferenceValue('seoLogoURL') || '';

    var orgSchema = {
        '@context': 'https://schema.org',
        '@type'   : 'Organization',
        'name'    : CONFIG.siteName,
        'url'     : siteURL,
        'logo'    : logoURL
    };

    var schemas = [orgSchema, buildSiteSearchSchema()];

    return {
        titleTag    : '<title>' + escAttr(title) + '</title>',
        metaTags    : [
            '<meta name="description" content="' + escAttr(description) + '">',
            '<meta name="robots" content="index, follow">',
            '<meta property="og:type"      content="website">',
            '<meta property="og:title"     content="' + escAttr(title) + '">',
            '<meta property="og:url"       content="' + escAttr(siteURL) + '">',
            '<meta property="og:site_name" content="' + escAttr(CONFIG.siteName) + '">'
        ].join('\n'),
        canonicalTag: '<link rel="canonical" href="' + escAttr(siteURL) + '">',
        hreflangTags: buildHreflangTags('/'),
        jsonLd      : wrapJsonLd(schemas)
    };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    buildProductHead  : buildProductHead,
    buildCategoryHead : buildCategoryHead,
    buildHomepageHead : buildHomepageHead,
    buildCanonical    : buildCanonical,
    buildHreflangTags : buildHreflangTags,
    buildProductSchema: buildProductSchema,
    buildBreadcrumbSchema: buildBreadcrumbSchema,
    buildSiteSearchSchema: buildSiteSearchSchema,
    wrapJsonLd        : wrapJsonLd,
    truncate          : truncate,
    CONFIG            : CONFIG
};
