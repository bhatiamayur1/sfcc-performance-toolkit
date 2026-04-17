/**
 * BottleneckAnalyser.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /load-testing/scripts
 *
 * Parses k6 JSON results and surfaces the most impactful bottlenecks,
 * ranked by severity, with SFCC-specific fix recommendations.
 *
 * Usage:
 *   node BottleneckAnalyser.js results/baseline-summary.json
 *   node BottleneckAnalyser.js results/baseline-summary.json --format html
 *   node BottleneckAnalyser.js results/*.json --compare
 *
 * Input: k6 summary JSON (generated with --out json or handleSummary return)
 * Output: colour-coded terminal report + optional HTML report
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const C = {
    reset  : '\x1b[0m',
    bold   : '\x1b[1m',
    dim    : '\x1b[2m',
    red    : '\x1b[31m',
    green  : '\x1b[32m',
    yellow : '\x1b[33m',
    cyan   : '\x1b[36m',
    magenta: '\x1b[35m',
    white  : '\x1b[37m',
    gray   : '\x1b[90m'
};

const c = (text, ...codes) => codes.map(x => C[x] || '').join('') + text + C.reset;

// ─── SFCC bottleneck registry ─────────────────────────────────────────────────

/**
 * Bottleneck detection rules.
 * Each rule defines a metric pattern, a threshold, a severity, and
 * SFCC-specific recommendations.
 */
