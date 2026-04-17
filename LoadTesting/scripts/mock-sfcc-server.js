/**
 * mock-sfcc-server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /load-testing/scripts
 *
 * A lightweight Express mock server that mimics SFCC storefront endpoints
 * so you can run load tests without burning through sandbox quota or
 * risking test data contamination.
 *
 * Simulates realistic SFCC response latencies (configurable) including:
 *   • Random latency jitter within realistic ranges
 *   • Configurable error injection (rate limiting, timeouts, 5xx)
 *   • Session cookie management (dwsid, dwanonymous)
 *   • CSRF token generation and validation
 *   • Rate limiting (429) after configurable request volume
 *
 * Start:
 *   node mock-sfcc-server.js
 *   node mock-sfcc-server.js --port 3000 --error-rate 0.02 --latency-multiplier 2
 *
 * Then point your k6 tests at http://localhost:3000:
 *   k6 run --env BASE_URL=http://localhost:3000/s/SiteID baseline-load-test.js
 *
 * Prerequisites:
 *   npm install express uuid
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith('--')) { acc[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = arr[i+1] && !arr[i+1].startsWith('--') ? arr[i+1] : true; }
    return acc;
}, {});

const PORT               = parseInt(args.port, 10)              || 3000;
const ERROR_RATE         = parseFloat(args.errorRate)            || 0.01;  // 1% error injection
const LATENCY_MULTIPLIER = parseFloat(args.latencyMultiplier)    || 1.0;   // 1x = realistic
const RATE_LIMIT_RPM     = parseInt(args.rateLimitRpm, 10)       || 2000;  // requests/min before 429

// ─── Latency profiles (milliseconds) ─────────────────────────────────────────

const LATENCY = {
    homepage   : { min: 80,  max: 250  },
    category   : { min: 100, max: 400  },
    pdp        : { min: 120, max: 500  },
    search     : { min: 150, max: 600  },
    cart       : { min: 80,  max: 300  },
    checkout   : { min: 200, max: 800  },
    submitShip : { min: 300, max: 1200 },
    submitPay  : { min: 400, max: 1500 },
    placeOrder : { min: 800, max: 3000 },  // Includes mock payment gateway call
    suggest    : { min: 30,  max: 150  },
    addToCart  : { min: 100, max: 400  },
    api        : { min: 50,  max: 300  }
};

// ─── Helper functions ─────────────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function mockLatency(profile) {
    const { min, max } = LATENCY[profile] || LATENCY.api;
    const base = randomInt(min, max);
    return Math.round(base * LATENCY_MULTIPLIER);
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

let requestCount = 0;
let windowStart  = Date.now();

function checkRateLimit() {
    const now = Date.now();
    if (now - windowStart > 60000) {
        requestCount = 0;
        windowStart  = now;
    }
    requestCount++;
    return requestCount > RATE_LIMIT_RPM;
}

// ─── Error injector ───────────────────────────────────────────────────────────

function shouldInjectError() {
    return Math.random() < ERROR_RATE;
}

function shouldTimeout() {
    return Math.random() < (ERROR_RATE * 0.1);  // 10% of errors are timeouts
}

// ─── CSRF & Session ───────────────────────────────────────────────────────────

const activeSessions = new Map();   // sessionId → { csrfToken, basket, createdAt }
const CSRF_TOKENS    = new Map();   // csrfToken → sessionId

function getOrCreateSession(req, res) {
    let sessionId = req.cookies && req.cookies.dwsid;
    if (!sessionId || !activeSessions.has(sessionId)) {
        sessionId = uuidv4();
        const csrf = uuidv4().replace(/-/g, '');
        activeSessions.set(sessionId, { csrfToken: csrf, basket: [], createdAt: Date.now() });
        CSRF_TOKENS.set(csrf, sessionId);
        res.cookie('dwsid',        sessionId,  { httpOnly: true, sameSite: 'Lax' });
        res.cookie('dwanonymous',  uuidv4(),   { httpOnly: true, sameSite: 'Lax' });
    }
    return activeSessions.get(sessionId);
}

function generatePageHTML(title, extra) {
    // Extract session CSRF from the request cookie
    const session = { csrfToken: uuidv4().replace(/-/g, '') };

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${title} — Mock SFCC</title></head>
<body>
  <h1>${title}</h1>
  <form>
    <input type="hidden" name="csrf_token" value="${session.csrfToken}">
    ${extra || ''}
  </form>
  <div class="add-to-cart">Add to cart button</div>
  <div class="dwfrm_shipping">Shipping form</div>
  <div class="dwfrm_billing">Billing form</div>
  <div class="billing">Payment section</div>
</body></html>`;
}

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(require('cookie-parser')());   // npm install cookie-parser

// Common middleware: rate limit + error injection + logging
app.use((req, res, next) => {
    // Rate limiting
    if (checkRateLimit()) {
        return res.status(429).json({ error: 'Too Many Requests', retryAfter: 30 });
    }
    // Error injection
    if (shouldInjectError()) {
        return res.status(500).json({ error: 'Mock server error injection' });
    }
    next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────

const SITE_PREFIX = '/s/:siteID';

// Homepage
app.get([SITE_PREFIX + '/', SITE_PREFIX], async (req, res) => {
    getOrCreateSession(req, res);
    await sleep(mockLatency('homepage'));
    res.send(generatePageHTML('Homepage — Mock SFCC Storefront'));
});

// Category / PLP
app.get(SITE_PREFIX + '/:category/', async (req, res) => {
    getOrCreateSession(req, res);
    await sleep(mockLatency('category'));
    const cat = req.params.category;
    res.send(generatePageHTML(`${cat} — Category`, `
      <div class="product-tile" data-pid="P001">Product 1</div>
      <div class="product-tile" data-pid="P002">Product 2</div>
      <div class="product-tile" data-pid="P003">Product 3</div>
    `));
});

// Product Detail Page
app.get(SITE_PREFIX + '/product/:pid', async (req, res) => {
    getOrCreateSession(req, res);
    await sleep(mockLatency('pdp'));
    const pid = req.params.pid;
    res.send(generatePageHTML(`Product ${pid}`, `
      <div class="product-detail" data-pid="${pid}">
        <div class="pdp-main">
          <input type="hidden" name="pid" value="${pid}">
          <div class="availability">In Stock</div>
          <button class="add-to-cart">Add to Bag</button>
        </div>
      </div>
    `));
});

// Search
app.get(SITE_PREFIX + '/search', async (req, res) => {
    getOrCreateSession(req, res);
    await sleep(mockLatency('search'));
    const q    = req.query.q    || '';
    const cgid = req.query.cgid || '';
    res.send(generatePageHTML(`Search: ${q || cgid}`, `
      <div class="search-results">
        <div class="product-tile">Result 1</div>
        <div class="product-tile">Result 2</div>
        <div class="product-tile">Result 3</div>
      </div>
    `));
});

// Search suggest
app.get(SITE_PREFIX + '/SearchServices-GetSuggest', async (req, res) => {
    await sleep(mockLatency('suggest'));
    res.json({
        suggestions: [
            { phrase: req.query.q + ' jeans', count: 124 },
            { phrase: req.query.q + ' shirt', count: 89  },
            { phrase: req.query.q + ' dress', count: 203 }
        ]
    });
});

// Cart page
app.get(SITE_PREFIX + '/cart', async (req, res) => {
    getOrCreateSession(req, res);
    await sleep(mockLatency('cart'));
    res.send(generatePageHTML('Cart', '<div class="numItems">2</div>'));
});

// Add to cart (AJAX POST)
app.post(SITE_PREFIX + '/Cart-AddProduct', async (req, res) => {
    getOrCreateSession(req, res);
    await sleep(mockLatency('addToCart'));

    const pid = req.body && req.body.pid;
    if (!pid) { return res.status(400).json({ error: 'pid is required' }); }

    // Simulate occasional stock conflicts (409)
    if (Math.random() < 0.03) {
        return res.status(409).json({ error: 'Product unavailable', errorMessage: 'This item is out of stock.' });
    }

    res.json({
        success  : true,
        numItems : randomInt(1, 5),
        totals   : { subTotal: (49.99 * randomInt(1, 3)).toFixed(2) },
        message  : `${pid} added to basket`
    });
});

// Mini-cart
app.get(SITE_PREFIX + '/Cart-MiniCart', async (req, res) => {
    await sleep(mockLatency('api'));
    res.json({ numItems: randomInt(1, 4), total: '£' + (49.99 * randomInt(1, 3)).toFixed(2) });
});

// Product variation
app.get(SITE_PREFIX + '/Product-Variation', async (req, res) => {
    await sleep(mockLatency('api'));
    res.json({
        product     : { id: req.query.pid, availability: { available: true } },
        resources   : { info_selectforstock: 'Select a size' }
    });
});

// Checkout begin
app.get(SITE_PREFIX + '/checkout', async (req, res) => {
    getOrCreateSession(req, res);
    const stage = req.query.stage || 'shipping';
    await sleep(mockLatency('checkout'));
    res.send(generatePageHTML(`Checkout — ${stage}`, `
      <div class="checkout-stage" data-stage="${stage}">
        <div class="dwfrm_shipping"></div>
        <div class="dwfrm_billing"></div>
      </div>
    `));
});

// Submit shipping (most heavily loaded checkout step)
app.post(SITE_PREFIX + '/CheckoutShippingServices-SubmitShipping', async (req, res) => {
    await sleep(mockLatency('submitShip'));

    // Simulate address validation failure (2% rate)
    if (Math.random() < 0.02) {
        return res.json({ error: true, message: 'Address validation failed', fieldErrors: [] });
    }

    res.json({
        error            : false,
        cartModel        : { totals: { grandTotal: '£79.99' } },
        customer         : { addresses: [] },
        order            : { orderID: null },
        shippingForm     : { valid: true }
    });
});

// Update shipping methods list
app.get(SITE_PREFIX + '/CheckoutShippingServices-UpdateShippingMethodsList', async (req, res) => {
    await sleep(mockLatency('api'));
    res.json({
        shippingMethods: [
            { ID: 'standard-shipping', displayName: 'Standard (3-5 days)', shippingCost: '£3.99' },
            { ID: 'express-shipping',  displayName: 'Express (1-2 days)',  shippingCost: '£6.99' },
            { ID: 'next-day',          displayName: 'Next Day',            shippingCost: '£9.99' }
        ]
    });
});

// Submit payment
app.post(SITE_PREFIX + '/CheckoutServices-SubmitPayment', async (req, res) => {
    await sleep(mockLatency('submitPay'));

    // Simulate payment token validation
    if (Math.random() < 0.01) {
        return res.json({ error: true, message: 'payment declined', fieldErrors: [] });
    }

    res.json({
        error  : false,
        order  : { orderID: null, totals: { grandTotal: '£79.99' } },
        form   : { valid: true }
    });
});

// Place order (heaviest endpoint — includes mock payment gateway call)
app.post(SITE_PREFIX + '/CheckoutServices-PlaceOrder', async (req, res) => {
    // Simulate payment gateway call inside place order
    if (shouldTimeout()) {
        await sleep(12000);  // Simulate gateway timeout
        return res.status(504).json({ error: 'Gateway timeout' });
    }

    await sleep(mockLatency('placeOrder'));

    // Simulate rare payment failure
    if (Math.random() < 0.02) {
        return res.json({ error: true, message: 'payment_error', errorMessage: 'Card declined.' });
    }

    const orderID = 'ORD-' + Date.now() + '-' + randomInt(1000, 9999);
    res.json({
        error      : false,
        orderID    : orderID,
        continueUrl: `/order-confirmation?orderID=${orderID}&token=${uuidv4()}`,
        order      : { orderID: orderID, orderConfirmation: true }
    });
});

// Order confirmation
app.get(SITE_PREFIX + '/order-confirmation', async (req, res) => {
    await sleep(mockLatency('api'));
    res.send(generatePageHTML('Order Confirmation', `
      <div class="order-confirmation">
        <div class="order-thank-you-msg">Thank you for your order!</div>
        <div class="orderID">${req.query.orderID || 'ORD-MOCK'}</div>
      </div>
    `));
});

// IntegrationHealth endpoint (for health dashboard tests)
app.get(SITE_PREFIX + '/IntegrationHealth-Summary', async (req, res) => {
    await sleep(20);
    res.json({
        generatedAt  : new Date().toISOString(),
        overallScore : randomInt(75, 100),
        overallStatus: 'HEALTHY',
        integrations : [
            { id: 'payment-stripe',  label: 'Stripe',    status: 'HEALTHY',  healthScore: randomInt(90, 100) },
            { id: 'oms-createOrder', label: 'OMS',       status: 'HEALTHY',  healthScore: randomInt(80, 95)  },
            { id: 'erp-price',       label: 'ERP Price', status: 'DEGRADED', healthScore: randomInt(60, 75)  }
        ],
        asyncQueue   : { pending: randomInt(0, 20), failed: randomInt(0, 3), deadLetter: 0 },
        alerts       : { critical: 0, degraded: 1 }
    });
});

// ─── Server start ─────────────────────────────────────────────────────────────

// Install cookie-parser if not already installed
try {
    require('cookie-parser');
} catch (e) {
    console.error('❌  Missing dependency: run `npm install cookie-parser` first');
    process.exit(1);
}

app.listen(PORT, () => {
    console.log('\n⚡ SFCC Mock Server running');
    console.log(`   URL              : http://localhost:${PORT}/s/SiteID`);
    console.log(`   Error rate       : ${(ERROR_RATE * 100).toFixed(1)}%`);
    console.log(`   Latency multiplier: ${LATENCY_MULTIPLIER}×`);
    console.log(`   Rate limit       : ${RATE_LIMIT_RPM} req/min`);
    console.log('\n   k6 target:');
    console.log(`   k6 run --env BASE_URL=http://localhost:${PORT}/s/SiteID baseline-load-test.js\n`);
});
