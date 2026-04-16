# /third-party-integration-performance — Payment, OMS & ERP Resilience

Four accelerators that make every third-party integration in SFCC resilient, observable, and fast — applying circuit breakers, async queuing, intelligent retry, and live health dashboards across payment gateways, OMS, and ERP systems.

---

## Files

| File | Purpose | Runtime |
|------|---------|---------|
| `IntegrationCircuitBreaker.js` | Circuit breaker with CLOSED/OPEN/HALF_OPEN states, slow-call detection, per-profile tuning | SFCC script |
| `AsyncIntegrationQueue.js` | Durable async job queue via SFCC Custom Objects with exponential backoff retry | SFCC script + Job |
| `PaymentGatewayAdapter.js` | Resilient payment wrapper: hard timeout, idempotency keys, dual-gateway failover | SFCC script |
| `OMSIntegrationAdapter.js` | OMS/ERP adapter: async order submission, tiered ERP price cache, reconciliation Job | SFCC script + Job |
| `IntegrationHealthDashboard.js` | Health aggregator + live ops dashboard widget (polls every 30s) | SFCC script + HTML |

---

## The Core Problem: Cascade Failures

Without these patterns, a single degraded third-party service cascades into full site outage:

```
Payment gateway slows to 8s response
  → Every checkout thread waits 8s
    → SFCC thread pool exhausts (default: 50 threads)
      → All page requests queue behind checkout threads
        → Site-wide timeout / 503
          → Revenue = £0
```

With circuit breakers + async queuing, the cascade stops at the first service boundary.

---

## Architecture: Resilience Layers

```
SFCC Controller
  │
  ├── PaymentGatewayAdapter.charge()          ← MUST be synchronous (money)
  │     ├── IntegrationCircuitBreaker (payment profile)
  │     │     ├── CLOSED  → call proceeds
  │     │     ├── OPEN    → fast-fail, fallback returned in < 1ms
  │     │     └── HALF_OPEN → one probe allowed
  │     ├── Hard timeout (8s wall-clock)
  │     ├── Idempotency key (no duplicate charges)
  │     ├── Retry (transient errors only, exponential backoff)
  │     └── Dual-gateway failover (primary → secondary)
  │
  ├── OMSIntegrationAdapter.submitOrderAsync()  ← Non-blocking (queue it)
  │     └── AsyncIntegrationQueue.enqueue()
  │           └── SFCC Custom Object (durable, survives restart)
  │
  └── OMSIntegrationAdapter.getERPPrice()       ← Cached (don't call on every page)
        ├── CacheMgr HOT tier (60s)
        ├── CacheMgr WARM tier (600s)
        ├── Live ERP call (with circuit breaker)
        └── Stale price fallback (if ERP is down)

Background (every 2 min, SFCC Job):
  AsyncIntegrationQueue.processQueue()
    └── Picks up PENDING entries, calls registered handlers
          └── oms.createOrder handler → callOMS() → update order.custom.omsSubmitted

Hourly (SFCC Job):
  OMSIntegrationAdapter.reconcile()
    └── Finds orders without omsSubmitted=true → re-queues as CRITICAL

Every 30s (Ops browser):
  IntegrationHealthDashboard → polls /IntegrationHealth-Summary
    └── Circuit states + queue depths + health scores → live dashboard
```

---

## 1. IntegrationCircuitBreaker

```js
var CB = require('*/cartridge/scripts/integrations/IntegrationCircuitBreaker');

// Get-or-create a breaker (profile inferred from name)
var breaker = CB.get('stripe-charge');       // → payment profile
var breaker = CB.get('sap-order-create');    // → oms profile
var breaker = CB.get('avalara-tax');         // → tax profile

// Wrap any service call
var result = breaker.call(function () {
    return myService.call(params);
}, function fallback(err) {
    // Called immediately when circuit is OPEN (< 1ms)
    return { error: 'Service temporarily unavailable. Retrying.' };
});

// Check status (for health endpoints)
var status = breaker.status();
// → { state: 'OPEN', failures: 3, openedAt: 1700000000000, ... }

// Manual reset after confirmed service recovery
breaker.reset();
```

**Per-profile thresholds:**

| Profile | Fail threshold | Open duration | Slow call limit |
|---------|---------------|--------------|----------------|
| `payment` | 3 failures | 30 s | 5000ms / 50% slow rate |
| `oms` | 5 failures | 60 s | 8000ms / 60% slow rate |
| `erp` | 5 failures | 120 s | 10000ms / 70% slow rate |
| `tax` | 8 failures | 60 s | 3000ms / 40% slow rate |
| `fraud` | 5 failures | 45 s | 2000ms / 30% slow rate |

**State is stored in `CacheMgr`** — shared across all SFCC threads in the PIG. One thread detecting a failure immediately protects all other threads.

---

## 2. AsyncIntegrationQueue

```js
var Queue = require('*/cartridge/scripts/integrations/AsyncIntegrationQueue');

// After payment success — enqueue OMS submission (non-blocking, returns in < 5ms)
Queue.enqueue('oms.createOrder', {
    sfccOrderNo: order.getOrderNo(),
    // ... serialised order data
}, { priority: 'HIGH', orderId: order.getOrderNo() });

// Register a handler (in cartridge initialisation):
Queue.registerHandler('oms.createOrder', function (payload) {
    var result = OMSAdapter.callOMSAPI(payload);
    return { success: result.ok, error: result.error };
});

// Monitor queue depth
var stats = Queue.getStats();
// → { pending: 12, failed: 2, deadLetter: 0, total: 14 }
```

