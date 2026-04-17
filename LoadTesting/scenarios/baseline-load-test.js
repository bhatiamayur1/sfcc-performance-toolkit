/**
 * baseline-load-test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /load-testing/scenarios
 *
 * k6 baseline load test: simulates realistic mixed storefront traffic
 * to establish performance baselines before any optimization work.
 *
 * Traffic mix (matches typical SFCC storefront analytics):
 *   55% — Homepage + Category browsing (top of funnel)
 *   25% — Product Detail Page views
 *   12% — Search queries
 *    5% — Add to cart interactions
 *    3% — Checkout funnel
 *
 * Run:
 *   k6 run baseline-load-test.js
 *   k6 run --env BASE_URL=https://your-sandbox.demandware.net baseline-load-test.js
 *
 * With output:
 *   k6 run --out json=results/baseline.json baseline-load-test.js
 *   k6 run --out influxdb=http://localhost:8086/k6 baseline-load-test.js
 *
 * Prerequisites:
 *   brew install k6   (macOS)
 *   choco install k6  (Windows)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import http          from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { randomItem, randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// ─── Custom metrics ────────────────────────────────────────────────────────────

const pageLoadTime    = new Trend('sfcc_page_load_ms',    true);
const apiLatency      = new Trend('sfcc_api_latency_ms',  true);
const cacheHitRate    = new Rate('sfcc_cache_hit_rate');
const errorRate       = new Rate('sfcc_error_rate');
const checkoutSuccess = new Counter('sfcc_checkout_success');
const checkoutFail    = new Counter('sfcc_checkout_fail');

// ─── Configuration ─────────────────────────────────────────────────────────────

const BASE_URL  = __ENV.BASE_URL  || 'https://your-sandbox.demandware.net/s/SiteID';
const SITE_ID   = __ENV.SITE_ID   || 'SiteID';
const LOCALE    = __ENV.LOCALE    || 'en_GB';
const CURRENCY  = __ENV.CURRENCY  || 'GBP';

// Realistic think times between page loads (seconds)
const THINK_TIME_MIN = 2;
const THINK_TIME_MAX = 8;

// ─── Test data ────────────────────────────────────────────────────────────────

const CATEGORY_IDS = [
    'womens-clothing',
    'mens-clothing',
    'womens-shoes',
    'mens-shoes',
    'accessories',
    'sale'
];

const PRODUCT_IDS = [
    'P001-blue-slim-jeans',
    'P002-white-linen-shirt',
    'P003-black-leather-boots',
    'P004-floral-summer-dress',
    'P005-grey-wool-jumper',
    'P006-navy-chino-trousers',
    'P007-cream-knit-cardigan',
    'P008-burgundy-ankle-boots'
];

const SEARCH_TERMS = [
    't shirt', 'jeans', 'dress', 'boots', 'jacket',
    'trainers', 'sale', 'knitwear', 'summer dress', 'boots women'
];

const SORT_RULES = ['best-matches', 'price-low-to-high', 'new-arrivals', 'top-sellers'];

// ─── Load stages (ramp-up → sustained → ramp-down) ────────────────────────────

export const options = {
    stages: [
        { duration: '2m',  target: 10  },   // Warm-up: ramp to 10 VUs
        { duration: '5m',  target: 50  },   // Ramp to baseline load
        { duration: '10m', target: 50  },   // Hold at baseline (50 concurrent)
        { duration: '2m',  target: 100 },   // Light spike
        { duration: '5m',  target: 100 },   // Hold spike
        { duration: '3m',  target: 0   }    // Cool down
    ],

    thresholds: {
        // SLA definitions — test FAILS if these are breached
        'http_req_duration':                 ['p(95)<2000'],   // 95th percentile < 2s
        'http_req_duration{type:page}':      ['p(95)<1500'],   // Page loads < 1.5s p95
        'http_req_duration{type:api}':       ['p(95)<800'],    // API calls < 800ms p95
        'http_req_failed':                   ['rate<0.01'],    // Error rate < 1%
        'sfcc_page_load_ms':                 ['p(90)<1200', 'p(99)<3000'],
        'sfcc_api_latency_ms':               ['p(90)<500'],
        'sfcc_error_rate':                   ['rate<0.02'],
    },

    // k6 output configuration
    summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ─── Common headers ────────────────────────────────────────────────────────────

const HEADERS = {
    'Accept'          : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Encoding' : 'gzip, deflate, br',
    'Accept-Language' : 'en-GB,en;q=0.9',
    'Cache-Control'   : 'no-cache',   // Bypass CDN to hit origin — remove to test CDN
    'User-Agent'      : 'k6-LoadTest/1.0 SFCC-PerformanceToolkit'
};

const API_HEADERS = {
    'Content-Type'     : 'application/json',
    'Accept'           : 'application/json',
    'X-Requested-With' : 'XMLHttpRequest'
};

// ─── Helper functions ─────────────────────────────────────────────────────────

/**
 * Makes a page request and records timing + cache signals.
 */
