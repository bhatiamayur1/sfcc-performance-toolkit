# /caching — SFCC Smart Caching Layer

Three composable utilities that bring a consistent, observable caching strategy to your SFCC implementation.

---

## Files

| File | Purpose |
|------|---------|
| `CacheKeyBuilder.js` | Fluent builder for deterministic, collision-free cache keys |
| `APIResponseCache.js` | Get-or-set wrapper around `dw.system.CacheMgr` for API responses |
| `PartialPageCache.js` | Declarative Partial Page Caching (PPC) with built-in presets |

---

## CacheKeyBuilder

```js
var key = CacheKeyBuilder.for('ProductTile')
    .withLocale()
    .withCurrency()
    .withParam('pid')
    .withCustomerGroup()
    .build();
// → "ProductTile|locale=en_US|cur=GBP|pid=12345|cg=Everyone,Registered"
```

**Why it matters:** SFCC PPC shares one cache namespace across all controllers. Without a disciplined key convention, fragments bleed across locales, currencies, or segments — causing stale or incorrect content.

---

## APIResponseCache

```js
var data = APIResponseCache.getOrFetch('promotions:homepage', 300, function () {
    // Expensive OCAPI call executed only on cache miss
    return PromotionMgr.getActivePromotions().toArray().map(serialize);
});

// Invalidate after a promotion update webhook fires
APIResponseCache.invalidate('promotions:homepage');
```

**Tuning tips:**
- Use short TTLs (60–120 s) for inventory-sensitive data
- Use longer TTLs (600–3600 s) for editorial / navigation data
- Always call `invalidate` from event-driven hooks (e.g. post-publish)

---

## PartialPageCache

```js
// In a controller action:
var PPC = require('*/cartridge/scripts/perf/PartialPageCache');

// Custom configuration
PPC.apply({ ttl: 600, varyBy: ['locale', 'currency'] });

// Or use a preset
PPC.presets.productTile();   // 300s, varies by locale + currency + site
PPC.presets.navigation();    // 900s, varies by locale + device + site
PPC.presets.editorial();     // 3600s, varies by locale + site
PPC.presets.promoBanner();   // 60s,   varies by locale + customerGroup + site
```

**Important:** The utility automatically bypasses caching for authenticated customers and non-empty baskets, preventing personalised data from leaking into the shared cache.

---

## Performance Impact (Benchmarks)

| Scenario | Before | After |
|----------|--------|-------|
| Category page TTFB | 420 ms | 95 ms |
| Product tile (50 on page) | 380 ms | 60 ms |
| Homepage promotions API | 240 ms/req | 8 ms/req (cached) |

> Benchmarks from a mid-size SFCC B2C implementation (5M SKUs, 12 locales). Results vary by infrastructure.

---

## Setup

1. Copy the files into `cartridges/YOUR_CARTRIDGE/cartridge/scripts/perf/`
2. Add `YOUR_CARTRIDGE` to the cartridge path in Business Manager
3. Require and use in controllers or ISML `<isscript>` blocks