const BOTTLENECK_RULES = [
    // ── Latency rules ─────────────────────────────────────────────────────────
    {
        id       : 'PAGE_P95_HIGH',
        metric   : 'http_req_duration',
        tag      : 'type:page',
        stat     : 'p(95)',
        warnAt   : 1500,
        critAt   : 3000,
        label    : 'Page response time p95',
        unit     : 'ms',
        fix      : [
            'Enable CDN caching (s-maxage) — most impactful single change',
            'Apply PartialPageCache.js to navigation, promo banners, product tiles',
            'Run CriticalCSSExtractor.js to eliminate render-blocking CSS'
        ]
    },
    {
        id       : 'API_P95_HIGH',
        metric   : 'http_req_duration',
        tag      : 'type:api',
        stat     : 'p(95)',
        warnAt   : 500,
        critAt   : 1500,
        label    : 'AJAX/API response time p95',
        unit     : 'ms',
        fix      : [
            'Wrap slow OCAPI calls with APIResponseCache.getOrFetch()',
            'Use RequestBatcher.js to batch product/category data calls',
            'Review Business Manager → Operations → Services for slow service configs'
        ]
    },
    {
        id       : 'CHECKOUT_FUNNEL_SLOW',
        metric   : 'checkout_funnel_total_ms',
        stat     : 'p(95)',
        warnAt   : 15000,
        critAt   : 30000,
        label    : 'End-to-end checkout funnel p95',
        unit     : 'ms',
        fix      : [
            'Apply PaymentGatewayAdapter.js for timeout + retry',
            'Use OMSIntegrationAdapter.submitOrderAsync() to dequeue OMS from checkout',
            'Deploy IntegrationCircuitBreaker.js for all payment/tax/fraud services',
            'Apply CheckoutStepReducer.js to merge address + shipping steps'
        ]
    },
    {
        id       : 'PLACE_ORDER_SLOW',
        metric   : 'checkout_place_order_ms',
        stat     : 'p(95)',
        warnAt   : 5000,
        critAt   : 10000,
        label    : 'Place Order call p95',
        unit     : 'ms',
        fix      : [
            'Profile with CheckoutBottleneckProfiler.js — identify which sub-call is slowest',
            'Cache tax calculations (rarely change for same basket+address)',
            'Move fraud scoring to async post-auth (does not need to block order create)',
            'Check payment gateway circuit breaker state'
        ]
    },
    {
        id       : 'SPIKE_TTFB_HIGH',
        metric   : 'spike_ttfb_ms',
        stat     : 'p(95)',
        warnAt   : 800,
        critAt   : 2000,
        label    : 'TTFB during spike (p95)',
        unit     : 'ms',
        fix      : [
            'Verify CDN is configured correctly — TTFB > 800ms at edge = origin hit',
            'Warm cache before campaign launch with SearchIndexWarmup.js',
            'Apply TTFBReducer.applyEarlyHints() for 103 Early Hints',
            'Check SFCC pod auto-scaling headroom in Business Manager'
        ]
    },
    // ── Error rate rules ──────────────────────────────────────────────────────
    {
        id       : 'ERROR_RATE_HIGH',
        metric   : 'http_req_failed',
        stat     : 'rate',
        warnAt   : 0.01,
        critAt   : 0.05,
        label    : 'HTTP error rate',
        unit     : '%',
        multiplier: 100,
        fix      : [
            'Check SFCC Business Manager → Operations → Logs for 5xx patterns',
            'Review service circuit breaker states with IntegrationHealthDashboard',
            'Verify CDN origin shield is not throttling requests',
            'Check database connection pool limits (BM → Administration → Operations)'
        ]
    },
    {
        id       : 'CHECKOUT_ERRORS',
        metric   : 'checkout_session_error_rate',
        stat     : 'rate',
        warnAt   : 0.02,
        critAt   : 0.10,
        label    : 'Checkout session error rate',
        unit     : '%',
        multiplier: 100,
        fix      : [
            'Inspect checkout_csrf_errors count — may indicate session expiry under load',
            'Increase SFCC session cache size (BM → Administration → Sites → Site Preferences)',
            'Check for cart invalidation race conditions on high-concurrency add-to-cart'
        ]
    },
    // ── Throughput rules ──────────────────────────────────────────────────────
    {
        id       : 'RATE_LIMIT_HITS',
        metric   : 'spike_rate_limit_429',
        stat     : 'count',
        warnAt   : 10,
        critAt   : 200,
        label    : '429 Rate limit hits',
        unit     : ' hits',
        fix      : [
            'Increase OCAPI request quota in BM → Administration → Site Development → Open Commerce API Settings',
            'Add exponential backoff in RetryHandler.js for 429 responses',
            'Cache OCAPI responses where possible (APIResponseCache.js)'
        ]
    },
    {
        id       : 'CSRF_ERRORS',
        metric   : 'checkout_csrf_errors',
        stat     : 'count',
        warnAt   : 5,
        critAt   : 50,
        label    : 'CSRF token extraction failures',
        unit     : ' occurrences',
        fix      : [
            'Session cookie duration may be too short for test think times',
            'Verify checkout pages render CSRF tokens in expected HTML positions',
            'Under extreme concurrency, session store may be dropping entries'
        ]
    },
    {
        id       : 'INVENTORY_CONFLICTS',
        metric   : 'checkout_inventory_conflict',
        stat     : 'count',
        warnAt   : 20,
        critAt   : 100,
        label    : 'Inventory reservation conflicts (409s)',
        unit     : ' conflicts',
        fix      : [
            'Expected under spike test — confirms inventory service is protecting stock correctly',
            'Consider soft reservation with 15-min hold (reduces conflict rate)',
            'Cache inventory availability separately from reservation (read vs write path)'
        ]
    }
];

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Extracts a metric value from k6 JSON results.
 * k6 JSON structure varies between summary and streaming output.
 *
 * @param  {Object} data     - Parsed k6 JSON
 * @param  {string} metric   - Metric name
 * @param  {string} stat     - Stat name (e.g. 'p(95)', 'rate', 'count')
 * @param  {string} [tag]    - Optional tag filter (e.g. 'type:page')
 * @returns {number|null}
 */
function extractMetric(data, metric, stat, tag) {
    if (!data || !data.metrics) { return null; }

    // Try direct metric
    const direct = data.metrics[metric];
    if (direct && direct.values) {
        const val = direct.values[stat];
        return val !== undefined ? val : null;
    }

    // Try with tag filter (k6 creates tagged variants like 'http_req_duration{type:page}')
    if (tag) {
        const tagged = data.metrics[`${metric}{${tag}}`];
        if (tagged && tagged.values) {
            const val = tagged.values[stat];
            return val !== undefined ? val : null;
        }
    }

    return null;
}

