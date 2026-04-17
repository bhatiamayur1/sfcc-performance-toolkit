/**
 * EdgeCacheStrategy.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /headless-performance/edge-caching
 *
 * Edge caching strategies for SFCC headless storefronts deployed on
 * Vercel Edge Network, Cloudflare Workers, or Fastly Compute@Edge.
 *
 * Core concept: in a headless SFCC stack, the origin bottleneck shifts
 * from SFCC's PIG servers to your SSR/API layer. Edge caching intercepts
 * requests at the CDN PoP closest to the user, serving pre-rendered pages
 * from memory in < 5ms instead of SSR-generating them in 200–800ms.
 *
 * Three strategies implemented:
 *
 *   1. STALE-WHILE-REVALIDATE (SWR)
 *      Returns cached HTML instantly, triggers background revalidation.
 *      The user never waits. Content is eventually consistent.
 *
 *   2. CACHE TAGS / SURROGATE KEYS
 *      Tags every cached response with entity IDs (product IDs, category IDs).
 *      On a price change or stock update, purge exactly the pages that show
 *      that product — not the whole cache.
 *
 *   3. REGIONAL CACHE VARIANCE
 *      Vary cache entries by locale + currency. Each locale/currency combo
 *      gets its own cached version, preventing cross-contamination.
 *
 * Usage (Next.js middleware.ts / Edge Function):
 *   import { EdgeCacheStrategy } from '@/lib/sfcc/EdgeCacheStrategy'
 *
 *   const strategy = EdgeCacheStrategy.forPageType('pdp')
 *   response.headers.set('Cache-Control', strategy.cacheControl)
 *   response.headers.set('Surrogate-Key', strategy.surrogateKeys(pid, locale))
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Cache profiles ───────────────────────────────────────────────────────────

/**
 * Edge cache profiles per headless page type.
 * s-maxage  = edge cache TTL (what the CDN stores)
 * max-age   = browser cache TTL
 * stale-while-revalidate = serve stale for this long while revalidating
 * stale-if-error = serve stale if origin returns 5xx
 */
const CACHE_PROFILES = {
    home: {
        sMaxAge   : 300,
        maxAge    : 0,
        swr       : 60,
        sif       : 86400,
        tags      : ['page:home'],
        vary      : ['x-locale', 'x-currency'],
        revalidate: 300   // Next.js ISR revalidate (seconds)
    },
    plp: {
        sMaxAge   : 600,
        maxAge    : 0,
        swr       : 120,
        sif       : 86400,
        tags      : ['page:plp'],
        vary      : ['x-locale', 'x-currency'],
        revalidate: 300
    },
    pdp: {
        sMaxAge   : 300,
        maxAge    : 0,
        swr       : 60,
        sif       : 3600,
        tags      : ['page:pdp'],
        vary      : ['x-locale', 'x-currency'],
        revalidate: 180
    },
    search: {
        sMaxAge   : 120,
        maxAge    : 0,
        swr       : 60,
        sif       : 3600,
        tags      : ['page:search'],
        vary      : ['x-locale', 'x-currency'],
        revalidate: 120
    },
    'api:product': {
        sMaxAge   : 180,
        maxAge    : 0,
        swr       : 60,
        sif       : 3600,
        tags      : ['api:product'],
        vary      : ['x-locale', 'x-currency', 'accept'],
        revalidate: 180
    },
    'api:search': {
        sMaxAge   : 60,
        maxAge    : 0,
        swr       : 30,
        sif       : 900,
        tags      : ['api:search'],
        vary      : ['x-locale', 'x-currency'],
        revalidate: 60
    },
    'api:cart': {
        sMaxAge   : 0,
        maxAge    : 0,
        swr       : 0,
        sif       : 0,
        tags      : [],
        vary      : [],
        private   : true,
        revalidate: 0
    }
};

// ─── Strategy builder ─────────────────────────────────────────────────────────

class EdgeCacheStrategy {
    /**
     * @param {string} pageType - Key from CACHE_PROFILES
     */
    constructor(pageType) {
        this._profile = CACHE_PROFILES[pageType] || CACHE_PROFILES.pdp;
        this._pageType = pageType;
    }

    static forPageType(pageType) {
        return new EdgeCacheStrategy(pageType);
    }

