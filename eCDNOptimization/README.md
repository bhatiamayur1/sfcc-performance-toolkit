# /cdn-optimization — Static Asset Delivery, Cache Headers & Image Optimization

Four production accelerators and a live audit CLI covering every CDN performance lever available on SFCC — from HTTP 103 Early Hints and WebP negotiation to surrogate-key purging and immutable asset caching.

---

## Files

| File | Purpose | Runtime |
|------|---------|---------|
| `CacheHeadersManager.js` | Server-side cache header strategy for every SFCC response type | SFCC script |
| `ImageOptimizer.js` | WebP/AVIF negotiation, DIS URL builder, `<picture>` element generator | SFCC script |
| `StaticAssetPipeline.js` | Asset manifest resolution, preload links, SRI, CDN URL rewriting | SFCC script |
| `TTFBReducer.js` | Early Hints, ESI markup, surrogate-key purge, TTFB measurement snippet | SFCC script |
| `CDNAuditReport.js` | Node.js CLI — crawls live storefront, scores CDN configuration, outputs JSON | Node.js CLI |

---

## Architecture: CDN Layer Map

```
Browser
  │
  │  ← HTTP 103 Early Hints (Link header, Akamai edge)
  │     preconnect: DIS CDN, static CDN
  │     preload:    main.css, vendors.js, LCP image
  │
  ▼
Akamai Edge (CDN)
  │
  ├── Static assets (JS/CSS/fonts)
  │     Cache-Control: public, max-age=31536000, immutable
  │     Content-hash filename — never stale, never purged
  │
  ├── DIS images
  │     Cache-Control: public, s-maxage=86400, Vary: Accept
  │     WebP/AVIF served to supporting browsers
  │     Separate CDN entry per format (Vary: Accept)
  │
  ├── HTML pages (anonymous)
  │     Cache-Control: public, s-maxage=300–600
  │     stale-while-revalidate=60 — zero-downtime refreshes
  │     Surrogate-Key: page-pdp product-{id} locale-en_GB
  │     ESI fragments for header/footer cached independently
  │
  └── Checkout / Cart / Authenticated
        Cache-Control: private, no-store
        Never reaches edge cache
  │
  ▼
SFCC Origin
  TTFBReducer: Link header → Akamai converts to 103
  CacheHeadersManager: sets all Cache-Control / Surrogate-Key
  ImageOptimizer: detects Accept header, builds DIS fmt=webp URLs
  StaticAssetPipeline: resolves content-hashed manifest entries
```

---

## TTFB Reduction Techniques

| Technique | Typical saving | Implementation |
|-----------|---------------|----------------|
| CDN edge caching (s-maxage) | 400–1200 ms | `CacheHeadersManager.applyPageHeaders()` |
| HTTP 103 Early Hints | 100–300 ms | `TTFBReducer.applyEarlyHints()` + Akamai rule |
| Immutable static asset caching | 200–600 ms | `StaticAssetPipeline.getPreloadLinks()` |
| ESI fragment caching | 50–200 ms | `TTFBReducer.esiInclude()` in ISML |
| stale-while-revalidate | 0 ms (no stale wait) | Baked into all page profiles |

---

## 1. CacheHeadersManager

```js
var CHM = require('*/cartridge/scripts/cdn/CacheHeadersManager');

// In Product-Show controller:
CHM.applyPageHeaders('pdp', res, {
    authenticated: customer.isAuthenticated(),
    hasBasket    : !basket || basket.productLineItems.length > 0,
    productID    : product.ID,
    locale       : request.getLocale()
});
// Sets: Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=60
//       Vary: Accept-Encoding, Accept-Language
//       Surrogate-Key: page-pdp product-M12345 locale-en_GB
//       Edge-Control: max-age=300

// In a controller serving JS or font files:
CHM.applyAssetHeaders('js-hashed', res);
// Sets: Cache-Control: public, max-age=31536000, immutable

// For a JSON fragment (navigation, promo bar):
CHM.applyFragmentHeaders(res, 120);  // 2-minute edge TTL
```

**Profile reference:**

| Profile key | Cache-Control | Edge TTL |
|------------|--------------|---------|
| `js-hashed` | `public, max-age=31536000, immutable` | 1 year |
| `css-hashed` | `public, max-age=31536000, immutable` | 1 year |
| `font` | `public, max-age=31536000, immutable` | 1 year |
| `dis-image` | `public, s-maxage=86400, stale-while-revalidate=3600` | 24 h |
| `dis-image-editorial` | `public, s-maxage=604800` | 7 days |
| `page-home` | `public, s-maxage=300` | 5 min |
| `page-plp` | `public, s-maxage=600` | 10 min |
| `page-pdp` | `public, s-maxage=300` | 5 min |
| `page-authenticated` | `private, no-cache, no-store` | Never |
| `page-cart` | `private, no-store` | Never |

---

## 2. ImageOptimizer

```js
var IO = require('*/cartridge/scripts/cdn/ImageOptimizer');

// Detect best format from the browser's Accept header (server-side)
var format = IO.detectBestFormat(request);
// → 'avif' | 'webp' | 'jpeg'

// Build an optimized DIS URL for a product tile
var url = IO.buildURL(product.getImage('large', 0).getURL(), {
    context: 'product-tile',
    format : format,
    width  : 400
});
// → https://dis.cdn.../image.jpg?sw=400&q=75&fmt=webp&op_sharpen=1

// Build a complete <picture> element (use in ISML via <isprint>)
var pictureHTML = IO.buildPicture(imageURL, {
    context : 'product-detail',
    alt     : product.name,
    width   : 800,
    height  : 1067,
    priority: true      // fetchpriority="high" for LCP image
});
```

