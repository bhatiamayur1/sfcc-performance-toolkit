/**
 * CriticalCSSExtractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /frontend-performance
 *
 * Build-time Node.js script that extracts above-the-fold critical CSS for
 * key SFCC page types (Homepage, PLP, PDP, Cart) and writes inline <style>
 * snippets ready to embed in ISML templates.
 *
 * How it works:
 *   1. Spins up a headless Chromium instance via Puppeteer
 *   2. Navigates to each target SFCC page
 *   3. Uses the Coverage API to identify CSS rules used in the initial viewport
 *   4. Runs those rules through PostCSS to minify
 *   5. Writes output files to /cartridges/.../templates/critical/
 *
 * Run during your CI/CD pipeline BEFORE deploying static assets.
 *
 * Usage:
 *   node CriticalCSSExtractor.js --env staging --viewport 1440x900
 *
 * Prerequisites:
 *   npm install puppeteer postcss cssnano
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const puppeteer = require('puppeteer');
const postcss   = require('postcss');
const cssnano   = require('cssnano');
const fs        = require('fs');
const path      = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
    /** Base URL of the SFCC sandbox / staging environment */
    baseURL: process.env.SFCC_BASE_URL || 'https://your-sandbox.demandware.net/s/SiteID',

    /** Viewport dimensions — match your primary desktop breakpoint */
    viewport: { width: 1440, height: 900 },

    /** Page types to extract critical CSS for */
    pages: [
        {
            id      : 'homepage',
            path    : '/',
            outFile : 'critical-homepage.css',
            ismlVar : 'criticalCSSHomepage'
        },
        {
            id      : 'plp',
            path    : '/womens/clothing/',          // Update to a real category URL
            outFile : 'critical-plp.css',
            ismlVar : 'criticalCSSPLP'
        },
        {
            id      : 'pdp',
            path    : '/product/test-product-id',  // Update to a real product URL
            outFile : 'critical-pdp.css',
            ismlVar : 'criticalCSSPDP'
        },
        {
            id      : 'cart',
            path    : '/cart',
            outFile : 'critical-cart.css',
            ismlVar : 'criticalCSSCart'
        }
    ],

    /** Directory where extracted CSS files are written */
    outputDir: path.resolve(__dirname, '../../cartridges/app_custom_storefront/cartridge/templates/default/critical'),

    /** CSS selector safelist — always include these rules even if not in initial viewport */
    safelist: [
        /^\.header/,
        /^\.nav/,
        /^\.hero/,
        /^\.breadcrumb/,
        /^\.product-tile/,
        /^\.skeleton/,     // Keep skeleton styles for above-fold placeholders
        /^:root/,          // CSS custom properties
        /^html/,
        /^body/
    ],

    /** Navigation timeout (ms) */
    timeout: 30000
};

// ─── Parse CLI args ───────────────────────────────────────────────────────────

const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, val] = arg.replace('--', '').split('=');
    acc[key] = val || true;
    return acc;
}, {});