function loadPage(url, checkName, tags) {
    const res = http.get(url, {
        headers: HEADERS,
        tags   : Object.assign({ type: 'page' }, tags || {})
    });

    const duration = res.timings.duration;
    pageLoadTime.add(duration);

    // Detect CDN cache hit from response headers
    const cacheStatus = res.headers['X-Cache'] || res.headers['CF-Cache-Status'] || '';
    cacheHitRate.add(cacheStatus.toLowerCase().indexOf('hit') !== -1);

    const ok = check(res, {
        [checkName + ' — status 200']      : (r) => r.status === 200,
        [checkName + ' — body not empty']  : (r) => r.body && r.body.length > 100,
        [checkName + ' — response < 3s']   : (r) => r.timings.duration < 3000
    });

    if (!ok || res.status >= 400) {
        errorRate.add(1);
    } else {
        errorRate.add(0);
    }

    return res;
}

/**
 * Makes an AJAX/API request and records latency.
 */
function callAPI(url, method, body, checkName) {
    const res = method === 'POST'
        ? http.post(url, JSON.stringify(body), { headers: API_HEADERS, tags: { type: 'api' } })
        : http.get(url, { headers: API_HEADERS, tags: { type: 'api' } });

    apiLatency.add(res.timings.duration);

    check(res, {
        [checkName + ' — status 200'] : (r) => r.status === 200,
        [checkName + ' — valid JSON'] : (r) => {
            try { JSON.parse(r.body); return true; } catch (e) { return false; }
        }
    });

    return res;
}

// ─── User journey scenarios ───────────────────────────────────────────────────

/**
 * Journey 1: Browser (55% of traffic)
 * Simulates anonymous category browsing with refinements and sorting.
 */
function browseJourney() {
    group('Browse — Category + PLP', function () {
        // Homepage
        loadPage(`${BASE_URL}/`, 'Homepage', { journey: 'browse' });
        sleep(randomIntBetween(THINK_TIME_MIN, THINK_TIME_MAX));

        // Category page
        const catID = randomItem(CATEGORY_IDS);
        loadPage(`${BASE_URL}/${catID}/`, `Category: ${catID}`, { journey: 'browse' });
        sleep(randomIntBetween(2, 5));

        // Apply a refinement (simulate facet click)
        const sortRule = randomItem(SORT_RULES);
        loadPage(
            `${BASE_URL}/search?cgid=${catID}&srule=${sortRule}&prefn1=color&prefv1=Black`,
            'PLP with refinements',
            { journey: 'browse' }
        );
        sleep(randomIntBetween(3, 7));

        // Scroll to page 2
        loadPage(
            `${BASE_URL}/search?cgid=${catID}&start=24&sz=24`,
            'PLP page 2',
            { journey: 'browse' }
        );
        sleep(randomIntBetween(2, 4));
    });
}

/**
 * Journey 2: Product Viewer (25% of traffic)
 * Simulates PDP visits from search/category + product images.
 */
