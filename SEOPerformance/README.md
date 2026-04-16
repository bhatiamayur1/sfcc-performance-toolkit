# /seo-performance — Page Speed, Metadata & SSR for SFCC SEO

Four accelerators covering the full surface area of technical SEO on SFCC — from structured data and canonical URLs to Googlebot simulation and SSR hydration guards for headless storefronts.

---

## Files

| File | Purpose | Runtime |
|------|---------|---------|
| `MetadataManager.js` | Title, meta, canonical, hreflang, Open Graph, JSON-LD per page type | SFCC script |
| `PageSpeedSEOBridge.js` | CWV → SEO impact mapping, server speed signals, Googlebot simulator | Both |
| `SSRAdapter.js` | Bot detection, metadata SSR injection, hydration guard, crawl budget mapper | PWA Kit / Node |
| `SitemapGenerator.js` | Dynamic XML sitemaps from SFCC catalog with priority scoring | SFCC script + Job |

---

## Why Page Speed Is a Direct SEO Signal

Since Google's Page Experience update (2021), Core Web Vitals are confirmed ranking factors. The table below maps each metric to its specific SEO consequence — implemented in `PageSpeedSEOBridge.js`:

| Metric | Good | Poor | SEO Consequence (poor) |
|--------|------|------|------------------------|
| LCP | < 2.5s | > 4s | Confirmed negative ranking factor |
| CLS | < 0.1 | > 0.25 | High bounce → poor dwell-time signal |
| INP | < 200ms | > 500ms | Poor engagement → lower return visits |
| FCP | < 1.8s | > 3s | Google may not index above-fold content |
| TTFB | < 800ms | > 1.8s | Crawl budget waste — Googlebot de-prioritises |

---

## 1. MetadataManager

Builds the complete `<head>` SEO payload for every SFCC page type in a single call.

```js
var Meta = require('*/cartridge/scripts/seo/MetadataManager');

// In Product-Show controller:
pdict.seoHead = Meta.buildProductHead({
    product    : product,
    category   : primaryCategory,
    request    : request,
    breadcrumbs: [
        { name: 'Home',    url: URLUtils.abs('Home-Show').toString() },
        { name: 'Jeans',   url: URLUtils.abs('Search-Show', 'cgid', 'womens-jeans').toString() },
        { name: product.getName(), url: URLUtils.abs('Product-Show', 'pid', product.ID).toString() }
    ]
});

// In Category-Show controller:
pdict.seoHead = Meta.buildCategoryHead({
    category   : category,
    request    : request,
    pageNum    : parseInt(httpParams.start, 10) / 24 + 1 || 1,
    pageSize   : 24,
    totalCount : searchResult.count
});

// In Home-Show controller:
pdict.seoHead = Meta.buildHomepageHead(request);
```

```html
<!-- In htmlHead.isml — inject all tags at once -->
<isprint value="${pdict.seoHead.titleTag}"    encoding="off"/>
<isprint value="${pdict.seoHead.metaTags}"    encoding="off"/>
<isprint value="${pdict.seoHead.canonicalTag}" encoding="off"/>
<isprint value="${pdict.seoHead.hreflangTags}" encoding="off"/>
<isprint value="${pdict.seoHead.jsonLd}"      encoding="off"/>
```

**What each output contains:**

`titleTag` — `<title>Blue Slim-Fit Jeans — Levi's | YourBrand</title>` (auto-truncated at 60 chars)

`metaTags` — `<meta name="description">` + full Open Graph (`og:type`, `og:title`, `og:image`, `og:image:width/height`, `product:price:amount`) + Twitter Card + robots directive (pages > 1 get `noindex, follow`)

`canonicalTag` — Strips `start`, `srule`, `prefn*`, `prefv*`, `sz`, `source`, `format` from the URL. Pages 2+ get `rel="prev"` / `rel="next"` pagination links.

`hreflangTags` — One `<link rel="alternate" hreflang="...">` per active site locale plus `x-default` pointing to the primary locale.

`jsonLd` — schema.org JSON-LD graph: `Product` (with `Offer`, `AggregateRating`, `Brand`) + `BreadcrumbList`. Homepage adds `Organization` + `WebSite` (enables Google Sitelinks Search Box).

---

## 2. PageSpeedSEOBridge

### Server-side: SpeedSignalCollector

```js
var Bridge = require('*/cartridge/scripts/seo/PageSpeedSEOBridge');

// At end of each controller action:
var result = Bridge.SpeedSignalCollector.collect({
    pageType  : 'pdp',
    url       : URLUtils.abs('Product-Show', 'pid', product.ID).toString(),
    responseMs: Date.now() - requestStart,
    response  : response,
    wasCached : searchResult.cacheHit
});

// result.issues → array of { signal, value, rating, fix }
// result.signals → { ttfbMs, ttfbRating, hasCDNCache, hasSurrogateKey }
```

### Server-side: GoogleBotSimulator

```js
// Run in a nightly SFCC Job to verify bot-facing responses:
var probeResults = Bridge.GoogleBotSimulator.probeAll([
    'https://www.yoursite.com/',
    'https://www.yoursite.com/womens/jeans/',
    'https://www.yoursite.com/product/blue-slim-jeans'
]);

probeResults.forEach(function (r) {
    if (r.issues.length > 0) {
        Logger.error('Googlebot probe issues on {0}: {1}', r.url, r.issues.join('; '));
    }
});
```

**What it catches:**
- CDN serving authenticated page to Googlebot (catastrophic)
- Redirect chains > 2 hops (crawl budget waste)
- 200 responses without CDN caching (Googlebot gets origin TTFB every crawl)
- `private`/`no-store` headers on public pages (not crawlable from edge)