**Configure as a SFCC Job (every 2 minutes):**
```
Module : app_custom_storefront/cartridge/scripts/integrations/AsyncIntegrationQueue
Method : processQueue
```

**Retry schedule (exponential backoff + ±20% jitter):**

| Attempt | Min delay | Max delay |
|---------|----------|----------|
| 1 | ~24s | ~36s |
| 2 | ~48s | ~72s |
| 3 | ~96s | ~144s |
| 4 | ~192s | ~288s |
| 5 | Dead-letter |  |

---

## 3. PaymentGatewayAdapter

```js
var Gateway = require('*/cartridge/scripts/integrations/PaymentGatewayAdapter');

// Generate once at checkout start — persist to basket for retry safety
var idempotencyKey = Gateway.generateIdempotencyKey(basket.UUID);

// Charge (handles circuit breaker, retry, failover internally)
var result = Gateway.charge({
    orderId       : order.getOrderNo(),
    amount        : basket.getTotalGrossPrice().getValue(),
    currency      : session.getCurrency().getCurrencyCode(),
    paymentToken  : paymentInstrument.creditCardToken,
    idempotencyKey: idempotencyKey    // Same key = gateway de-duplicates
});

if (!result.success) {
    return renderError(result.errorMessage);
    // result.errorCode distinguishes: 'card_declined' vs 'api_connection_error' vs 'partial_authorisation'
}

// result.gatewayUsed tells you if secondary was used
// result.latencyMs for monitoring
```

**Failover flow:**
```
charge() called
  → Primary gateway (Stripe) with circuit breaker + 2 retries
      Success? → return
      Non-transient decline? → return failure (don't retry on secondary — same card will decline)
      Transient failure / circuit open? → try secondary (Adyen)
          → return secondary result
```

**Idempotency key pattern:**
```
Key: "order-{orderNo}-{random8chars}"
Persisted to: basket.custom.paymentIdempotencyKey
On retry: same key reused → gateway returns original charge result (no double charge)
```

---

## 4. OMSIntegrationAdapter

```js
var OMS = require('*/cartridge/scripts/integrations/OMSIntegrationAdapter');

// Post-payment: async submit (preferred — shows confirmation page immediately)
OMS.submitOrderAsync(order);
// Returns { queued: true, entryId: '...' } in < 5ms

// ERP price lookup with tiered cache (for product display)
var priceData = OMS.getERPPrice('SKU-12345', 'GBP', { priceBook: 'SALE-2024' });
// → { price: 49.99, currency: 'GBP', fromCache: true, stale: false }
// If ERP is down: { price: 49.99, fromCache: true, stale: true }  (last-known price)
// If no cache and ERP down: { price: null, stale: true }  (fall back to SFCC price)

// Reconciliation Job (hourly):
module.exports = { execute: OMS.reconcile };
```

**Async submit timing comparison:**

| Approach | Customer wait | Risk |
|----------|-------------|------|
| Synchronous OMS call | +2–15s on confirmation page | Site outage if OMS is down |
| Async queue | 0s (< 5ms enqueue) | ~2min delay in OMS (acceptable) |

---

## 5. IntegrationHealthDashboard

```js
// In IntegrationHealth-Summary controller:
var Dashboard = require('*/cartridge/scripts/integrations/IntegrationHealthDashboard');
var summary   = Dashboard.HealthAggregator.getSummary();
response.setContentType('application/json');
response.writer.print(JSON.stringify(summary));

// In IntegrationHealth-Dashboard controller (serve the widget HTML):
var html = Dashboard.getDashboardHTML();
// Replace __SITE_ID__ with actual site ID before rendering
response.writer.print(html.replace('__SITE_ID__', Site.getCurrent().getID()));
```

The live dashboard widget (self-contained HTML, served as a Content Asset) polls every 30 seconds and shows:
- Per-integration health score (0–100) with circuit state
- Async queue depth (pending / failed / dead-letter)
- Overall platform health score
- Auto-alerts when any integration drops below its configured threshold

**Alert thresholds:**

| Integration | Alert below | Action |
|-------------|------------|--------|
| Payment | 80% | PagerDuty P1 — revenue at risk |
| OMS | 70% | Alert ops — orders queuing |
| ERP Pricing | 75% | Alert — stale prices serving |
| Tax | 85% | Alert — tax accuracy risk |
| Fraud | 75% | Info — review orders manually |

---

## Setup Checklist

- [ ] Create SFCC Custom Object definitions: `IntegrationQueueEntry`, `IntegrationAlert` (with fields per file headers)
- [ ] Create Site Preferences: `paymentPrimaryGateway`, `paymentSecondaryGateway`, `omsApiURL`, `omsApiKey`, `omsTimeoutMs`, `erpApiURL`, `erpApiKey`, `erpTimeoutMs`, `stripe_apiURL`, `stripe_secretKey`, `stripe_timeoutMs`
- [ ] Configure SFCC Job: `AsyncIntegrationQueue.processQueue` — every 2 minutes
- [ ] Configure SFCC Job: `OMSIntegrationAdapter.reconcile` — hourly
- [ ] Create SFCC Controller `IntegrationHealth-Summary` and `IntegrationHealth-Dashboard`
- [ ] Add `CircuitBreaker.get()` wrapping to every existing SFCC Service call
- [ ] Replace direct OMS calls with `OMSIntegrationAdapter.submitOrderAsync()`
- [ ] Replace direct ERP price calls with `OMSIntegrationAdapter.getERPPrice()` with fallback to SFCC price model
- [ ] Set up alerting webhook from `IntegrationAlert` Custom Objects to Slack/PagerDuty
- [ ] Test circuit breaker by intentionally failing the service and verifying OPEN state and fallback behaviour
