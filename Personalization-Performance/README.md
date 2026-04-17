# /personalization-performance — Speed Without Sacrificing Personalization

Three accelerators that resolve the fundamental tension between personalization depth and page performance — with a live dashboard showing exactly what each personalization decision costs.

---

## Files

| File | Purpose | Runtime |
|------|---------|---------|
| `strategies/PersonalizationStrategy.js` | Tier classifier, segment engine, delivery config per tier | SFCC script |
| `caching/SegmentedCacheManager.js` | N-variant cache — one entry per segment, not per user | SFCC script |
| `dynamic-content/DynamicContentPipeline.js` | Shell + fragments pattern with async hydration | SFCC script + browser |
| `monitoring/PersonalizationImpactMonitor.js` | Latency overhead, cache hit rate, CLS impact per tier | SFCC script + browser |

---

## The Core Problem: Personalization Destroys Caching

Every byte of personalized content is a potential cache miss. Left unchecked, the pattern looks like the "Heavy personalization" scenario in the dashboard above:

```
Anonymous (15%)   → cache hit rate 91%  → avg 90ms   ← fine
Segment   (20%)   → cache hit rate 31%  → avg 540ms  ← too slow
Attribute (38%)   → cache hit rate 8%   → avg 1100ms ← critical
Individual(27%)   → cache hit rate 0%   → avg 2400ms ← site killer
```

When 65% of traffic is at ATTRIBUTE or INDIVIDUAL tier, the page cache is effectively disabled for the majority of your users. The toolkit restructures how personalization is delivered so the cache remains effective at every tier.

---

## The Solution: Personalization Performance Matrix

```
┌──────────────────────┬─────────────────────┬──────────────────────────┐
│ Tier                 │ Caching strategy     │ Delivery                 │
├──────────────────────┼─────────────────────┼──────────────────────────┤
│ ANONYMOUS            │ Full-page CDN cache  │ < 5ms from CDN PoP       │
│ SEGMENT (10 segs)    │ 10 cached variants   │ Edge, Vary: X-Segment    │
│ ATTRIBUTE (groups)   │ Shell + fragments    │ Shell from CDN, frags ~100ms │
│ INDIVIDUAL (session) │ No-cache, defer async│ SSR, but non-blocking    │
└──────────────────────┴─────────────────────┴──────────────────────────┘
```

---

## 1. PersonalizationStrategy

The entry point — classifies every request into the correct tier before any rendering begins.

```js
var PSEngine = require('*/cartridge/scripts/personalization/PersonalizationStrategy');

// In every page controller:
var classification = PSEngine.classify(customer, request, {
    hasBasket: basket && basket.productLineItems.length > 0,
    pageType : 'home'
});
// → { tier: 'SEGMENT', segment: 'loyal', reason: 'authenticated, segment-safe' }

// Get the delivery config for this tier
var config = PSEngine.getDeliveryConfig(classification.tier, classification.segment);
// → { cacheStrategy: 'segmented', edgeTTL: 300, varyHeaders: ['X-Customer-Segment', ...], ... }

// Apply cache headers based on tier
response.setHttpHeader('Cache-Control', 'public, s-maxage=' + config.edgeTTL);
response.setHttpHeader('Vary',           config.varyHeaders.join(', '));
response.setHttpHeader('X-Customer-Segment', classification.segment);

// Set segment cookie for client-side fragment loader
if (classification.segment) {
    response.setHttpHeader('Set-Cookie', PSEngine.buildSegmentCookie(classification.segment));
}

// Track for monitoring
PSEngine.recordTierUsage(classification.tier, 'home');
```

**Segment classification logic (in priority order):**

| Segment | Condition |
|---------|-----------|
| `staff` | In Staff customer group |
| `wholesale` | In Wholesale customer group |
| `vip` | In VIP customer group |
| `reactivation` | 5+ orders, last order > 90 days ago |
| `loyal` | 5+ orders |
| `abandoner` | Cart abandoned in last 7 days |
| `returning` | 1–4 orders |
| `new-visitor` | Authenticated, 0 orders |
| `anonymous` | Not authenticated |

---

## 2. SegmentedCacheManager

Maintains N cache entries (one per segment) instead of one per user. Keeps cache hit rates high even for authenticated traffic.