if (args.viewport) {
    const [w, h] = args.viewport.split('x').map(Number);
    if (w && h) { CONFIG.viewport = { width: w, height: h }; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Checks whether a CSS selector matches the safelist patterns.
 * @param  {string}   selector
 * @param  {RegExp[]} safelist
 * @returns {boolean}
 */
function isSafelisted(selector, safelist) {
    return safelist.some(pattern => pattern.test(selector));
}

/**
 * Filters a full CSS string down to rules used in the coverage report
 * plus safelisted selectors.
 *
 * @param  {string}   fullCSS
 * @param  {Object[]} usedRanges  - Coverage ranges from Puppeteer
 * @param  {RegExp[]} safelist
 * @returns {string}
 */
function filterUsedCSS(fullCSS, usedRanges, safelist) {
    // Build a set of used character ranges
    const usedChars = new Set();
    usedRanges.forEach(({ start, end }) => {
        for (let i = start; i < end; i++) { usedChars.add(i); }
    });

    // Walk the CSS and collect rules that overlap with used ranges
    // This is a simplified approach — for production, use penthouse or critical
    const lines = fullCSS.split('\n');
    const output = [];
    let charIndex = 0;
    let inUsedBlock = false;
    let braceDepth = 0;
    let currentRule = '';

    for (const line of lines) {
        const lineStart = charIndex;
        const lineEnd   = charIndex + line.length + 1; // +1 for \n

        const isUsed = [...Array(lineEnd - lineStart).keys()]
            .some(offset => usedChars.has(lineStart + offset));

        const isSafe = isSafelisted(line.trim(), safelist);

        if (isUsed || isSafe || inUsedBlock) {
            output.push(line);
        }

        // Track brace depth for block context
        const opens  = (line.match(/{/g) || []).length;
        const closes = (line.match(/}/g) || []).length;
        braceDepth += opens - closes;
        inUsedBlock = braceDepth > 0;

        charIndex = lineEnd;
    }

    return output.join('\n');
}

/**
 * Minifies CSS using PostCSS + cssnano.
 * @param  {string} css
 * @returns {Promise<string>}
 */
async function minifyCSS(css) {
    const result = await postcss([cssnano({ preset: 'default' })]).process(css, { from: undefined });
    return result.css;
}

/**
 * Wraps extracted CSS in an ISML-ready <style> block comment with metadata.
 * @param  {string} css
 * @param  {Object} page
 * @returns {string}
 */
function wrapForISML(css, page) {
    return [
        `<!-- Critical CSS: ${page.id} | Generated: ${new Date().toISOString()} -->`,
        `<!-- Embed this in your ${page.id} ISML template inside <head> -->`,
        '<style>',
        css,
        '</style>'
    ].join('\n');
}

// ─── Core extraction ──────────────────────────────────────────────────────────

/**
 * Extracts critical CSS for a single page.
 *
 * @param  {import('puppeteer').Browser} browser
 * @param  {Object} pageConfig
 * @returns {Promise<{ id: string, css: string, bytes: number }>}
 */
async function extractPage(browser, pageConfig) {
    console.log(`  → Extracting: ${pageConfig.id} (${CONFIG.baseURL}${pageConfig.path})`);

    const page = await browser.newPage();
    await page.setViewport(CONFIG.viewport);

    // Enable CSS coverage collection
    await page.coverage.startCSSCoverage();

    // Navigate — wait for network idle to ensure stylesheets are loaded
    await page.goto(`${CONFIG.baseURL}${pageConfig.path}`, {
        waitUntil: 'networkidle2',
        timeout  : CONFIG.timeout
    });

    // Collect coverage
    const cssCoverage = await page.coverage.stopCSSCoverage();

    // Process each stylesheet
    const criticalParts = await Promise.all(
        cssCoverage.map(async ({ url, text, ranges }) => {
            if (!text) { return ''; }
            return filterUsedCSS(text, ranges, CONFIG.safelist);
        })
    );

    const combinedCSS = criticalParts.filter(Boolean).join('\n\n');
    const minified    = await minifyCSS(combinedCSS);

    await page.close();

    return {
        id   : pageConfig.id,
        css  : minified,
        bytes: Buffer.byteLength(minified, 'utf8')
    };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n⚡ SFCC Critical CSS Extractor');
    console.log('─'.repeat(50));
    console.log(`  Base URL  : ${CONFIG.baseURL}`);
    console.log(`  Viewport  : ${CONFIG.viewport.width}×${CONFIG.viewport.height}`);
    console.log(`  Output dir: ${CONFIG.outputDir}`);
    console.log('─'.repeat(50) + '\n');

    // Ensure output directory exists
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new',
        args    : ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const results = [];

    try {
        for (const pageConfig of CONFIG.pages) {
            try {
                const result = await extractPage(browser, pageConfig);
                results.push(result);

                // Write raw CSS file
                const cssPath = path.join(CONFIG.outputDir, pageConfig.outFile);
                fs.writeFileSync(cssPath, result.css, 'utf8');

                // Write ISML-ready snippet
                const ismlPath = path.join(CONFIG.outputDir, pageConfig.outFile.replace('.css', '.isml'));
                fs.writeFileSync(ismlPath, wrapForISML(result.css, pageConfig), 'utf8');

                console.log(`  ✓ ${pageConfig.id.padEnd(12)} ${(result.bytes / 1024).toFixed(1)} KB`);
            } catch (err) {
                console.error(`  ✗ ${pageConfig.id}: ${err.message}`);
            }
        }
    } finally {
        await browser.close();
    }

    // Summary
    const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
    console.log('\n' + '─'.repeat(50));
    console.log(`  Total extracted: ${(totalBytes / 1024).toFixed(1)} KB across ${results.length} page types`);
    console.log('  Output written to:', CONFIG.outputDir);
    console.log('\n  Next step: embed each .isml file in your ISML <head> template:');
    console.log('  <isinclude template="critical/critical-homepage" />');
    console.log('\n  Then defer your main stylesheet:');
    console.log('  <link rel="preload" href="${mainCSS}" as="style" onload="this.onload=null;this.rel=\'stylesheet\'">');
    console.log('─'.repeat(50) + '\n');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