    /**
     * Generates the full Cache-Control header value.
     * @returns {string}
     */
    get cacheControl() {
        const p = this._profile;

        if (p.private) {
            return 'private, no-store';
        }

        const parts = [
            'public',
            `s-maxage=${p.sMaxAge}`,
            `max-age=${p.maxAge}`
        ];

        if (p.swr > 0) { parts.push(`stale-while-revalidate=${p.swr}`); }
        if (p.sif > 0) { parts.push(`stale-if-error=${p.sif}`); }

        return parts.join(', ');
    }

    /**
     * Generates Surrogate-Key / Cache-Tag header values for group purging.
     *
     * @param  {Object} entities   - { productId?, categoryId?, locale?, currency? }
     * @returns {string}  Space-separated surrogate keys
     */
    surrogateKeys(entities = {}) {
        const keys = [...this._profile.tags];

        if (entities.productId)  { keys.push(`product:${entities.productId}`); }
        if (entities.categoryId) { keys.push(`category:${entities.categoryId}`); }
        if (entities.locale)     { keys.push(`locale:${entities.locale}`); }
        if (entities.currency)   { keys.push(`currency:${entities.currency}`); }

        return keys.join(' ');
    }

    /**
     * Generates the Vary header for locale/currency cache separation.
     * @returns {string}
     */
    get vary() {
        const base = ['Accept-Encoding'];
        return [...base, ...this._profile.vary].join(', ');
    }

    /**
     * Next.js revalidate value for ISR / on-demand revalidation.
     * @returns {number}
     */
    get nextRevalidate() {
        return this._profile.revalidate;
    }

    /**
     * Returns a complete headers object ready to spread onto a Response.
     * @param  {Object} [entities]
     * @returns {Object}
     */
    toHeaders(entities = {}) {
        const headers = {
            'Cache-Control': this.cacheControl,
            'Vary'          : this.vary
        };

        const sk = this.surrogateKeys(entities);
        if (sk) {
            // Vercel uses Cache-Tag, Cloudflare uses Cache-Tag, Fastly uses Surrogate-Key
            headers['Cache-Tag']      = sk;
            headers['Surrogate-Key']  = sk;
            // Akamai uses Edge-Control
            headers['Edge-Control']   = `max-age=${this._profile.sMaxAge}`;
        }

        return headers;
    }
}

// ─── Cloudflare Workers edge handler ─────────────────────────────────────────

/**
 * Cloudflare Workers / Vercel Edge Middleware handler.
 * Applies cache headers and locale-based cache key construction.
 *
 * Usage (Cloudflare Worker):
 *   import { edgeCacheHandler } from './EdgeCacheStrategy'
 *   export default { fetch: edgeCacheHandler }
 *
 * @param  {Request}     request
 * @param  {Function}    next      - () => Promise<Response>
 * @param  {Object}      [opts]
 * @returns {Promise<Response>}
 */
export async function edgeCacheHandler(request, next, opts = {}) {
    const url      = new URL(request.url);
    const pageType = detectPageType(url.pathname);
    const strategy = EdgeCacheStrategy.forPageType(pageType);
    const locale   = request.headers.get('x-locale') || 'en-GB';
    const currency = request.headers.get('x-currency') || 'GBP';

    // Build a canonical cache key that includes locale+currency but
    // strips non-canonical query params (sort rules, pagination, UTM)
    const cacheKey = buildCacheKey(url, locale, currency);

    // Check edge cache first (Cloudflare KV / Vercel Cache)
    if (opts.cache) {
        const cached = await opts.cache.match(cacheKey);
        if (cached) {
            const age    = Math.round((Date.now() - (parseInt(cached.headers.get('x-cache-date') || '0'))) / 1000);
            const maxAge = strategy._profile.sMaxAge;

            // Still fresh — return immediately
            if (age < maxAge) {
                const res = new Response(cached.body, cached);
                res.headers.set('X-Cache',    'HIT');
                res.headers.set('X-Cache-Age', String(age));
                return res;
            }

            // Stale — return stale and revalidate in background
            if (age < maxAge + strategy._profile.swr) {
                // Revalidate in background (non-blocking)
                opts.ctx && opts.ctx.waitUntil(
                    revalidate(cacheKey, request, next, strategy, opts.cache)
                );

                const res = new Response(cached.body, cached);
                res.headers.set('X-Cache',    'STALE');
                res.headers.set('X-Cache-Age', String(age));
                return res;
            }
        }
    }

    // Origin fetch
    const response = await next(request);

    // Apply cache headers
    const cacheHeaders = strategy.toHeaders({
        locale,
        currency,
        productId : url.searchParams.get('pid') || undefined,
        categoryId: url.searchParams.get('cgid') || undefined
    });

    const cachedResponse = new Response(response.body, {
        status : response.status,
        headers: { ...Object.fromEntries(response.headers), ...cacheHeaders, 'X-Cache-Date': String(Date.now()) }
    });

    // Store in edge cache
    if (opts.cache && response.ok && strategy._profile.sMaxAge > 0) {
        opts.ctx && opts.ctx.waitUntil(opts.cache.put(cacheKey, cachedResponse.clone()));
    }

    cachedResponse.headers.set('X-Cache', 'MISS');
    return cachedResponse;
}