```js
var SCM = require('*/cartridge/scripts/personalization/SegmentedCacheManager');

// Pattern 1: Manual get/set
var cached = SCM.get('homepage-hero', segment, pageURL, { locale: 'en-GB', currency: 'GBP' });
if (!cached) {
    var html = renderHeroBanner(segment);
    SCM.set('homepage-hero', segment, pageURL, html, { ttl: 300 });
} else {
    var html = cached.content;
    // cached.isFallback = true means anonymous version was served (cold start)
}

// Pattern 2: getOrRender (preferred — fewer lines)
var html = SCM.getOrRender('homepage-hero', segment, function(seg) {
    return renderHeroBanner(seg);
}, { ttl: 300, pageURL: pageURL });

// Cache warm-up (call from a SFCC Job after content publish)
SCM.warmAll('homepage-hero', function(seg) {
    return renderHeroBanner(seg);
}, { ttl: 300 });

// Invalidation (call after merchandiser publishes new content)
SCM.invalidateAll('homepage-hero', pageURL);
```

**How fallback cascading works:**

```
Request: segment = 'loyal', namespace = 'homepage-hero'
  → Try key 'ps:seg:homepage-hero:loyal:...' → MISS
  → Try key 'ps:seg:homepage-hero:anonymous:...' → HIT (fallback)
  → Return anonymous content + flag isFallback=true
  → Background: render loyal variant and cache it
```

This means cold start shows the anonymous version instantly while the first loyal user's render populates the segment cache. No blank screens or slow fallbacks.

---

## 3. DynamicContentPipeline — Shell + Fragments

The Shell + Fragments pattern keeps pages fully cacheable even when they contain personalised content.

```js
var Pipeline = require('*/cartridge/scripts/personalization/DynamicContentPipeline');

// In the page controller — build the cacheable shell
var shellData = Pipeline.buildShell(pdict, ['hero-banner', 'promo-bar', 'product-recommendations']);
// Returns:
// shellData.fragmentPlaceholders → <div id="ps-fragment-hero-banner" data-fragment="..." ...>
// shellData.loaderScript         → <script> that fetches fragments after shell renders

// The PAGE CONTROLLER sets:
response.setHttpHeader('Cache-Control', 'public, s-maxage=600');  // Shell is cached!

// In fragment controllers (e.g. Personalization-HeroBanner):
var result = Pipeline.renderFragment('hero-banner', segment, function(seg) {
    return renderHeroBannerForSegment(seg);
}, { locale: request.getLocale() });

response.writer.print(result.html);
// fragment controllers set short TTLs or private headers per fragment type
```

**In the ISML template:**

```html
<head>
  <!-- Shell loader script (inline, tiny) -->
  <isprint value="${pdict.shellData.loaderScript}" encoding="off"/>
</head>
<body>
  <!-- Hero placeholder — fallback shows immediately, personalised version loads async -->
  <isprint value="${pdict.shellData.fragmentPlaceholders}" encoding="off"/>

  <!-- Rest of page — fully cached, same for all users -->
  <isinclude template="product/productGrid"/>
</body>
```

**What the browser does:**

```
1. Shell arrives from CDN → 5ms (< 1ms in same region)
2. Browser parses HTML, finds placeholder divs with fallback content
3. No CLS — fallbacks hold the layout space
4. ScriptLoader fires HIGH-priority fragments immediately: hero-banner, promo-bar
5. ScriptLoader defers LOW-priority fragments to requestIdleCallback: recommendations
6. Fragments arrive ~80–150ms later, swap into placeholders
7. User never sees a blank space or layout shift
```

---

## 4. PersonalizationImpactMonitor

**Server-side — in every page controller:**

```js
var Monitor = require('*/cartridge/scripts/personalization/PersonalizationImpactMonitor');

var profiler = Monitor.Profiler.startRequest({
    pageType: 'home',
    segment : classification.segment,
    tier    : classification.tier
});

// ... render the page ...

profiler.finish({ cacheHit: wasCached, fragmentCount: 3 });
```

**Client-side — in htmlHead.isml:**

```html
<isprint value="${pdict.fragmentTimingScript}" encoding="off"/>
<!-- Automatically tracks: fragment load times, fragment CLS, fallback rate -->
<!-- window.__psTimings available after load for debugging -->
```

**Monitoring endpoint (in a controller):**

```js
var stats = Monitor.Profiler.getStats();
// Returns:
// {
//   byTier: {
//     SEGMENT: { home: { requests: 4820, avgMs: 95, cacheHitRate: 0.88 } },
//     ATTRIBUTE: { home: { requests: 1240, avgMs: 140, cacheHitRate: 0.79 } }
//   },
//   bySegment: { loyal: 820, vip: 310, loyal_pct: 14.2, vip_pct: 5.4 },
//   alerts: [{ level: 'CRITICAL', message: '...' }]
// }
```

---

## Performance Targets (after toolkit applied)