function pdpJourney() {
    group('Product Detail Page', function () {
        const pid = randomItem(PRODUCT_IDS);

        // PDP load
        loadPage(
            `${BASE_URL}/product/${pid}`,
            `PDP: ${pid}`,
            { journey: 'pdp' }
        );
        sleep(randomIntBetween(3, 8));

        // Variant selection (AJAX)
        callAPI(
            `${BASE_URL}/Product-Variation?pid=${pid}&dwvar_${pid}_color=blue&dwvar_${pid}_size=M&quantity=1`,
            'GET',
            null,
            'Variant selection'
        );
        sleep(randomIntBetween(1, 3));

        // Image carousel — simulate multiple DIS image loads
        for (let i = 0; i < 3; i++) {
            http.get(
                `https://your-dis-domain.scene7.com/is/image/${SITE_ID}/${pid}_${i}?sw=800&fmt=webp&q=80`,
                { tags: { type: 'image', journey: 'pdp' } }
            );
        }
        sleep(randomIntBetween(2, 5));
    });
}

/**
 * Journey 3: Searcher (12% of traffic)
 * Simulates search with type-ahead and result loading.
 */
function searchJourney() {
    group('Search', function () {
        const term = randomItem(SEARCH_TERMS);

        // Type-ahead suggest (fired mid-typing, 300ms debounce)
        callAPI(
            `${BASE_URL}/SearchServices-GetSuggest?q=${encodeURIComponent(term.slice(0, 3))}`,
            'GET',
            null,
            'Search suggest'
        );
        sleep(0.3);

        // Full search results
        loadPage(
            `${BASE_URL}/search?q=${encodeURIComponent(term)}&lang=${LOCALE}`,
            `Search: "${term}"`,
            { journey: 'search' }
        );
        sleep(randomIntBetween(2, 6));

        // Refine search by sort
        const sortRule = randomItem(SORT_RULES);
        loadPage(
            `${BASE_URL}/search?q=${encodeURIComponent(term)}&srule=${sortRule}`,
            `Search refined`,
            { journey: 'search' }
        );
        sleep(randomIntBetween(2, 4));
    });
}

/**
 * Journey 4: Cart Adder (5% of traffic)
 * Simulates add-to-cart and mini-cart interactions.
 */
function cartJourney() {
    group('Add to Cart', function () {
        const pid = randomItem(PRODUCT_IDS);

        // Load PDP first
        loadPage(`${BASE_URL}/product/${pid}`, 'PDP before add', { journey: 'cart' });
        sleep(randomIntBetween(3, 6));

        // Add to cart (POST)
        const addRes = callAPI(
            `${BASE_URL}/Cart-AddProduct`,
            'POST',
            { pid: pid, quantity: 1, options: [] },
            'Add to cart'
        );
        sleep(randomIntBetween(1, 2));

        // Mini-cart refresh
        callAPI(`${BASE_URL}/Cart-MiniCart`, 'GET', null, 'Mini-cart');
        sleep(randomIntBetween(2, 4));

        // Cart page
        loadPage(`${BASE_URL}/cart`, 'Cart page', { journey: 'cart' });
        sleep(randomIntBetween(2, 5));
    });
}

/**
 * Journey 5: Checkout (3% of traffic)
 * Simulates full guest checkout funnel — the most server-intensive flow.
 */
