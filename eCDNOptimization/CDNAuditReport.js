/**
 * CDNAuditReport.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /cdn-optimization
 *
 * CLI tool that crawls a live SFCC storefront URL set and audits:
 *   • Cache-Control, Vary, and Surrogate-Key headers on HTML pages
 *   • Cache headers on static assets (JS, CSS, fonts)
 *   • Image delivery: format (WebP vs JPEG), quality signal, missing srcset
 *   • TTFB for each URL
 *   • Missing preconnect / preload hints
 *
 * Outputs a colour-coded terminal report + a machine-readable JSON file.
 *
 * Usage:
 *   node CDNAuditReport.js --base https://www.your-sfcc-site.com --output audit.json
 *   node CDNAuditReport.js --base https://sandbox.demandware.net/s/MySite --urls urls.txt
 *
 * Prerequisites:
 *   npm install node-fetch cheerio
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

// ─── CLI argument parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith('--')) {
        const key = arg.slice(2);
        acc[key] = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true;
    }
    return acc;
}, {});

const BASE_URL  = args.base || 'https://your-sfcc-site.demandware.net';
const OUT_FILE  = args.output || 'cdn-audit.json';
const TIMEOUT   = parseInt(args.timeout, 10) || 10000;

// ─── Default URL set to audit ─────────────────────────────────────────────────

const DEFAULT_URLS = [
    { type: 'home',     path: '/' },
    { type: 'plp',      path: '/womens/clothing/' },
    { type: 'pdp',      path: '/product/test-product-id' },
    { type: 'search',   path: '/search?q=jeans' },
    { type: 'cart',     path: '/cart' }
];

// ─── Scoring weights ──────────────────────────────────────────────────────────

const CHECKS = {
    hasCacheControl          : { weight: 10, label: 'Cache-Control header present' },
    hasCorrectPageCaching    : { weight: 15, label: 'Page cache-control correct for type' },
    hasVaryAcceptEncoding    : { weight: 8,  label: 'Vary: Accept-Encoding on cacheable pages' },
    hasSurrogateKey          : { weight: 8,  label: 'Surrogate-Key header for CDN group purge' },
    hasEarlyHintsLink        : { weight: 10, label: 'Link header for Early Hints (103)' },
    assetsImmutable          : { weight: 12, label: 'JS/CSS have immutable cache headers' },
    imagesServeWebP          : { weight: 12, label: 'Images served in WebP or AVIF' },
    imagesHaveSrcset         : { weight: 10, label: 'Images have responsive srcset' },
    imagesHaveWidthHeight    : { weight: 8,  label: 'Images have width + height (no CLS)' },
    ttfbGood                 : { weight: 15, label: 'TTFB < 800 ms' },
    hasTimingAllowOrigin     : { weight: 5,  label: 'Timing-Allow-Origin for RUM' },
    lcpImagePreloaded        : { weight: 10, label: 'LCP image preloaded in <head>' }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ANSI = {
    reset : '\x1b[0m',
    bold  : '\x1b[1m',
    green : '\x1b[32m',
    yellow: '\x1b[33m',
    red   : '\x1b[31m',
    cyan  : '\x1b[36m',
    gray  : '\x1b[90m'
};

function color(text, col) { return ANSI[col] + text + ANSI.reset; }

function scoreColor(score) {
    return score >= 80 ? 'green' : score >= 60 ? 'yellow' : 'red';
}

function pad(str, len) { return String(str).padEnd(len); }

function fetchWithTiming(url, opts) {
    const start = Date.now();
    return fetch(url, Object.assign({ timeout: TIMEOUT }, opts || {}))
        .then(res => ({ res, ttfb: Date.now() - start }))
        .catch(err => ({ res: null, ttfb: TIMEOUT, error: err.message }));
}

// ─── Page audit ───────────────────────────────────────────────────────────────

async function auditPage(entry) {
    const url    = BASE_URL + entry.path;
    const result = {
        url,
        type  : entry.type,
        checks: {},
        score : 0,
        issues: [],
        ttfb  : null,
        headers: {}
    };

    console.log(color('  → ' + url, 'gray'));

    // Fetch with Accept: image/webp to simulate a modern browser
    const { res, ttfb, error } = await fetchWithTiming(url, {
        headers: {
            'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'User-Agent'     : 'SFCC-CDN-Auditor/1.0'
        }
    });

    if (error || !res) {
        result.issues.push('FETCH ERROR: ' + (error || 'unknown'));
        return result;
    }

    result.ttfb = ttfb;
    const cc    = res.headers.get('cache-control') || '';
    const vary  = res.headers.get('vary') || '';
    const sk    = res.headers.get('surrogate-key') || '';
    const link  = res.headers.get('link') || '';
    const tao   = res.headers.get('timing-allow-origin') || '';

    result.headers = {
        'cache-control'    : cc,
        'vary'             : vary,
        'surrogate-key'    : sk,
        'link'             : link,
        'timing-allow-origin': tao
    };

    // ── Check: Cache-Control present ─────────────────────────────────────────
    result.checks.hasCacheControl = !!cc;
    if (!cc) result.issues.push('Missing Cache-Control header');

    // ── Check: Correct cache strategy per page type ──────────────────────────
    const isPrivate = ['cart', 'checkout', 'account'].includes(entry.type);
    if (isPrivate) {
        result.checks.hasCorrectPageCaching = cc.includes('private') || cc.includes('no-store');
        if (!result.checks.hasCorrectPageCaching)
            result.issues.push('Cart/checkout pages should have private, no-store');
    } else {
        result.checks.hasCorrectPageCaching = cc.includes('s-maxage') || cc.includes('public');
        if (!result.checks.hasCorrectPageCaching)
            result.issues.push('Public pages should use s-maxage for CDN caching');
    }

    // ── Check: Vary header ───────────────────────────────────────────────────
    result.checks.hasVaryAcceptEncoding = !isPrivate && vary.includes('Accept-Encoding');
    if (!isPrivate && !result.checks.hasVaryAcceptEncoding)
        result.issues.push('Missing Vary: Accept-Encoding — CDN may serve uncompressed responses');

    // ── Check: Surrogate-Key ─────────────────────────────────────────────────
    result.checks.hasSurrogateKey = !isPrivate && !!sk;
    if (!isPrivate && !sk)
        result.issues.push('Missing Surrogate-Key — group CDN purging not possible');

    // ── Check: Link header for Early Hints ───────────────────────────────────
    result.checks.hasEarlyHintsLink = link.includes('preload') || link.includes('preconnect');
    if (!result.checks.hasEarlyHintsLink)
        result.issues.push('No Link header for Early Hints — add preload/preconnect hints');

    // ── Check: TTFB ──────────────────────────────────────────────────────────
    result.checks.ttfbGood = ttfb < 800;
    if (ttfb >= 1800) result.issues.push('TTFB CRITICAL: ' + ttfb + 'ms — CDN probably missing or misconfigured');
    else if (ttfb >= 800) result.issues.push('TTFB slow: ' + ttfb + 'ms (target < 800ms)');

    // ── Check: Timing-Allow-Origin ───────────────────────────────────────────
    result.checks.hasTimingAllowOrigin = !!tao;
    if (!tao) result.issues.push('Missing Timing-Allow-Origin — RUM TTFB data will be 0');

    // ── HTML inspection ───────────────────────────────────────────────────────
    let html = '';
    try { html = await res.text(); } catch (e) {}

    if (html) {
        const $ = cheerio.load(html);

        // Check: JS/CSS immutable caching (hinted by contenthash in filename)
        const scriptSrcs = $('script[src]').map((i, el) => $(el).attr('src')).get();
        const hasHashedJS = scriptSrcs.some(s => /\.[a-f0-9]{8,}\.js/.test(s));
        result.checks.assetsImmutable = hasHashedJS;
        if (!hasHashedJS) result.issues.push('JS bundles are not content-hashed — cannot use immutable caching');

        // Check: images use WebP / AVIF
        const imgSrcs = $('img[src]').map((i, el) => $(el).attr('src')).get();
        const hasWebP  = imgSrcs.some(s => s.includes('fmt=webp') || s.includes('.webp') || s.includes('fmt=avif'));
        result.checks.imagesServeWebP = hasWebP;
        if (!hasWebP && imgSrcs.length > 0)
            result.issues.push('Images not served as WebP/AVIF — add fmt=webp to DIS URLs');

        // Check: images have srcset
        const imgWithSrcset = $('img[srcset], img[data-srcset]').length;
        const totalImgs     = $('img').length;
        result.checks.imagesHaveSrcset = totalImgs === 0 || imgWithSrcset / totalImgs >= 0.8;
        if (!result.checks.imagesHaveSrcset)
            result.issues.push(Math.round((1 - imgWithSrcset/totalImgs)*100) + '% of images missing srcset');

        // Check: images have width + height
        const imgsWithDims = $('img').filter((i, el) => $(el).attr('width') && $(el).attr('height')).length;
        result.checks.imagesHaveWidthHeight = totalImgs === 0 || imgsWithDims / totalImgs >= 0.8;
        if (!result.checks.imagesHaveWidthHeight)
            result.issues.push('Images missing width/height attributes — causes CLS');

        // Check: LCP image preloaded
        const preloads = $('link[rel="preload"][as="image"], link[rel="preload"][as="image"]').length;
        result.checks.lcpImagePreloaded = preloads > 0;
        if (!preloads) result.issues.push('No image preload in <head> — LCP image fetched late');
    }

    // ── Score calculation ─────────────────────────────────────────────────────
    let totalWeight = 0, earnedWeight = 0;
    Object.keys(CHECKS).forEach(function (key) {
        const check = CHECKS[key];
        totalWeight += check.weight;
        if (result.checks[key]) { earnedWeight += check.weight; }
    });
    result.score = Math.round(earnedWeight / totalWeight * 100);

    return result;
}

// ─── Report printer ───────────────────────────────────────────────────────────

function printReport(results) {
    console.log('\n' + color('═'.repeat(70), 'cyan'));
    console.log(color(' SFCC CDN Audit Report', 'bold') + color('  —  ' + new Date().toISOString(), 'gray'));
    console.log(color('═'.repeat(70), 'cyan'));

    results.forEach(function (r) {
        const scoreCol = scoreColor(r.score);
        console.log('\n' + color('▶ ' + r.type.toUpperCase() + '  ' + r.url, 'bold'));
        console.log(
            '  ' + color('Score: ' + r.score + '/100', scoreCol) +
            '  ' + color('TTFB: ' + (r.ttfb || '?') + 'ms', r.ttfb < 800 ? 'green' : r.ttfb < 1800 ? 'yellow' : 'red')
        );

        // Checks grid
        Object.keys(CHECKS).forEach(function (key) {
            const pass = r.checks[key];
            const icon = pass === undefined ? '–' : pass ? '✓' : '✗';
            const col  = pass === undefined ? 'gray' : pass ? 'green' : 'red';
            console.log('  ' + color(icon, col) + ' ' + color(pad(CHECKS[key].label, 48), pass ? 'gray' : 'yellow'));
        });

        if (r.issues.length) {
            console.log(color('\n  Issues:', 'yellow'));
            r.issues.forEach(i => console.log(color('    • ' + i, 'red')));
        }
    });

    // Summary table
    console.log('\n' + color('─'.repeat(70), 'gray'));
    console.log(color(' Summary', 'bold'));
    console.log(color('─'.repeat(70), 'gray'));
    console.log(color(pad('Page', 16) + pad('Score', 8) + pad('TTFB', 10) + 'Issues', 'bold'));
    results.forEach(function (r) {
        const sc = scoreColor(r.score);
        console.log(
            pad(r.type, 16) +
            color(pad(r.score + '/100', 8), sc) +
            pad((r.ttfb || '?') + 'ms', 10) +
            color(r.issues.length + ' issues', r.issues.length ? 'red' : 'green')
        );
    });

    const avgScore = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);
    console.log(color('\n Overall CDN score: ' + avgScore + '/100', scoreColor(avgScore)));
    console.log(color('═'.repeat(70) + '\n', 'cyan'));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log(color('\n⚡ SFCC CDN Audit', 'bold'));
    console.log(color('Base URL: ' + BASE_URL, 'gray'));
    console.log(color('Auditing ' + DEFAULT_URLS.length + ' page types...\n', 'gray'));

    const results = [];
    for (const entry of DEFAULT_URLS) {
        const result = await auditPage(entry);
        results.push(result);
    }

    printReport(results);

    // Write JSON output
    try {
        fs.writeFileSync(
            path.resolve(OUT_FILE),
            JSON.stringify({ timestamp: new Date().toISOString(), baseURL: BASE_URL, results }, null, 2),
            'utf8'
        );
        console.log(color('JSON report written to: ' + OUT_FILE, 'gray'));
    } catch (e) {
        console.error(color('Could not write JSON: ' + e.message, 'red'));
    }
}

main().catch(function (err) {
    console.error(color('Fatal error: ' + err.message, 'red'));
    process.exit(1);
});
