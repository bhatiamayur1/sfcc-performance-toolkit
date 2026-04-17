# /headless-performance — SFCC + React Storefront Performance

Four accelerators targeting the specific bottlenecks that appear when you move from SFCC ISML to a headless React stack — API waterfalls, edge cache misses, unnecessary React re-renders, and the SPA navigation performance gap.

---

## Files

| File | Purpose | Runtime |
|------|---------|---------|
| `api-layer/SCAAPIOptimizer.js` | SCAPI composite requests, field projections, deduplication, adaptive batching | Node.js / Edge |
| `edge-caching/EdgeCacheStrategy.js` | Edge cache profiles, surrogate keys, SWR handler, platform purge helpers | Edge Function |
| `react-storefront/ReactPerformanceKit.jsx` | React hooks: SWR query, intersection loading, hover prefetch, memoised tiles | React (browser) |
| `monitoring/HeadlessMonitor.js` | CWV + headless-specific metrics: SCAPI latency, waterfall detection, cache hit rate | Browser |

---

## Architecture

See the diagram above. The headless stack introduces performance concerns at five distinct layers:

```
Browser (React SPA)          useSFCCQuery, MemoizedProductTile, usePrefetchOnHover
       ↕  < 5ms (hit) / SSR time (miss)
Edge Network (CDN PoP)       EdgeCacheStrategy: s-maxage, SWR, surrogate-key purge
       ↕  100–400ms
Next.js SSR Layer            ReactPerformanceKit: parallel data, intersection load
       ↕  150–300ms
API Optimisation             SCAAPIOptimizer: composite, dedupe, field projection, batch
       ↕  80–600ms
SFCC SCAPI / OCAPI           Shopper APIs, Products, Search, Checkout
       ↕
SFCC Origin (B2C Commerce)   Catalog, OMS, Promotions, Customer
```

The edge layer is the highest-leverage layer — a cache hit costs < 5ms vs 300–800ms for a full SSR roundtrip.

---

## 1. SCAAPIOptimizer

The most impactful file in the module. A single Next.js PDP page can trigger 5+ sequential SCAPI calls: product → pricing → inventory → promotions → recommendations. At 150ms each, that's 750ms before the page can render — the classic waterfall.

```js
import { SCAAPIOptimizer } from '@/lib/sfcc/SCAAPIOptimizer'

const optimizer = new SCAAPIOptimizer({
    shortCode   : process.env.SFCC_SHORT_CODE,
    orgId       : process.env.SFCC_ORG_ID,
    siteId      : process.env.SFCC_SITE_ID,
    clientId    : process.env.SFCC_CLIENT_ID,
    clientSecret: process.env.SFCC_CLIENT_SECRET,
    locale      : 'en-GB',
    currency    : 'GBP'
})

// In your Next.js page (app/product/[pid]/page.tsx):
export default async function PDPPage({ params }) {
    // ONE network roundtrip instead of five parallel fetches
    const data = await optimizer.composite([
        { type: 'product',    id: params.pid, opts: { view: 'product-detail' } },
        { type: 'prices',     ids: [params.pid] },
        { type: 'inventory',  ids: [params.pid] },
        { type: 'promotions', ids: ['promo-summer-sale'] }
    ])
    return <PDPLayout data={data} />
}
```

**Field projections** — `product-tile` view strips the response from ~8KB to ~1.2KB by removing unused fields (full description, all image groups, all variants):

```js
// PLP: only fields needed for a tile
const products = await optimizer.getProducts(ids, { view: 'product-tile' })

// PDP: full fields including variants, recommendations
const product = await optimizer.getProduct(pid, { view: 'product-detail' })
```

**Adaptive batching** — calls fired within a 10ms window are automatically merged:

```js
// These three calls fire in the same event loop tick → merged into one SCAPI request
const [a, b, c] = await Promise.all([
    optimizer.getProducts(['P001']),
    optimizer.getProducts(['P002']),
    optimizer.getProducts(['P003'])
])
// Single SCAPI call: /products?ids=P001,P002,P003
```

---

## 2. EdgeCacheStrategy

Edge caching is the only technique that reduces latency to near-zero for cached responses. Configure it correctly and your PDP page serves from the CDN PoP nearest the user in < 5ms instead of SSR-generating in 300–800ms.

```ts
// middleware.ts (Next.js) or Cloudflare Worker
import { EdgeCacheStrategy, edgeCacheHandler } from '@/lib/sfcc/EdgeCacheStrategy'

export default async function middleware(request: NextRequest) {
    const url      = new URL(request.url)
    const pageType = url.pathname.includes('/product/') ? 'pdp' : 'plp'
    const strategy = EdgeCacheStrategy.forPageType(pageType)
    const locale   = request.headers.get('x-locale') || 'en-GB'
    const currency = request.headers.get('x-currency') || 'GBP'
    const pid      = url.searchParams.get('pid') || undefined

    const response = NextResponse.next()

    // Apply all cache headers in one call
    const headers = strategy.toHeaders({ productId: pid, locale, currency })
    Object.entries(headers).forEach(([k, v]) => response.headers.set(k, v))

    return response
}
```

**Cache profiles:**

| Page | s-maxage | stale-while-revalidate | stale-if-error |
|------|---------|----------------------|----------------|
| Home | 300s | 60s | 24h |
| PLP | 600s | 120s | 24h |
| PDP | 300s | 60s | 1h |
| Search | 120s | 60s | 1h |
| Cart | 0 (private) | — | — |