### Client-side: PageExperienceReporter

```html
<script src="${URLUtils.staticURL('/js/PageSpeedSEOBridge.js')}"></script>
<script>
  PageExperienceReporter.init({
      pageType: '${pdict.CurrentPageMetaData.pageDesignType}',
      endpoint: '${URLUtils.url("Analytics-PageExperience")}',
      debug   : ${dw.system.System.instanceType == dw.system.System.DEVELOPMENT_SYSTEM}
  });
</script>
```

Reports LCP, CLS, INP, FCP, TTFB, FID to GA4 and your beacon endpoint. Each event carries a `metric_rating` property (`good`/`needs-improvement`/`poor`) and `page_type` for segmented analysis in Google Analytics.

---

## 3. SSRAdapter (Headless / PWA Kit)

### Bot detection

```js
var SSR = require('./scripts/seo/SSRAdapter');

// Express middleware — route bots to SSR, humans to SPA
app.use(function (req, res, next) {
    req.botType = SSR.getBotType(req.headers['user-agent']);
    req.isBot   = req.botType !== 'human';
    next();
});
```

**Detected bot categories:**
- `googlebot` — Google crawler + PageSpeed Insights
- `social` — Facebook, Twitter, LinkedIn, Pinterest, WhatsApp, Slack, Discord
- `seo-tool` — Ahrefs, SEMrush, Screaming Frog, Moz
- `other-bot` — all other crawlers

### SSR metadata injection (PWA Kit)

```js
// app/ssr.js
import { wrapSSRHandler, injectMetadataIntoHTML } from './scripts/seo/SSRAdapter'
import { buildProductHead } from './scripts/seo/MetadataManager'

export const get = wrapSSRHandler(async (req, res) => {
    // Your existing PWA Kit handler
}, {
    getMetadata: async (req) => {
        // Fetch product/category data from SCAPI
        const product = await fetchProduct(req.params.pid)
        return buildProductHead({ product, request: req })
    },
    auditScripts: process.env.NODE_ENV === 'development'
})
```

The wrapper intercepts `res.send()` and `res.end()`, injects the SSR metadata into the HTML stream, and adds `Server-Timing: ssr;dur=Xms` and `X-Bot-Type` response headers.

### Hydration guard (client-side)

```html
<!-- In your PWA Kit _document.js or index.html -->
<script>
  // Protect SSR metadata from being wiped during React hydration
  HydrationGuard.init()
</script>
```

```js
// In your React Router / Next.js route change handler:
window.HydrationGuard.release() // Allow React Helmet to take over
```

### Crawl budget mapper

```js
var urls = ['/','  /womens/tops/', '/product/blue-jeans', '/cart'];
var map  = SSR.CrawlBudgetMapper.buildPrerenderMap(urls);

// map[0] → { url: '/', priority: 1, tier: 'CRITICAL', shouldSSR: true }
// map[3] → { url: '/cart', priority: 5, tier: 'NORENDER', shouldSSR: false }
```

Use the output to configure your CDN prerender queue or Next.js `getStaticPaths` revalidation intervals.

---

## 4. SitemapGenerator

### Controller (on-demand sitemap serving)

```js
// In Sitemap-Products controller:
var SitemapGen = require('*/cartridge/scripts/seo/SitemapGenerator');
var result = SitemapGen.generateProductSitemap(request.getLocale());

response.setContentType('application/xml');
response.writer.print(result.xml);
```

### SFCC Job (nightly batch generation)

```
Step type : ExecuteScriptModule
Module    : app_custom_storefront/cartridge/scripts/seo/SitemapGenerator
Method    : generateAll
Schedule  : 02:00 daily (after catalog index rebuild)
```

**Sitemap architecture generated:**

```
sitemap-index.xml
├── sitemap-categories.xml         All online categories, priority by depth (0.4–0.9)
├── sitemap-products-en_GB.xml     Online, in-stock products, priority by price/stock
├── sitemap-products-de_DE.xml     ...per locale
└── sitemap-content.xml            (extend for blog/editorial)
```

**Priority scoring:**

| Signal | Priority boost |
|--------|---------------|
| Root-level category | 0.9 |
| In-stock product | Base 0.6 |
| Price > £100 | +0.1 |
| On sale / promotion | +0.1 |
| Out of stock | −0.2 |
| Deep subcategory (depth 4+) | 0.4 |

**Submit to Google Search Console:**

```
https://www.yoursite.com/on/demandware.store/Sites-MySite-Site/default/Sitemap-Index
```

---

## Setup Checklist

- [ ] Copy all 4 scripts to `cartridges/YOUR_CARTRIDGE/cartridge/scripts/seo/`
- [ ] Create SFCC Site Preferences: `seoSiteName`, `seoHomepageTitle`, `seoHomepageDescription`, `seoLogoURL`, `seoTwitterHandle`
- [ ] Call `MetadataManager.build*Head()` in every page controller, inject output into `htmlHead.isml`
- [ ] Add `PageSpeedSEOBridge.SpeedSignalCollector.collect()` at the end of each controller
- [ ] Create nightly SFCC Job for `GoogleBotSimulator.probeAll()` on your top 50 URLs
- [ ] Create nightly SFCC Job for `SitemapGenerator.generateAll()`
- [ ] Submit sitemap index to Google Search Console
- [ ] For headless/PWA Kit: wrap SSR handlers with `SSRAdapter.wrapSSRHandler()` and call `HydrationGuard.init()` in the browser
- [ ] Add `PageExperienceReporter.init()` to every page and monitor CWV by `pageType` in GA4
