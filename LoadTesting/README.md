# /load-testing — Traffic Simulation, Spike Testing & Checkout Stress

Three k6 test scenarios, a Node.js bottleneck analyser, and a mock SFCC server — everything needed to stress-test a SFCC storefront end-to-end without touching production.

---

## Files

| File | Purpose | Runtime |
|------|---------|---------|
| `scenarios/baseline-load-test.js` | Mixed storefront traffic — establishes performance baselines | k6 |
| `scenarios/spike-test.js` | Flash sale / traffic spike simulation (instant, wave, sustained) | k6 |
| `scenarios/checkout-stress-test.js` | Full checkout funnel stress test with session management | k6 |
| `scripts/BottleneckAnalyser.js` | Parses k6 JSON results → ranked bottlenecks + SFCC fixes | Node.js |
| `scripts/mock-sfcc-server.js` | Mock SFCC Express server for local testing without a sandbox | Node.js |

---

## Quick Start

### Option A — Run against the mock server (no sandbox needed)

```bash
# Install dependencies
cd load-testing
npm install

# Terminal 1: Start mock server
npm run mock

# Terminal 2: Run baseline test against mock
npm run test:baseline:local

# Analyse results
npm run analyse
```

### Option B — Run against a real SFCC sandbox

```bash
# Install k6
brew install k6  # macOS
choco install k6 # Windows

# Baseline test
k6 run --env BASE_URL=https://your-sandbox.demandware.net/s/SiteID \
   scenarios/baseline-load-test.js

# With JSON output for analysis
k6 run --env BASE_URL=https://... \
   --out json=results/baseline.json \
   scenarios/baseline-load-test.js

node scripts/BottleneckAnalyser.js results/baseline-summary.json
```

---

## Test Scenarios

### 1. Baseline Load Test

Simulates realistic mixed storefront traffic to establish **before/after benchmarks** for any optimization work.

```bash
npm run test:baseline
npm run test:baseline:out    # Save JSON for analysis
```

**Traffic mix:**

| Journey | % of VUs | Pages visited |
|---------|---------|--------------|
| Browse (Category + PLP) | 55% | Homepage → Category → Refinements → Page 2 |
| Product Viewer (PDP) | 25% | PDP → Variant select → Image carousel |
| Searcher | 12% | Type-ahead suggest → Search results → Refine |
| Cart Adder | 5% | PDP → Add to cart → Mini-cart → Cart page |
| Checkout | 3% | Full funnel (address → shipping → payment step) |

**Load stages:**
```
2 min → ramp to 10 VUs (warm-up)
5 min → ramp to 50 VUs
10 min → hold at 50 VUs (baseline measurement)
2 min → ramp to 100 VUs (light spike)
5 min → hold at 100 VUs
3 min → ramp down to 0
```

**SLA thresholds (test fails if breached):**
- HTTP p95 < 2000ms
- Page load p95 < 1500ms
- API calls p95 < 800ms
- Error rate < 1%

---

### 2. Spike Test

Three spike shapes that expose different failure modes:

```bash
npm run test:spike              # Instant: 0 → 500 VUs in 10s
npm run test:spike:wave         # Wave: 200 → 400 → 600 VUs
npm run test:spike:sustained    # Sustained: 300 VUs × 10 min
```

**What each shape finds:**

| Spike Type | Failure modes exposed |
|-----------|----------------------|
| `instant` | Thread pool exhaustion, CDN cold cache, inventory contention |
| `wave` | Recovery time between peaks, auto-scaling lag |
| `sustained` | Memory leaks, connection pool depletion, session store capacity |

**Custom metrics captured:**
- `spike_ttfb_ms` — Time to First Byte during spike (CDN indicator)
- `spike_rate_limit_429` — Gateway rate limit hits
- `spike_timeout_count` — Hard timeout occurrences
- `spike_stock_check_ms` — Inventory API latency under load

**SLA thresholds (lenient — some degradation expected at peak):**
- HTTP p95 < 5000ms (vs 2000ms baseline)
- Error rate < 5% (vs 1% baseline)
- Rate limit hits < 500 total
- Timeouts < 100 total

---

### 3. Checkout Stress Test

Exercises the most resource-intensive flow with three profiles:

```bash
npm run test:checkout           # Default: 25 concurrent sessions
npm run test:checkout:stress    # Stress: ramp to 200 concurrent
npm run test:checkout:soak      # Soak: 50 concurrent × 30 min
```

**Session management:** Each k6 VU maintains its own cookie jar (dwsid, dwanonymous) and extracts CSRF tokens from HTML responses — exactly as a real browser would.

**Step-level timing metrics:**

| Step | Metric | Target p95 |
|------|--------|-----------|
| Address form submit | `checkout_address_step_ms` | < 3000ms |
| Shipping methods | `checkout_shipping_step_ms` | < 5000ms |
| Payment page load | `checkout_payment_step_ms` | < 5000ms |
| Place order | `checkout_place_order_ms` | < 10000ms |
| Full funnel end-to-end | `checkout_funnel_total_ms` | < 30000ms |