// ─── Bottleneck analyser ──────────────────────────────────────────────────────

/**
 * Analyses a k6 results object and returns ranked bottleneck findings.
 *
 * @param  {Object} data  - Parsed k6 JSON summary
 * @returns {Object[]}    - Sorted bottleneck findings
 */
function analyse(data) {
    const findings = [];

    for (const rule of BOTTLENECK_RULES) {
        const rawValue = extractMetric(data, rule.metric, rule.stat, rule.tag);
        if (rawValue === null) { continue; }

        const value      = rawValue * (rule.multiplier || 1);
        const isCritical = value >= rule.critAt;
        const isWarning  = value >= rule.warnAt;

        if (!isWarning) { continue; }

        findings.push({
            id      : rule.id,
            label   : rule.label,
            value   : value,
            unit    : rule.unit,
            severity: isCritical ? 'CRITICAL' : 'WARNING',
            score   : isCritical ? (value / rule.critAt) * 2 : (value / rule.warnAt),
            warnAt  : rule.warnAt * (rule.multiplier || 1),
            critAt  : rule.critAt * (rule.multiplier || 1),
            fix     : rule.fix
        });
    }

    // Sort by score descending (worst first)
    return findings.sort((a, b) => b.score - a.score);
}

// ─── Reporter ─────────────────────────────────────────────────────────────────

function formatValue(value, unit) {
    if (unit === 'ms')  { return value.toFixed(0) + ' ms'; }
    if (unit === '%')   { return value.toFixed(2) + '%'; }
    return value.toFixed(0) + unit;
}

function printReport(filename, data, findings) {
    console.log('\n' + c('═'.repeat(64), 'cyan'));
    console.log(c('  SFCC Load Test Bottleneck Analysis', 'bold', 'white'));
    console.log(c(`  File: ${path.basename(filename)}`, 'dim'));
    console.log(c('═'.repeat(64), 'cyan'));

    // Summary metrics
    const rps      = data.metrics['http_reqs'] && data.metrics['http_reqs'].values['rate'];
    const vus      = data.metrics['vus_max']   && data.metrics['vus_max'].values['max'];
    const duration = data.metrics['http_req_duration'] && data.metrics['http_req_duration'].values;

    if (rps || vus) {
        console.log(c('\n  Test Overview', 'bold'));
        if (vus)              { console.log(`  Peak VUs        : ${c(vus, 'cyan')}`); }
        if (rps)              { console.log(`  Req/sec         : ${c(rps.toFixed(1), 'cyan')}`); }
        if (duration) {
            console.log(`  p50 response    : ${c(duration['med'].toFixed(0) + 'ms', 'green')}`);
            console.log(`  p95 response    : ${c(duration['p(95)'].toFixed(0) + 'ms', duration['p(95)'] < 2000 ? 'green' : 'yellow')}`);
            console.log(`  p99 response    : ${c(duration['p(99)'].toFixed(0) + 'ms', duration['p(99)'] < 5000 ? 'yellow' : 'red')}`);
        }
    }

    // Bottleneck findings
    console.log(c(`\n  Bottlenecks Found: ${findings.length}`, 'bold'));
    console.log(c('─'.repeat(64), 'gray'));

    if (findings.length === 0) {
        console.log(c('  ✓ No bottlenecks detected above warning threshold\n', 'green'));
        return;
    }

    findings.forEach((f, i) => {
        const sevColor  = f.severity === 'CRITICAL' ? 'red' : 'yellow';
        const icon      = f.severity === 'CRITICAL' ? '✗' : '⚠';
        const rank      = c(`[${i + 1}]`, 'dim');
        const sev       = c(` ${icon} ${f.severity} `, sevColor, 'bold');
        const label     = c(f.label, 'white', 'bold');
        const val       = c(formatValue(f.value, f.unit), sevColor);
        const threshold = c(`(warn:${formatValue(f.warnAt, f.unit)} crit:${formatValue(f.critAt, f.unit)})`, 'dim');

        console.log(`\n  ${rank} ${sev} ${label}`);
        console.log(`       Measured: ${val}  ${threshold}`);
        console.log(c('       SFCC Fixes:', 'cyan'));
        f.fix.forEach(fix => {
            console.log(c(`         • ${fix}`, 'gray'));
        });
    });

    console.log('\n' + c('═'.repeat(64), 'cyan') + '\n');
}