**Surrogate-key purge after price change:**

```js
import { PurgeMethods } from '@/lib/sfcc/EdgeCacheStrategy'

// Called from a SFCC webhook or scheduled job
await PurgeMethods.vercel(['product:P001', 'page:pdp', 'locale:en-GB'])
await PurgeMethods.cloudflare(['product:P001'], zoneId, apiToken)
```

---

## 3. ReactPerformanceKit

```jsx
import {
    useSFCCQuery, useIntersectionLoad, usePrefetchOnHover,
    useParallelData, MemoizedProductTile, useImagePriority,
    ProductGridOptimizer
} from '@/lib/sfcc/ReactPerformanceKit'

// SWR data fetching with stale-while-revalidate
function ProductPage({ pid }) {
    const { data, isLoading } = useSFCCQuery(
        `/api/product/${pid}`,
        () => optimizer.getProduct(pid),
        { revalidateMs: 5 * 60 * 1000 }
    )
    return isLoading ? <Skeleton /> : <Product data={data} />
}

// Parallel data — render as each piece arrives
function PDPData({ pid }) {
    const [product, pricing, inventory] = useParallelData([
        { key: `/api/product/${pid}`,   fetcher: () => optimizer.getProduct(pid) },
        { key: `/api/prices/${pid}`,    fetcher: () => optimizer.getPrices([pid]) },
        { key: `/api/inventory/${pid}`, fetcher: () => optimizer.getInventory([pid]) }
    ])
    // Product renders first; price and inventory fill in as they arrive
    return <PDPLayout product={product} pricing={pricing} inventory={inventory} />
}

// Intersection-deferred loading (off-screen data not fetched)
function BelowFoldRecommendations({ pid }) {
    const { ref, data, isLoading } = useIntersectionLoad(
        () => optimizer.composite([{ type: 'recommendations', id: pid }]),
        `/api/recommendations/${pid}`
    )
    return <div ref={ref}>{isLoading ? <Skeleton /> : <RecommendList data={data} />}</div>
}

// Product grid with memoisation and priority image
function ProductGrid({ products }) {
    return (
        <ProductGridOptimizer
            products={products}
            columns={4}
            rowHeight={400}
            renderItem={(product, index) => (
                <MemoizedProductTile
                    key={product.id}
                    product={product}
                    isPriority={useImagePriority(index)}  // First 8 tiles: fetchPriority="high"
                />
            )}
        />
    )
}
```

---

## 4. HeadlessMonitor

```tsx
// app/layout.tsx — initialise once
'use client'
import { HeadlessMonitor } from '@/lib/sfcc/HeadlessMonitor'
import { useEffect } from 'react'

export function AnalyticsProvider({ pageType, children }) {
    useEffect(() => {
        HeadlessMonitor.init({
            siteId  : process.env.NEXT_PUBLIC_SFCC_SITE_ID,
            pageType,
            endpoint: '/api/analytics/vitals',
            debug   : process.env.NODE_ENV === 'development'
        })
    }, [])
    return children
}

// Instrument a SCAPI call (data layer, not React component)
const product = await HeadlessMonitor.trackAPICall(
    'getProduct',
    () => optimizer.getProduct(pid),
    { productId: pid }
)

// Get live diagnostics (call in a dev toolbar or admin page)
const diag = HeadlessMonitor.getDiagnostics()
// → { apiCalls: { total, avgLatencyMs, slowCalls }, edgeCache: { hitRate }, routeChanges }
```

**Headless-specific metrics tracked:**

| Metric | Good | Poor | What it catches |
|--------|------|------|----------------|
| `ROUTE_CHANGE` | < 200ms | > 1000ms | SPA navigation performance |
| `SCAPI_CALL` | < 200ms | > 800ms | Individual API call latency |
| `SCAPI_COMPOSITE` | < 300ms | > 1200ms | Multi-resource fetch latency |
| `HYDRATION` | < 50ms | > 300ms | SSR → client takeover time |
| `REACT_RENDER` | < 50ms | > 200ms | Component render time |
| `EDGE_CACHE_RATE` | > 80% | < 50% | CDN hit/miss ratio |
| `WATERFALL_DETECTED` | — | gap > 50ms | Sequential API calls |

---

## Setup

```bash
# Install dependencies
npm install swr react-intersection-observer
```

- [ ] Copy `api-layer/SCAAPIOptimizer.js` to `src/lib/sfcc/`
- [ ] Copy `edge-caching/EdgeCacheStrategy.js` to `src/lib/sfcc/`
- [ ] Copy `react-storefront/ReactPerformanceKit.jsx` to `src/lib/sfcc/`
- [ ] Copy `monitoring/HeadlessMonitor.js` to `src/lib/sfcc/`
- [ ] Set environment variables: `SFCC_SHORT_CODE`, `SFCC_ORG_ID`, `SFCC_SITE_ID`, `SFCC_CLIENT_ID`, `SFCC_CLIENT_SECRET`
- [ ] Add `EdgeCacheStrategy` to your Next.js `middleware.ts`
- [ ] Wrap your `_app.tsx` / `layout.tsx` with `HeadlessMonitor.init()`
- [ ] Replace individual SCAPI calls in page components with `optimizer.composite()`
- [ ] Replace `<img>` tags in product tiles with `MemoizedProductTile`
- [ ] Configure `PurgeMethods.vercel()` in your SFCC webhook endpoint