**Safety guard:** `MOCK_PAYMENT=true` by default. The test uses Stripe test card `4242 4242 4242 4242` and never submits real payment details. Only set `MOCK_PAYMENT=false` if your sandbox is configured with a test payment gateway.

**What the soak test finds:**
- Memory leaks in SFCC script execution context
- Database connection pool exhaustion (common with OMS integrations)
- Session store capacity limits
- CSRF token generation slowdown under sustained load

---

## Bottleneck Analyser

```bash
# Terminal report
node scripts/BottleneckAnalyser.js results/baseline-summary.json

# HTML report (paste into a browser)
node scripts/BottleneckAnalyser.js results/baseline-summary.json --format html

# Analyse all result files
node scripts/BottleneckAnalyser.js results/*.json
```

**Sample output:**

```
[1]  ✗ CRITICAL  Page response time p95
     Measured: 3420 ms  (warn:1500ms crit:3000ms)
     SFCC Fixes:
       • Enable CDN caching (s-maxage) — most impactful single change
       • Apply PartialPageCache.js to navigation, promo banners, product tiles
       • Run CriticalCSSExtractor.js to eliminate render-blocking CSS

[2]  ⚠ WARNING  AJAX/API response time p95
     Measured: 680 ms  (warn:500ms crit:1500ms)
     SFCC Fixes:
       • Wrap slow OCAPI calls with APIResponseCache.getOrFetch()
       • Use RequestBatcher.js to batch product/category data calls
```

**Detected bottleneck categories:**

| Rule ID | Metric | SFCC Modules that fix it |
|---------|--------|------------------------|
| `PAGE_P95_HIGH` | Page response p95 | `CacheHeadersManager`, `PartialPageCache`, `CriticalCSSInliner` |
| `API_P95_HIGH` | AJAX/API p95 | `APIResponseCache`, `RequestBatcher`, `TokenCache` |
| `CHECKOUT_FUNNEL_SLOW` | Full funnel p95 | `PaymentGatewayAdapter`, `OMSIntegrationAdapter`, `CheckoutStepReducer` |
| `PLACE_ORDER_SLOW` | Place order p95 | `CheckoutBottleneckProfiler`, `IntegrationCircuitBreaker` |
| `SPIKE_TTFB_HIGH` | TTFB during spike | `TTFBReducer`, `CacheHeadersManager`, `SearchIndexWarmup` |
| `ERROR_RATE_HIGH` | HTTP errors | `RetryHandler`, `IntegrationCircuitBreaker`, `HealthDashboard` |
| `CHECKOUT_ERRORS` | Session errors | Session config, CSRF validation, `AsyncIntegrationQueue` |
| `RATE_LIMIT_HITS` | 429 responses | `RetryHandler`, `APIResponseCache`, OCAPI quota increase |

---

## Mock SFCC Server

```bash
npm run mock              # Default settings
npm run mock:slow         # 3× latency, 5% errors (simulate degraded environment)
npm run mock:spike        # Low rate limit (tests spike recovery)
```

**Configurable parameters:**

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | 3000 | Server port |
| `--error-rate` | 0.01 | Fraction of requests that return 500 |
| `--latency-multiplier` | 1.0 | Scales all response latencies |
| `--rate-limit-rpm` | 2000 | Requests/minute before 429 |

**Simulated endpoints:**

| Endpoint | Mock behaviour |
|----------|---------------|
| `GET /s/:site/` | Homepage HTML with session cookie |
| `GET /s/:site/search` | Search results with realistic latency |
| `GET /s/:site/product/:pid` | PDP HTML with CSRF token |
| `POST /s/:site/Cart-AddProduct` | Add to cart, 3% 409 inventory conflict |
| `POST /s/:site/CheckoutShippingServices-SubmitShipping` | 2% address validation failure |
| `POST /s/:site/CheckoutServices-PlaceOrder` | Mock payment gateway delay, 2% decline |

---

## Results Directory

k6 outputs go to `results/` (gitignored). Expected files:

```
results/
├── baseline.json                    ← Raw k6 streaming output (--out json)
├── baseline-summary.json            ← Summary from handleSummary()
├── spike-instant-summary.json
├── spike-wave-summary.json
├── checkout-stress-default-summary.json
└── *-bottlenecks.html               ← Generated by BottleneckAnalyser
```

---

## Recommended Testing Sequence

```
1. npm run mock                        Start mock server locally
2. npm run test:baseline:local         Establish baseline on mock
3. npm run analyse                     Identify any configuration issues
4. ↓  Fix issues in your SFCC cartridge
5. npm run test:baseline               Run on real sandbox (tag as pre-optimization)
6. ↓  Deploy optimization changes
7. npm run test:baseline               Run again (tag as post-optimization)
8. npm run analyse                     Compare — quantify improvement
9. npm run test:spike                  Verify spike resilience
10. npm run test:checkout:stress        Verify checkout under pressure
11. npm run analyse:all                 Final comprehensive report
```