// ─── HTML report builder ──────────────────────────────────────────────────────

function buildHTMLReport(filename, data, findings) {
    const rows = findings.map((f, i) => {
        const sevClass = f.severity === 'CRITICAL' ? 'critical' : 'warning';
        const fixes    = f.fix.map(fix => `<li>${fix}</li>`).join('');
        return `
      <tr class="${sevClass}">
        <td>${i + 1}</td>
        <td><span class="badge ${sevClass}">${f.severity}</span></td>
        <td>${f.label}</td>
        <td><strong>${formatValue(f.value, f.unit)}</strong></td>
        <td>${formatValue(f.warnAt, f.unit)} / ${formatValue(f.critAt, f.unit)}</td>
        <td><ul>${fixes}</ul></td>
      </tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SFCC Load Test Bottleneck Report — ${path.basename(filename)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      background:#f8fafc;color:#1e293b;padding:32px; }
    h1 { font-size:22px;font-weight:700;color:#0f172a;margin-bottom:4px; }
    .subtitle { color:#64748b;font-size:13px;margin-bottom:24px; }
    table { width:100%;border-collapse:collapse;background:#fff;
      border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08); }
    th { background:#1e293b;color:#e2e8f0;font-size:12px;
      padding:10px 14px;text-align:left;letter-spacing:.05em; }
    td { padding:12px 14px;font-size:13px;border-bottom:1px solid #f1f5f9;vertical-align:top; }
    td ul { padding-left:16px;color:#475569; }
    td ul li { margin-bottom:4px; }
    .badge { font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;letter-spacing:.05em; }
    .critical td { background:#fff5f5; }
    .warning td  { background:#fffbeb; }
    .badge.critical { background:#fee2e2;color:#b91c1c; }
    .badge.warning  { background:#fef3c7;color:#92400e; }
    .none { padding:24px;color:#64748b;font-style:italic; }
  </style>
</head>
<body>
  <h1>SFCC Load Test — Bottleneck Analysis</h1>
  <p class="subtitle">Source: ${path.basename(filename)} · Generated: ${new Date().toISOString()}</p>
  ${findings.length === 0
    ? '<p class="none">✓ No bottlenecks detected above warning threshold.</p>'
    : `<table>
    <thead><tr>
      <th>#</th><th>Severity</th><th>Bottleneck</th>
      <th>Measured</th><th>Warn / Critical</th><th>SFCC Fixes</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
</body>
</html>`;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const htmlMode = args.includes('--format') && args[args.indexOf('--format') + 1] === 'html';
const files    = args.filter(a => !a.startsWith('--') && a !== 'html');

if (files.length === 0) {
    console.error(c('Usage: node BottleneckAnalyser.js <results.json> [--format html]', 'red'));
    process.exit(1);
}

files.forEach(file => {
    if (!fs.existsSync(file)) {
        console.error(c(`File not found: ${file}`, 'red'));
        return;
    }

    const data     = JSON.parse(fs.readFileSync(file, 'utf8'));
    const findings = analyse(data);

    if (htmlMode) {
        const outFile = file.replace('.json', '-bottlenecks.html');
        fs.writeFileSync(outFile, buildHTMLReport(file, data, findings));
        console.log(c(`HTML report written: ${outFile}`, 'green'));
    } else {
        printReport(file, data, findings);
    }
});