| Tier | Traffic % | Cache hit rate | Avg latency | Target |
|------|-----------|---------------|------------|--------|
| Anonymous | 42% | > 95% | < 80ms | CDN edge |
| Segment | 40% | > 85% | < 120ms | Segmented cache |
| Attribute | 14% | > 75% | < 200ms | Shell + fragments |
| Individual | 4% | 0% (expected) | < 800ms | Async, non-blocking |

---

## Setup Checklist

- [ ] Copy all 4 files into `cartridges/YOUR_CARTRIDGE/cartridge/scripts/personalization/`
- [ ] Add segment classification to every page controller using `PersonalizationStrategy.classify()`
- [ ] Create custom profile attributes: `orderCount`, `daysSinceLastOrder`, `lastCartAbandonedAt`
- [ ] Apply `SegmentedCacheManager.getOrRender()` to all personalised ISML components
- [ ] Replace full-page personalised renders with `DynamicContentPipeline.buildShell()` + fragment endpoints
- [ ] Create fragment controller actions: `Personalization-HeroBanner`, `Personalization-PromoBar`, etc.
- [ ] Add `PersonalizationImpactMonitor.Profiler.startRequest()` to every controller
- [ ] Inject `fragmentTimingScript` in `htmlHead.isml`
- [ ] Create `Personalization-Stats` controller endpoint wired to `Monitor.Profiler.getStats()` for ops team
- [ ] Schedule `SegmentedCacheManager.warmAll()` as a SFCC Job after every content publish
- [ ] Limit active segments to ≤ 15 — every segment above this reduces cache efficiency without meaningful personalisation gain


The problem this module solves, stated plainly

Every personalized element on a page is a potential reason to bypass the cache. Most SFCC implementations handle this badly — they add a "Hi Sarah!" to the header, realize the whole page can't be cached anymore, set Cache-Control: private on the page controller, and watch their origin server TTFB climb from 80ms (cached) to 600ms (uncached) for every authenticated user. When 60%+ of your traffic is authenticated, that's a catastrophic performance regression disguised as a feature.

What each file does:- 

PersonalizationStrategy.js is the routing brain. It classifies every request into one of four tiers — ANONYMOUS, SEGMENT, ATTRIBUTE, or INDIVIDUAL — based on who the customer is and what they're looking at. The classification is fast (reads customer groups and profile attributes, no I/O) and deterministic, so the same customer always lands in the same tier. The tier then controls everything downstream: which caching strategy applies, what Cache-Control and Vary headers get set, which fragment endpoints get called, and what gets recorded in monitoring. The key design constraint is that segment count is capped at 15 — the dashboard's "Heavy personalization" scenario shows what happens when teams let segment count grow without discipline: cache hit rates collapse because the probability of a cache hit decreases with every new segment variant.

SegmentedCacheManager.js makes the SEGMENT tier viable at scale. Instead of one cache entry per URL (anonymous caching) or zero cache entries per URL (individual), it maintains exactly N entries per URL — one per segment. The cascading fallback is the key feature: on a cache miss for a specific segment, it immediately checks the anonymous cache and returns that instead of waiting for a fresh render. The first authenticated user to hit a cold segment cache never waits — they get the anonymous content immediately while their request populates the segment entry for everyone who follows. warmAll() takes this further by pre-rendering all segment variants from a Job after a content publish, so no user ever hits a cold segment cache.

DynamicContentPipeline.js implements the Shell + Fragments pattern. The page shell (navigation, product grid, footer) is rendered once and cached at the CDN for up to 10 minutes — every user gets it in < 5ms regardless of who they are. The buildShell() function inserts placeholder <div> elements with fallback HTML (skeleton or neutral default) into the shell at the positions where personalized content will appear. The inline JavaScript loader then fetches each fragment asynchronously after the shell is parsed — high-priority fragments immediately, low-priority ones deferred to requestIdleCallback. The fallback HTML in each placeholder prevents CLS: the layout space is held from the first paint, so when the personalized fragment arrives and swaps in, there's no visual jump. The shell remains 100% cacheable because it contains no user-specific data.

PersonalizationImpactMonitor.js measures what personalization is actually costing you. The server-side Profiler wraps every personalised controller action and records latency by tier+page-type combination, cache hit/miss counts, and segment distribution — all stored in CacheMgr and queryable from a health endpoint. The client-side FragmentTimingObserver (inlined as a <script> tag) listens for the custom ps:loaded events fired by the fragment loader, measures each fragment's network time from PerformanceResourceTiming, reports them to GA4 with non_interaction: true, and measures the CLS score before and after fragment hydration to quantify how much layout shift personalization is causing. The getDiagnostics() equivalent is Profiler.getStats(), which returns the full breakdown including alerts for any tier where cache hit rates have fallen below threshold.