function checkoutJourney() {
    group('Checkout Funnel', function () {
        // Add a product first
        const pid = randomItem(PRODUCT_IDS);
        const addRes = callAPI(
            `${BASE_URL}/Cart-AddProduct`,
            'POST',
            { pid: pid, quantity: 1, options: [] },
            'Add to cart (checkout setup)'
        );

        if (!addRes || addRes.status !== 200) {
            checkoutFail.add(1);
            return;
        }
        sleep(1);

        // Checkout begin
        const checkoutRes = loadPage(`${BASE_URL}/checkout`, 'Checkout begin', { journey: 'checkout' });
        if (checkoutRes.status !== 200) { checkoutFail.add(1); return; }
        sleep(randomIntBetween(3, 6));

        // Submit customer email
        const emailRes = callAPI(
            `${BASE_URL}/CheckoutShippingServices-SubmitShipping`,
            'POST',
            {
                dwfrm_shipping_shippingAddress_addressFields_firstName: 'Test',
                dwfrm_shipping_shippingAddress_addressFields_lastName : 'User',
                dwfrm_shipping_shippingAddress_addressFields_address1 : '123 Test Street',
                dwfrm_shipping_shippingAddress_addressFields_city     : 'London',
                dwfrm_shipping_shippingAddress_addressFields_postalCode: 'W1A 1AA',
                dwfrm_shipping_shippingAddress_addressFields_country  : 'GB',
                dwfrm_shipping_shippingAddress_addressFields_phone    : '07700900000',
                dwfrm_shipping_shippingAddress_shippingMethodID       : 'standard-shipping',
                dwfrm_shipping_guestCustomerForm_email                : `test.${Date.now()}@loadtest.example.com`
            },
            'Submit shipping'
        );
        sleep(randomIntBetween(2, 4));

        // Shipping method selection
        callAPI(`${BASE_URL}/CheckoutShippingServices-UpdateShippingMethodsList`, 'GET', null, 'Shipping methods');
        sleep(randomIntBetween(1, 3));

        // Payment step (does NOT submit actual payment in load test)
        loadPage(`${BASE_URL}/checkout?stage=payment`, 'Payment step', { journey: 'checkout' });
        sleep(randomIntBetween(2, 5));

        // Simulate payment form fill delay (no actual charge in load test)
        sleep(randomIntBetween(3, 8));

        // Increment metric based on whether we reached payment step
        if (emailRes.status === 200) {
            checkoutSuccess.add(1);
        } else {
            checkoutFail.add(1);
        }
    });
}

// ─── Main VU function ─────────────────────────────────────────────────────────

export default function () {
    // Route each VU to a journey based on traffic mix percentages
    const roll = Math.random() * 100;

    if (roll < 55) {
        browseJourney();
    } else if (roll < 80) {
        pdpJourney();
    } else if (roll < 92) {
        searchJourney();
    } else if (roll < 97) {
        cartJourney();
    } else {
        checkoutJourney();
    }

    // Inter-session think time
    sleep(randomIntBetween(1, 3));
}

// ─── Lifecycle hooks ──────────────────────────────────────────────────────────

export function setup() {
    console.log(`\n⚡ SFCC Baseline Load Test`);
    console.log(`   Base URL : ${BASE_URL}`);
    console.log(`   Site ID  : ${SITE_ID}`);
    console.log(`   Locale   : ${LOCALE}`);
    console.log(`\n   Traffic mix:`);
    console.log(`   55% browse  25% PDP  12% search  5% cart  3% checkout\n`);
}

export function handleSummary(data) {
    const threshold = data.metrics['http_req_duration'];
    const p95       = threshold && threshold.values['p(95)'];
    const errorPct  = (data.metrics['http_req_failed'].values.rate * 100).toFixed(2);

    console.log('\n════════════════════════════════════════');
    console.log('  SFCC Load Test Summary');
    console.log('════════════════════════════════════════');
    console.log(`  p95 response time : ${p95 ? p95.toFixed(0) + 'ms' : 'N/A'}`);
    console.log(`  Error rate        : ${errorPct}%`);
    console.log(`  Checkout success  : ${data.metrics['sfcc_checkout_success'] ? data.metrics['sfcc_checkout_success'].values.count : 0}`);
    console.log(`  Checkout fail     : ${data.metrics['sfcc_checkout_fail'] ? data.metrics['sfcc_checkout_fail'].values.count : 0}`);
    console.log('════════════════════════════════════════\n');

    return {
        'results/baseline-summary.json': JSON.stringify(data, null, 2)
    };
}