**Quality ladder:**

| Context | JPEG | WebP | AVIF |
|---------|------|------|------|
| `hero-banner` | 82 | 78 | 65 |
| `product-detail` | 80 | 75 | 62 |
| `product-tile` | 75 | 70 | 58 |
| `thumbnail` | 65 | 60 | 50 |

**File size savings (same perceived quality):**

| Format | vs JPEG baseline |
|--------|-----------------|
| WebP | −25 to −35% |
| AVIF | −45 to −55% |

---

## 3. StaticAssetPipeline

```js
var SAP = require('*/cartridge/scripts/cdn/StaticAssetPipeline');
SAP.init();   // Warms the manifest cache at app start

// In a controller: get all <link rel="preload"> tags for the current page
var preloadLinks = SAP.getPreloadLinks('pdp');
// → [
//   '<link rel="preload" href="/css/main.a3f2b9c1.css" as="style" integrity="sha256-...">',
//   '<link rel="preload" href="/js/vendors.b4c1d2e3.js" as="script" fetchpriority="high">',
//   '<link rel="preload" href="/js/pdp.c5d3e4f5.js" as="script">',
// ]

// Inject in ISML:
<isloop items="${pdict.preloadLinks}" var="link">
  <isprint value="${link}" encoding="off"/>
</isloop>

// Rewrite a SFCC static URL to use your custom CDN hostname
var cdnURL = SAP.rewriteToCDN(URLUtils.staticURL('/images/logo.svg'));
```

**Manifest format** (generated by `webpack.sfcc.config.js`):
```json
{
  "js/vendors.js"        : { "file": "js/vendors.a3f2b9c1.js",  "integrity": "sha256-..." },
  "js/pdp.js"            : { "file": "js/pdp.c5d3e4f5.js",      "integrity": "sha256-..." },
  "css/main.css"         : { "file": "css/main.d6e4f7a2.css",   "integrity": "sha256-..." }
}
```

---

## 4. TTFBReducer

```js
var TTFB = require('*/cartridge/scripts/cdn/TTFBReducer');

// In Product-Show controller — set Link header so Akamai emits 103:
TTFB.applyEarlyHints('pdp', res, { heroImageURL: product.getImage('large',0).getURL() });
// Sets Link: <https://edge.sitecorecloud.io>; rel=preconnect,
//            </css/main.css>; rel=preload; as=style,
//            </hero.jpg>; rel=preload; as=image; fetchpriority=high, ...

// In ISML — use ESI for header/footer (cached independently at edge):
${TTFB.esiInclude('header')}
${TTFB.esiInclude('navigation')}

// After a product price change — purge just the affected pages:
TTFB.executePurge(['product-M12345', 'page-plp', 'locale-en_GB'], 'production');

// Inject TTFB measurement snippet in <head>:
${pdict.ttfbSnippet}
// (set in controller: pdict.ttfbSnippet = TTFB.buildTTFBSnippet(beaconURL))
```

---

## 5. CDNAuditReport (CLI)

```bash
# Install dependencies
npm install node-fetch cheerio

# Audit your storefront
node CDNAuditReport.js --base https://www.your-sfcc-site.com

# Save machine-readable output
node CDNAuditReport.js --base https://www.your-sfcc-site.com --output cdn-audit.json
```

**Example output:**

```
▶ PDP  https://www.example.com/product/blue-jeans
  Score: 72/100  TTFB: 620ms

  ✓ Cache-Control header present
  ✓ Page cache-control correct for type
  ✓ Vary: Accept-Encoding on cacheable pages
  ✗ Surrogate-Key header for CDN group purge
  ✗ Link header for Early Hints (103)
  ✓ TTFB < 800 ms
  ✗ Images served in WebP or AVIF
  ✗ LCP image preloaded in <head>

  Issues:
    • Missing Surrogate-Key — group CDN purging not possible
    • No Link header for Early Hints — add preload/preconnect hints
    • Images not served as WebP/AVIF — add fmt=webp to DIS URLs
    • No image preload in <head> — LCP image fetched late
```

**Scored checks (100-point scale):**

| Check | Weight |
|-------|--------|
| TTFB < 800 ms | 15 |
| Correct cache strategy per page type | 15 |
| LCP image preloaded | 10 |
| Cache-Control present | 10 |
| JS/CSS immutable | 12 |
| Images in WebP/AVIF | 12 |
| Surrogate-Key | 8 |
| Vary: Accept-Encoding | 8 |
| Images have srcset | 10 |
| Early Hints Link header | 10 |
| Images have width/height | 8 |
| Timing-Allow-Origin | 5 |

---

## Setup Checklist

- [ ] Copy all 4 `.js` scripts to `cartridges/YOUR_CARTRIDGE/cartridge/scripts/cdn/`
- [ ] Call `CacheHeadersManager.applyPageHeaders()` in every SFCC page controller
- [ ] Call `CacheHeadersManager.applyAssetHeaders('dis-image', res)` in any controller that returns image data
- [ ] Add `ImageOptimizer.detectBestFormat(request)` to base controller and pass format through `pdict`
- [ ] Replace all hardcoded `<img>` tags in ISML with `ImageOptimizer.buildPicture()` output
- [ ] Integrate `StaticAssetPipeline.getPreloadLinks()` into your ISML `<head>` template
- [ ] Set `staticCDNHostname` Site Preference to your CDN hostname
- [ ] Configure Akamai Property Manager rule to convert the `Link` header to HTTP 103 Early Hints
- [ ] Run `CDNAuditReport.js` against your staging environment and fix all red checks before go-live
- [ ] Add `CDNAuditReport.js` to your CI/CD pipeline and fail builds if overall score drops below 80