async function revalidate(cacheKey, request, next, strategy, cache) {
    try {
        const fresh = await next(request);
        if (fresh.ok) { await cache.put(cacheKey, fresh); }
    } catch (e) {
        console.error('[EdgeCache] Revalidation failed:', e.message);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Detects the headless page type from a URL pathname.
 * @param  {string} pathname
 * @returns {string}
 */
function detectPageType(pathname) {
    if (pathname === '/' || pathname === '')     { return 'home'; }
    if (/\/product\/|\/p\//.test(pathname))      { return 'pdp'; }
    if (/\/search/.test(pathname))               { return 'search'; }
    if (/\/api\/product/.test(pathname))         { return 'api:product'; }
    if (/\/api\/search/.test(pathname))          { return 'api:search'; }
    if (/\/cart|\/checkout/.test(pathname))      { return 'api:cart'; }
    return 'plp';
}

/**
 * Builds a canonical cache key — strips non-canonical params, normalises locale.
 * @param  {URL}    url
 * @param  {string} locale
 * @param  {string} currency
 * @returns {string}
 */
function buildCacheKey(url, locale, currency) {
    const canonical = new URL(url.href);

    // Remove non-canonical params
    const nonCanonical = ['utm_source','utm_medium','utm_campaign','fbclid','gclid','srule','start'];
    nonCanonical.forEach(p => canonical.searchParams.delete(p));

    // Normalise
    canonical.searchParams.sort();

    return `${canonical.pathname}?${canonical.searchParams.toString()}|${locale}|${currency}`;
}

// ─── On-demand purge helpers ──────────────────────────────────────────────────

/**
 * Purge helpers for different edge platforms.
 * Call these from SFCC webhooks or custom hooks after catalog updates.
 */
export const PurgeMethods = {
    /**
     * Purges Vercel Edge Cache by tag.
     * Requires VERCEL_BYPASS_TOKEN env var.
     */
    async vercel(tags) {
        const token = process.env.VERCEL_BYPASS_TOKEN;
        if (!token) { throw new Error('VERCEL_BYPASS_TOKEN not set'); }

        const res = await fetch('https://api.vercel.com/v1/edge-cache/purge', {
            method : 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body   : JSON.stringify({ tags })
        });

        if (!res.ok) { throw new Error(`Vercel purge failed: ${res.status}`); }
        return res.json();
    },

    /**
     * Purges Cloudflare Cache by tag.
     */
    async cloudflare(tags, zoneId, apiToken) {
        const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
            method : 'POST',
            headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
            body   : JSON.stringify({ tags })
        });

        if (!res.ok) { throw new Error(`Cloudflare purge failed: ${res.status}`); }
        return res.json();
    },

    /**
     * Purges Fastly by surrogate key.
     */
    async fastly(surrogateKey, serviceId, apiKey) {
        const res = await fetch(`https://api.fastly.com/service/${serviceId}/purge/${encodeURIComponent(surrogateKey)}`, {
            method : 'POST',
            headers: { 'Fastly-Key': apiKey }
        });

        if (!res.ok) { throw new Error(`Fastly purge failed: ${res.status}`); }
        return res.json();
    }
};

export { EdgeCacheStrategy, CACHE_PROFILES, detectPageType, buildCacheKey };
