/**
 * spike-test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /load-testing/scenarios
 *
 * Spike test: simulates sudden, extreme traffic surges — flash sales,
 * TV ads, viral social posts, email campaigns with a single CTA.
 *
 * These events cause 10–50× normal traffic in under 60 seconds.
 * Unlike gradual ramp-up tests, spike tests expose:
 *   • Thread pool exhaustion behaviour
 *   • Cache cold-start under pressure
 *   • CDN origin shield overload
 *   • Database connection pool limits
 *   • Payment gateway rate limiting (429s)
 *   • Auto-scaling lag (cloud SFCC PODs)
 *
 * Three spike shapes tested:
 *   1. INSTANT SPIKE  — 0 to 500 VUs in 10s (worst-case flash sale)
 *   2. WAVE SPIKE     — Three rolling waves 200 → 400 → 600 VUs
 *   3. SUSTAINED HIGH — 300 VUs held for 10 min (email campaign landing)
 *
 * Run:
 *   k6 run spike-test.js
 *   k6 run --env SPIKE_TYPE=wave spike-test.js
 *   k6 run --env SPIKE_TYPE=sustained spike-test.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

import http  from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { randomItem, randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// ─── Custom metrics ────────────────────────────────────────────────────────────

const errorRate          = new Rate('spike_error_rate');
const rateLimitHits      = new Counter('spike_rate_limit_429');
const timeoutCount       = new Counter('spike_timeout_count');
const ttfb               = new Trend('spike_ttfb_ms', true);
const recoveryTime       = new Trend('spike_recovery_ms', true);
const stockCheckLatency  = new Trend('spike_stock_check_ms', true);

// ─── Configuration ─────────────────────────────────────────────────────────────

const BASE_URL   = __ENV.BASE_URL   || 'https://your-sandbox.demandware.net/s/SiteID';
const SPIKE_TYPE = __ENV.SPIKE_TYPE || 'instant';   // 'instant' | 'wave' | 'sustained'

// Flash sale target: a specific high-demand product
const FLASH_SALE_PID = __ENV.FLASH_PID || 'P001-limited-edition-sneaker';
const FLASH_SALE_URL = `${BASE_URL}/product/${FLASH_SALE_PID}`;

// ─── Stage configurations ─────────────────────────────────────────────────────

const STAGE_CONFIGS = {
    instant: {
        description: 'Instant spike: 0 → 500 VUs in 10s (flash sale moment)',
        stages: [
            { duration: '30s',  target: 5   },   // Pre-spike baseline
            { duration: '10s',  target: 500 },   // SPIKE — 100× increase in 10s
            { duration: '5m',   target: 500 },   // Hold at peak
            { duration: '2m',   target: 50  },   // Begin recovery
            { duration: '3m',   target: 5   }    // Confirm full recovery
        ]
    },
    wave: {
        description: 'Wave spike: three rolling traffic peaks',
        stages: [
            { duration: '1m',  target: 20  },
            { duration: '30s', target: 200 },   // Wave 1
            { duration: '2m',  target: 200 },
            { duration: '30s', target: 50  },   // Trough
            { duration: '30s', target: 400 },   // Wave 2 (higher)
            { duration: '2m',  target: 400 },
            { duration: '30s', target: 50  },   // Trough
            { duration: '30s', target: 600 },   // Wave 3 (highest)
            { duration: '3m',  target: 600 },
            { duration: '3m',  target: 0   }    // Recovery
        ]
    },
    sustained: {
        description: 'Sustained high load: email campaign arrival over 10 min',
        stages: [
            { duration: '2m',  target: 50  },
            { duration: '3m',  target: 300 },   // Ramp to campaign load
            { duration: '10m', target: 300 },   // Sustained campaign traffic
            { duration: '5m',  target: 50  },   // Wind down
            { duration: '2m',  target: 0   }
        ]
    }
};

const stageConfig = STAGE_CONFIGS[SPIKE_TYPE] || STAGE_CONFIGS.instant;

export const options = {
    stages: stageConfig.stages,

    thresholds: {
        // Spike thresholds are more lenient — some degradation is acceptable
        'http_req_duration':                  ['p(95)<5000'],   // 5s p95 during spike
        'http_req_duration{type:page}':       ['p(90)<3000'],
        'http_req_failed':                    ['rate<0.05'],    // < 5% errors at peak
        'spike_error_rate':                   ['rate<0.10'],    // < 10% total errors
        'spike_rate_limit_429':               ['count<500'],    // < 500 rate-limit hits
        'spike_timeout_count':                ['count<100'],    // < 100 timeouts
    },

    summaryTrendStats: ['min', 'med', 'avg', 'p(75)', 'p(90)', 'p(95)', 'p(99)', 'max']
};

// ─── Headers ──────────────────────────────────────────────────────────────────

const HEADERS = {
    'Accept'         : 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent'     : `k6-SpikeTest/1.0-VU${__VU}`
};

const AJAX_HEADERS = {
    'Content-Type'     : 'application/json',
    'X-Requested-With' : 'XMLHttpRequest'
};

// ─── Flash sale product page journey ─────────────────────────────────────────

/**
 * Primary spike scenario: every VU hits the flash sale product page.
 * Represents the thundering-herd pattern of a limited product launch.
 */
