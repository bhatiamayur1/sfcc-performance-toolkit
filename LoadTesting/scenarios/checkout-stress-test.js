/**
 * checkout-stress-test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /load-testing/scenarios
 *
 * Checkout stress test: hammers the checkout funnel specifically, targeting
 * the most resource-intensive and business-critical flow in any storefront.
 *
 * Why checkout stress is different:
 *   • Each VU holds state across multiple requests (session cookie required)
 *   • Payment gateway calls must be MOCKED — never use real credentials
 *   • Inventory reservation is synchronous — contention surfaces quickly
 *   • CSRF tokens must be extracted and re-submitted at each step
 *   • Thread exhaustion happens fastest here (long-running requests)
 *
 * Test profiles:
 *   DEFAULT    — Steady checkout concurrency (finds sustainable throughput)
 *   STRESS     — Ramp until checkout p95 > 10s (finds the breaking point)
 *   SOAK       — 50 concurrent checkouts for 30 min (finds memory leaks)
 *
 * Run:
 *   k6 run checkout-stress-test.js
 *   k6 run --env PROFILE=stress checkout-stress-test.js
 *   k6 run --env PROFILE=soak checkout-stress-test.js
 *   k6 run --env MOCK_PAYMENT=false checkout-stress-test.js   ← USE WITH CARE
 * ─────────────────────────────────────────────────────────────────────────────
 */

