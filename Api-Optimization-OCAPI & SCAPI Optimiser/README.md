# /api-optimization — OCAPI & SCAPI Optimiser

Three utilities that reduce API round-trips, handle transient failures gracefully, and eliminate redundant auth overhead.

---

## Files

| File | Purpose |
|------|---------|
| `RequestBatcher.js` | Chunks IDs and fetches products/resources in batch OCAPI calls |
| `RetryHandler.js` | Exponential backoff + jitter for transient API failures |
| `TokenCache.js` | Caches OAuth2 client-credential tokens to avoid redundant auth requests |

---

## RequestBatcher

Turns N individual product API calls into ⌈N ÷ batchSize⌉ calls:

```js
var batcher = require('*/cartridge/scripts/perf/RequestBatcher');
var token   = TokenCache.getToken(cfg);

var result = batcher.products(productIDs, { batchSize: 24, expand: 'images,prices' }, token);
// result.products → flat array of OCAPI product objects
// result.errors   → any batches that failed (partial success)
```

**Wave processing:** Batches run in configurable waves (default: 2 at a time) to avoid overwhelming the OCAPI thread pool.

---

## RetryHandler

```js
var RetryHandler = require('*/cartridge/scripts/perf/RetryHandler');

// Returns { ok, value, attempts, lastError }
var result = RetryHandler.wrap(function () {
    return inventoryService.call({ skuID: 'ABC123' });
}, { maxAttempts: 3, baseDelayMs: 200 });

// Or throw on failure
var data = RetryHandler.wrapOrThrow(function () {
    return pricingService.call(params);
});
```

**Backoff formula:**  
`delay = min(baseDelay × 2^(attempt-1), maxDelay) × (1 ± 30% jitter)`

| Attempt | Base (150ms) | With jitter |
|---------|-------------|-------------|
| 1       | 150 ms      | 105–195 ms |
| 2       | 300 ms      | 210–390 ms |
| 3       | 600 ms      | 420–780 ms |

---

## TokenCache

```js
var TokenCache = require('*/cartridge/scripts/perf/TokenCache');

var token = TokenCache.getToken({
    clientID    : 'my-client-id',
    clientSecret: 'my-secret',
    tokenURL    : 'https://account.demandware.com/dwsso/oauth2/access_token'
});

// Handle 401 → force refresh
if (apiResult.statusCode === 401) {
    TokenCache.invalidate('my-client-id');
    token = TokenCache.getToken(cfg); // fetches fresh
}
```

**Impact:** Reduces `/oauth2/token` calls by ~99% under normal load. Each token is cached for `(expires_in − 60)` seconds to pre-empt expiry.

---

## Recommended Composition

```js
var token  = TokenCache.getToken(cfg);

var result = RetryHandler.wrap(function () {
    return RequestBatcher.products(ids, { batchSize: 24 }, token);
}, { maxAttempts: 2, baseDelayMs: 150 });

if (result.ok) {
    renderProducts(result.value.products);
}
```

---

## Setup

1. Copy files into `cartridges/YOUR_CARTRIDGE/cartridge/scripts/perf/`
2. Store `clientID`, `clientSecret`, and `tokenURL` in Site Preferences (encrypted custom attribute)
3. Configure OCAPI Shop resource permissions in Business Manager → Administration → Site Development → Open Commerce API Settings