function flashSalePDPJourney() {
    group('Flash Sale PDP', function () {
        const start = Date.now();

        const res = http.get(FLASH_SALE_URL, {
            headers: HEADERS,
            tags   : { type: 'page', journey: 'flash_sale' }
        });

        ttfb.add(res.timings.waiting);  // TTFB specifically

        if (res.status === 429) {
            rateLimitHits.add(1);
            errorRate.add(1);
            sleep(randomIntBetween(5, 15));  // Back off on rate limit
            return;
        }

        if (res.status === 503 || res.status === 504) {
            timeoutCount.add(1);
            errorRate.add(1);
            return;
        }

        check(res, {
            'Flash sale PDP — 200 OK'      : (r) => r.status === 200,
            'Flash sale PDP — has product' : (r) => r.body && r.body.includes('add-to-cart'),
            'Flash sale PDP — TTFB < 1s'   : (r) => r.timings.waiting < 1000,
            'Flash sale PDP — load < 3s'   : (r) => r.timings.duration < 3000
        });

        errorRate.add(res.status >= 400 ? 1 : 0);
        sleep(randomIntBetween(1, 3));

        // Real-time inventory check (critical under spike — often the bottleneck)
        const stockStart = Date.now();
        const stockRes   = http.get(
            `${BASE_URL}/Product-Variation?pid=${FLASH_SALE_PID}&Quantity=1`,
            { headers: AJAX_HEADERS, tags: { type: 'api', journey: 'stock_check' } }
        );
        stockCheckLatency.add(Date.now() - stockStart);

        check(stockRes, {
            'Stock check — responds'  : (r) => r.status === 200 || r.status === 404,
            'Stock check — < 2s'      : (r) => r.timings.duration < 2000
        });

        // Measure full journey recovery time
        recoveryTime.add(Date.now() - start);

        sleep(randomIntBetween(2, 5));
    });
}

/**
 * Secondary spike scenario: homepage → category → PDP navigation
 * Represents organic social traffic that doesn't land directly on the product.
 */
function spikeNavigationJourney() {
    group('Spike Navigation', function () {
        // Homepage under spike conditions
        const homeRes = http.get(`${BASE_URL}/`, {
            headers: HEADERS,
            tags   : { type: 'page', journey: 'spike_nav' }
        });
        ttfb.add(homeRes.timings.waiting);
        errorRate.add(homeRes.status >= 400 ? 1 : 0);

        if (homeRes.status === 503) {
            timeoutCount.add(1);
            return;
        }

        sleep(randomIntBetween(1, 2));

        // Sale category (highest traffic during spike events)
        const catRes = http.get(`${BASE_URL}/sale/`, {
            headers: HEADERS,
            tags   : { type: 'page', journey: 'spike_nav' }
        });
        errorRate.add(catRes.status >= 400 ? 1 : 0);

        sleep(randomIntBetween(1, 3));

        // Flash sale PDP
        flashSalePDPJourney();
    });
}

/**
 * Add-to-cart burst: users frantically clicking Add to Cart on limited stock.
 * Most likely to exhaust inventory service connections.
 */
function spikCartBurst() {
    group('Spike Add-to-Cart Burst', function () {
        // Multiple rapid add-to-cart attempts (panic buying behaviour)
        for (let i = 0; i < randomIntBetween(1, 3); i++) {
            const addRes = http.post(
                `${BASE_URL}/Cart-AddProduct`,
                JSON.stringify({ pid: FLASH_SALE_PID, quantity: 1 }),
                {
                    headers: AJAX_HEADERS,
                    tags   : { type: 'api', journey: 'spike_cart' }
                }
            );

            if (addRes.status === 429) { rateLimitHits.add(1); break; }

            check(addRes, {
                'Add to cart — responds'        : (r) => r.status === 200 || r.status === 409,
                'Add to cart — not server error': (r) => r.status < 500
            });

            errorRate.add(addRes.status >= 500 ? 1 : 0);
            sleep(randomIntBetween(0.5, 2));
        }
    });
}

// ─── Main VU function ─────────────────────────────────────────────────────────

export default function () {
    const roll = Math.random() * 100;

    // Under spike conditions, most traffic goes directly to the flash sale product
    if (roll < 60) {
        flashSalePDPJourney();
    } else if (roll < 85) {
        spikeNavigationJourney();
    } else {
        spikCartBurst();
    }

    sleep(randomIntBetween(1, 2));
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export function setup() {
    console.log(`\n⚡ SFCC Spike Test — ${SPIKE_TYPE.toUpperCase()}`);
    console.log(`   ${stageConfig.description}`);
    console.log(`   Flash sale product: ${FLASH_SALE_URL}\n`);
}

export function handleSummary(data) {
    const errors    = (data.metrics['spike_error_rate'].values.rate * 100).toFixed(1);
    const p99       = data.metrics['http_req_duration'] &&
                      data.metrics['http_req_duration'].values['p(99)'];
    const rls       = data.metrics['spike_rate_limit_429'].values.count;
    const timeouts  = data.metrics['spike_timeout_count'].values.count;

    console.log('\n════════════════════════════════════════');
    console.log(`  Spike Test Summary — ${SPIKE_TYPE.toUpperCase()}`);
    console.log('════════════════════════════════════════');
    console.log(`  p99 response time   : ${p99 ? p99.toFixed(0) + 'ms' : 'N/A'}`);
    console.log(`  Error rate          : ${errors}%`);
    console.log(`  Rate limit (429) hits: ${rls}`);
    console.log(`  Timeouts            : ${timeouts}`);
    console.log('════════════════════════════════════════\n');

    return {
        [`results/spike-${SPIKE_TYPE}-summary.json`]: JSON.stringify(data, null, 2)
    };
}