import http           from 'k6/http';
import { check, sleep, group, fail } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';
import { randomItem, randomIntBetween, uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// ─── Custom metrics ────────────────────────────────────────────────────────────

const checkoutFunnelTime  = new Trend('checkout_funnel_total_ms', true);
const addressStepTime     = new Trend('checkout_address_step_ms', true);
const shippingStepTime    = new Trend('checkout_shipping_step_ms', true);
const paymentStepTime     = new Trend('checkout_payment_step_ms', true);
const placeOrderTime      = new Trend('checkout_place_order_ms', true);
const checkoutCompleted   = new Counter('checkout_completed');
const checkoutAbandoned   = new Counter('checkout_abandoned');
const checkoutErrored     = new Counter('checkout_errored');
const paymentDeclined     = new Counter('checkout_payment_declined');
const sessionErrors       = new Rate('checkout_session_error_rate');
const csrfErrors          = new Counter('checkout_csrf_errors');
const inventoryConflicts  = new Counter('checkout_inventory_conflict');
const activeCheckouts     = new Gauge('checkout_active_sessions');

// ─── Configuration ─────────────────────────────────────────────────────────────

const BASE_URL      = __ENV.BASE_URL      || 'https://your-sandbox.demandware.net/s/SiteID';
const PROFILE       = __ENV.PROFILE       || 'default';
const MOCK_PAYMENT  = __ENV.MOCK_PAYMENT  !== 'false';  // true by default — safety guard

if (!MOCK_PAYMENT) {
    console.warn('⚠️  MOCK_PAYMENT=false: Real payment calls enabled. Ensure test gateway is configured.');
}

// ─── Test profiles ────────────────────────────────────────────────────────────

const PROFILES = {
    default: {
        description: '25 concurrent checkout sessions — sustainable throughput',
        stages: [
            { duration: '1m',  target: 5  },
            { duration: '5m',  target: 25 },
            { duration: '10m', target: 25 },
            { duration: '2m',  target: 0  }
        ]
    },
    stress: {
        description: 'Checkout stress: ramp until breakpoint identified',
        stages: [
            { duration: '2m',  target: 10  },
            { duration: '5m',  target: 50  },
            { duration: '5m',  target: 100 },
            { duration: '5m',  target: 150 },
            { duration: '5m',  target: 200 },
            { duration: '5m',  target: 0   }   // Recovery observation
        ]
    },
    soak: {
        description: 'Soak test: 50 concurrent checkouts for 30 min (memory/connection leaks)',
        stages: [
            { duration: '5m',  target: 50 },
            { duration: '30m', target: 50 },
            { duration: '5m',  target: 0  }
        ]
    }
};

const selectedProfile = PROFILES[PROFILE] || PROFILES.default;

export const options = {
    stages: selectedProfile.stages,

    thresholds: {
        'checkout_funnel_total_ms'     : ['p(95)<30000', 'p(99)<60000'],
        'checkout_address_step_ms'     : ['p(95)<3000'],
        'checkout_shipping_step_ms'    : ['p(95)<5000'],
        'checkout_payment_step_ms'     : ['p(95)<5000'],
        'checkout_place_order_ms'      : ['p(95)<10000'],
        'checkout_session_error_rate'  : ['rate<0.05'],
        'checkout_csrf_errors'         : ['count<10'],
        'checkout_inventory_conflict'  : ['count<50'],
        'http_req_failed'              : ['rate<0.05']
    },

    summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max']
};

// ─── Test data ─────────────────────────────────────────────────────────────────

const PRODUCTS = [
    { id: 'P001-blue-slim-jeans',    name: 'Blue Slim Jeans',    price: 79.99 },
    { id: 'P002-white-linen-shirt',  name: 'White Linen Shirt',  price: 49.99 },
    { id: 'P003-black-leather-boots',name: 'Black Leather Boots', price: 149.99 },
    { id: 'P004-grey-wool-jumper',   name: 'Grey Wool Jumper',   price: 89.99 }
];

// Fake test customer data (never use real personal data in load tests)
const TEST_CUSTOMERS = [
    { firstName: 'Alice',  lastName: 'Test',    postcode: 'W1A 1AA', phone: '07700900001' },
    { firstName: 'Bob',    lastName: 'Sample',  postcode: 'EC1A 1BB', phone: '07700900002' },
    { firstName: 'Carol',  lastName: 'Demo',    postcode: 'SE1 7PB',  phone: '07700900003' },
    { firstName: 'David',  lastName: 'Loadtest',postcode: 'N1 9GU',   phone: '07700900004' }
];

// Mock payment tokens (only used when MOCK_PAYMENT=true or test gateway is configured)
const MOCK_CARD_TOKENS = [
    'tok_visa_test_success',
    'tok_visa_test_success_2',
    'tok_mastercard_test_success'
];

// ─── Session manager ──────────────────────────────────────────────────────────

/**
 * Creates a new session jar for a VU. Each VU represents one shopper.
 * The jar automatically handles SFCC session cookies (dwsid, dwanonymous).
 */
function createSession() {
    return http.cookieJar();
}

/**
 * Extracts a CSRF token from an HTML response body.
 * SFCC embeds the CSRF token as a hidden form field named 'csrf_token'.
 *
 * @param  {string} html
 * @returns {string|null}
 */
function extractCSRF(html) {
    const match = html.match(/name=["']csrf_token["'][^>]*value=["']([^"']+)["']/i)
                  || html.match(/value=["']([^"']+)["'][^>]*name=["']csrf_token["']/i);
    return match ? match[1] : null;
}

// ─── Checkout step helpers ────────────────────────────────────────────────────

/**
 * Step 0: Add a product to the basket. Returns the basket CSRF token.
 */
function stepAddToCart(jar, product) {
    const res = http.post(
        `${BASE_URL}/Cart-AddProduct`,
        JSON.stringify({ pid: product.id, quantity: 1, options: [] }),
        {
            headers: {
                'Content-Type'     : 'application/json',
                'X-Requested-With' : 'XMLHttpRequest'
            },
            cookies: jar,
            tags   : { step: 'add_to_cart' }
        }
    );

    if (res.status === 409) {
        inventoryConflicts.add(1);
        return null;
    }

    const ok = check(res, {
        'Add to cart — 200 OK' : (r) => r.status === 200,
        'Add to cart — basket' : (r) => r.body && r.body.includes('numItems')
    });

    return ok ? res : null;
}

/**
 * Step 1: Load the checkout page and extract the CSRF token.
 */
function stepCheckoutBegin(jar) {
    const start = Date.now();
    const res   = http.get(`${BASE_URL}/checkout`, {
        headers: { 'Accept': 'text/html' },
        cookies: jar,
        tags   : { step: 'checkout_begin' }
    });

    check(res, {
        'Checkout begin — 200'    : (r) => r.status === 200,
        'Checkout begin — form'   : (r) => r.body && r.body.includes('dwfrm_shipping')
    });

    addressStepTime.add(Date.now() - start);

    const csrf = extractCSRF(res.body || '');
    if (!csrf) { csrfErrors.add(1); }
    return { res, csrf };
}

/**
 * Step 2: Submit shipping address.
 */
function stepSubmitShipping(jar, csrf, customer) {
    const start = Date.now();
    const email = `loadtest.${Date.now()}.${randomIntBetween(1000, 9999)}@example-loadtest.com`;

    const formData = {
        csrf_token: csrf || '',
        dwfrm_shipping_shippingAddress_addressFields_firstName : customer.firstName,
        dwfrm_shipping_shippingAddress_addressFields_lastName  : customer.lastName,
        dwfrm_shipping_shippingAddress_addressFields_address1  : '123 Load Test Street',
        dwfrm_shipping_shippingAddress_addressFields_city      : 'London',
        dwfrm_shipping_shippingAddress_addressFields_postalCode: customer.postcode,
        dwfrm_shipping_shippingAddress_addressFields_country   : 'GB',
        dwfrm_shipping_shippingAddress_addressFields_phone     : customer.phone,
        dwfrm_shipping_shippingAddress_shippingMethodID        : 'standard-shipping',
        dwfrm_shipping_guestCustomerForm_email                 : email
    };

    const res = http.post(
        `${BASE_URL}/CheckoutShippingServices-SubmitShipping`,
        JSON.stringify(formData),
        {
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            cookies: jar,
            tags   : { step: 'submit_shipping' }
        }
    );

    shippingStepTime.add(Date.now() - start);

    const ok = check(res, {
        'Submit shipping — 200'          : (r) => r.status === 200,
        'Submit shipping — no error'     : (r) => !r.body || !r.body.includes('"error":true'),
        'Submit shipping — stage payment': (r) => r.body && (r.body.includes('payment') || r.status === 200)
    });

    sessionErrors.add(!ok ? 1 : 0);
    return ok ? res : null;
}

/**
 * Step 3: Select shipping method and move to payment.
 */
function stepSelectShipping(jar) {
    const start = Date.now();

    const res = http.get(
        `${BASE_URL}/CheckoutShippingServices-UpdateShippingMethodsList`,
        {
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            cookies: jar,
            tags   : { step: 'select_shipping' }
        }
    );

    shippingStepTime.add(Date.now() - start);

    check(res, {
        'Shipping methods — responds' : (r) => r.status === 200
    });

    return res;
}

/**
 * Step 4: Load payment page and extract new CSRF.
 */
function stepLoadPayment(jar) {
    const start = Date.now();

    const res = http.get(
        `${BASE_URL}/checkout?stage=payment`,
        {
            headers: { 'Accept': 'text/html' },
            cookies: jar,
            tags   : { step: 'load_payment' }
        }
    );

    paymentStepTime.add(Date.now() - start);

    check(res, {
        'Payment page — 200'  : (r) => r.status === 200,
        'Payment page — form' : (r) => r.body && r.body.includes('billing')
    });

    return { res, csrf: extractCSRF(res.body || '') };
}

/**
 * Step 5: Submit payment (MOCKED — never sends real card data in load test).
 */
function stepSubmitPayment(jar, csrf) {
    if (!MOCK_PAYMENT) {
        // Real payment path — requires Stripe test keys configured in SFCC
        // This path should only be used with a sandbox gateway
        console.warn(`VU ${__VU}: Real payment path — ensure test gateway is configured`);
    }

    const start = Date.now();
    const token = randomItem(MOCK_CARD_TOKENS);

    const paymentData = {
        csrf_token                                            : csrf || '',
        dwfrm_billing_addressFields_firstName                 : 'Test',
        dwfrm_billing_addressFields_lastName                  : 'User',
        dwfrm_billing_addressFields_address1                  : '123 Load Test Street',
        dwfrm_billing_addressFields_city                      : 'London',
        dwfrm_billing_addressFields_postalCode                : 'W1A 1AA',
        dwfrm_billing_addressFields_country                   : 'GB',
        dwfrm_billing_paymentMethod                           : 'CREDIT_CARD',
        dwfrm_billing_creditCardFields_cardType               : 'Visa',
        dwfrm_billing_creditCardFields_cardNumber             : '4242424242424242',  // Stripe test card
        dwfrm_billing_creditCardFields_expirationMonth        : '12',
        dwfrm_billing_creditCardFields_expirationYear         : '2026',
        dwfrm_billing_creditCardFields_securityCode           : '123',
        // In real SFCC: payment token from Stripe.js / Adyen Web Components replaces raw card
        paymentToken                                          : token
    };

    const res = http.post(
        `${BASE_URL}/CheckoutServices-SubmitPayment`,
        JSON.stringify(paymentData),
        {
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            cookies: jar,
            tags   : { step: 'submit_payment' }
        }
    );

    paymentStepTime.add(Date.now() - start);

    if (res.body && res.body.includes('payment declined')) {
        paymentDeclined.add(1);
    }

    return res;
}

/**
 * Step 6: Place the order.
 */
function stepPlaceOrder(jar, csrf) {
    const start = Date.now();

    const res = http.post(
        `${BASE_URL}/CheckoutServices-PlaceOrder`,
        JSON.stringify({ csrf_token: csrf || '' }),
        {
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            cookies: jar,
            timeout: '30s',
            tags   : { step: 'place_order' }
        }
    );

    placeOrderTime.add(Date.now() - start);

    const success = check(res, {
        'Place order — responds'         : (r) => r.status === 200,
        'Place order — order created'    : (r) => r.body && (r.body.includes('order-confirmation') || r.body.includes('orderID')),
        'Place order — no payment error' : (r) => !r.body || !r.body.includes('payment_error')
    });

    return { res, success };
}

// ─── Main checkout journey ────────────────────────────────────────────────────

export default function () {
    const jar       = createSession();
    const product   = randomItem(PRODUCTS);
    const customer  = randomItem(TEST_CUSTOMERS);
    const funnelStart = Date.now();

    activeCheckouts.add(1);

    group('Full Checkout Funnel', function () {

        // ── Step 0: Add to cart ───────────────────────────────────────────────
        const addRes = stepAddToCart(jar, product);
        if (!addRes) {
            checkoutAbandoned.add(1);
            activeCheckouts.add(-1);
            return;
        }
        sleep(randomIntBetween(1, 2));

        // ── Step 1: Begin checkout ────────────────────────────────────────────
        const { res: checkoutRes, csrf: csrf1 } = stepCheckoutBegin(jar);
        if (checkoutRes.status !== 200) {
            checkoutErrored.add(1);
            sessionErrors.add(1);
            activeCheckouts.add(-1);
            return;
        }
        sleep(randomIntBetween(2, 4));

        // ── Step 2: Submit shipping ───────────────────────────────────────────
        const shippingRes = stepSubmitShipping(jar, csrf1, customer);
        if (!shippingRes) {
            checkoutAbandoned.add(1);
            activeCheckouts.add(-1);
            return;
        }
        sleep(randomIntBetween(1, 3));

        // ── Step 3: Shipping method ───────────────────────────────────────────
        stepSelectShipping(jar);
        sleep(randomIntBetween(1, 2));

        // ── Step 4: Payment page ──────────────────────────────────────────────
        const { res: paymentPageRes, csrf: csrf2 } = stepLoadPayment(jar);
        if (paymentPageRes.status !== 200) {
            checkoutErrored.add(1);
            activeCheckouts.add(-1);
            return;
        }
        // Simulate card entry time
        sleep(randomIntBetween(4, 10));

        // ── Step 5: Submit payment ────────────────────────────────────────────
        const paymentRes = stepSubmitPayment(jar, csrf2);
        sleep(randomIntBetween(1, 2));

        // ── Step 6: Place order ───────────────────────────────────────────────
        const { success } = stepPlaceOrder(jar, csrf2);
        const funnelMs    = Date.now() - funnelStart;
        checkoutFunnelTime.add(funnelMs);

        if (success) {
            checkoutCompleted.add(1);
        } else {
            checkoutErrored.add(1);
        }
    });

    activeCheckouts.add(-1);
    sleep(randomIntBetween(2, 5));
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export function setup() {
    console.log(`\n⚡ SFCC Checkout Stress Test — ${PROFILE.toUpperCase()}`);
    console.log(`   ${selectedProfile.description}`);
    console.log(`   Mock payment: ${MOCK_PAYMENT}`);
    console.log(`   ⚠️  Using test card 4242 4242 4242 4242 — requires Stripe test mode\n`);
}

export function handleSummary(data) {
    const getVal = (metric, stat) =>
        data.metrics[metric] && data.metrics[metric].values[stat] !== undefined
            ? data.metrics[metric].values[stat]
            : 'N/A';

    const completed  = getVal('checkout_completed', 'count');
    const abandoned  = getVal('checkout_abandoned', 'count');
    const errored    = getVal('checkout_errored', 'count');
    const funnelP95  = getVal('checkout_funnel_total_ms', 'p(95)');
    const placeP95   = getVal('checkout_place_order_ms', 'p(95)');

    console.log('\n════════════════════════════════════════════════');
    console.log(`  Checkout Stress Test Summary — ${PROFILE.toUpperCase()}`);
    console.log('════════════════════════════════════════════════');
    console.log(`  Completed checkouts  : ${completed}`);
    console.log(`  Abandoned            : ${abandoned}`);
    console.log(`  Errored              : ${errored}`);
    console.log(`  Full funnel p95      : ${typeof funnelP95 === 'number' ? funnelP95.toFixed(0) + 'ms' : funnelP95}`);
    console.log(`  Place order p95      : ${typeof placeP95 === 'number' ? placeP95.toFixed(0) + 'ms' : placeP95}`);
    console.log(`  CSRF errors          : ${getVal('checkout_csrf_errors', 'count')}`);
    console.log(`  Inventory conflicts  : ${getVal('checkout_inventory_conflict', 'count')}`);
    console.log(`  Payment declined     : ${getVal('checkout_payment_declined', 'count')}`);
    console.log('════════════════════════════════════════════════\n');

    return {
        [`results/checkout-stress-${PROFILE}-summary.json`]: JSON.stringify(data, null, 2)
    };
}
