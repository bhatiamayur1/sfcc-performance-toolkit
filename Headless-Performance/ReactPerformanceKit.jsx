/**
 * ReactPerformanceKit.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /headless-performance/react-storefront
 *
 * React performance hooks and components for SFCC headless storefronts.
 * Targets the specific patterns that cause slowness in React + SFCC SCAPI:
 *
 *   1. useSFCCQuery        — SWR-powered data fetching with background refresh
 *   2. useIntersectionLoad — Replaces static lazy-loading with React-native approach
 *   3. ProductGridOptimizer — Windowed rendering for large product grids
 *   4. usePrefetchOnHover  — Pre-fetches PDP data when user hovers a tile
 *   5. useParallelData     — Parallel SCAPI calls with individual loading states
 *   6. MemoizedProductTile — Prevents unnecessary re-renders in product lists
 *   7. useImagePriority    — Correctly sets fetchpriority on the LCP image
 *
 * Requirements:
 *   npm install swr react-intersection-observer
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use client';

import React, {
    useState, useEffect, useRef, useCallback,
    useMemo, memo, Suspense
} from 'react';
import useSWR, { preload, mutate } from 'swr';
import { useInView } from 'react-intersection-observer';

// ─── 1. useSFCCQuery ──────────────────────────────────────────────────────────

/**
 * SWR-powered SFCC API hook with:
 *   - Automatic background revalidation
 *   - Stale-while-revalidate UX (no loading flash on revisit)
 *   - Error boundary integration
 *   - Deduplicated requests (multiple components, one network call)
 *
 * @param {string|null}  key       - Cache key (usually the API URL)
 * @param {Function}     fetcher   - Async function that fetches data
 * @param {Object}       [options]
 * @param {number}       [options.revalidateMs]   - How often to recheck (ms)
 * @param {boolean}      [options.revalidateOnFocus] - Refresh when tab regains focus
 * @param {any}          [options.fallbackData]   - Data shown while loading
 * @returns {{ data, error, isLoading, isValidating, mutate }}
 *
 * @example
 * const { data: product, isLoading } = useSFCCQuery(
 *   `/api/product/${pid}`,
 *   () => optimizer.getProduct(pid, { view: 'product-detail' }),
 *   { revalidateMs: 5 * 60 * 1000 }
 * )
 */
export function useSFCCQuery(key, fetcher, options = {}) {
    return useSWR(key, fetcher, {
        revalidateOnFocus         : options.revalidateOnFocus ?? false,
        revalidateOnReconnect     : options.revalidateOnReconnect ?? true,
        revalidateIfStale         : options.revalidateIfStale ?? true,
        dedupingInterval          : options.dedupingInterval ?? 5000,   // 5s dedup window
        focusThrottleInterval     : options.focusThrottleInterval ?? 10000,
        refreshInterval           : options.revalidateMs ?? 0,
        fallbackData              : options.fallbackData,
        suspense                  : options.suspense ?? false,
        keepPreviousData          : options.keepPreviousData ?? true,    // No layout flash on page change
        onError: (err) => {
            if (options.onError) { options.onError(err); }
            console.error(`[useSFCCQuery] ${key}:`, err.message);
        }
    });
}

// ─── 2. useIntersectionLoad ───────────────────────────────────────────────────

/**
 * Defers data fetching until the component enters the viewport.
 * Prevents off-screen API calls on long product listing pages.
 *
 * @param {Function}  fetchFn      - Data fetch function (only called when in view)
 * @param {string}    cacheKey     - SWR cache key
 * @param {Object}    [opts]
 * @param {string}    [opts.rootMargin]  - Intersection margin (default: '200px')
 * @returns {{ ref, data, isLoading, isVisible }}
 *
 * @example
 * function ProductRecommendations({ pid }) {
 *   const { ref, data, isLoading } = useIntersectionLoad(
 *     () => optimizer.getRecommendations(pid),
 *     `/api/recommendations/${pid}`
 *   )
 *   return <div ref={ref}>{isLoading ? <Skeleton /> : <RecommendList data={data} />}</div>
 * }
 */
export function useIntersectionLoad(fetchFn, cacheKey, opts = {}) {
    const [shouldFetch, setShouldFetch] = useState(false);

    const { ref, inView } = useInView({
        threshold  : 0,
        rootMargin : opts.rootMargin || '200px 0px',
        triggerOnce: true   // Only trigger once — keep the data after scroll away
    });

    useEffect(() => {
        if (inView && !shouldFetch) { setShouldFetch(true); }
    }, [inView, shouldFetch]);

    const { data, error, isLoading } = useSWR(
        shouldFetch ? cacheKey : null,   // null key = don't fetch
        fetchFn,
        { keepPreviousData: true }
    );

    return { ref, data, error, isLoading: shouldFetch && isLoading, isVisible: inView };
}

// ─── 3. usePrefetchOnHover ────────────────────────────────────────────────────

/**
 * Pre-fetches PDP data when the user hovers a product tile for > 150ms.
 * By the time they click, data is already in the SWR cache — PDP feels instant.
 *
 * @param {string}    productId
 * @param {Function}  fetchFn    - Fetcher that returns the product data
 * @param {string}    cacheKey
 * @returns {{ hoverHandlers }}  - Spread onto the product tile element
 *
 * @example
 * function ProductTile({ product }) {
 *   const { hoverHandlers } = usePrefetchOnHover(
 *     product.id,
 *     () => optimizer.getProduct(product.id, { view: 'product-detail' }),
 *     `/api/product/${product.id}/detail`
 *   )
 *   return <div {...hoverHandlers}><img src={product.image} /></div>
 * }
 */
export function usePrefetchOnHover(productId, fetchFn, cacheKey) {
    const timerRef    = useRef(null);
    const prefetched  = useRef(false);

    const handleMouseEnter = useCallback(() => {
        if (prefetched.current) { return; }
        timerRef.current = setTimeout(() => {
            preload(cacheKey, fetchFn);
            prefetched.current = true;
        }, 150);
    }, [cacheKey, fetchFn]);

    const handleMouseLeave = useCallback(() => {
        clearTimeout(timerRef.current);
    }, []);

    // Also prefetch on touch start (mobile tap-and-hold)
    const handleTouchStart = useCallback(() => {
        if (!prefetched.current) {
            preload(cacheKey, fetchFn);
            prefetched.current = true;
        }
    }, [cacheKey, fetchFn]);

    useEffect(() => () => clearTimeout(timerRef.current), []);

    return {
        hoverHandlers: {
            onMouseEnter: handleMouseEnter,
            onMouseLeave: handleMouseLeave,
            onTouchStart: handleTouchStart
        }
    };
}

// ─── 4. useParallelData ────────────────────────────────────────────────────────

/**
 * Fetches multiple SFCC resources in parallel, returning individual
 * loading states so the UI can render as each piece becomes available
 * (progressive enhancement rather than "all or nothing" loading).
 *
 * @param {Array<{ key: string, fetcher: Function, options?: Object }>} queries
 * @returns {Object[]}  Array of { data, error, isLoading } matching queries order
 *
 * @example
 * const [product, pricing, inventory] = useParallelData([
 *   { key: `/api/product/${pid}`,   fetcher: () => optimizer.getProduct(pid) },
 *   { key: `/api/prices/${pid}`,    fetcher: () => optimizer.getPrices([pid]) },
 *   { key: `/api/inventory/${pid}`, fetcher: () => optimizer.getInventory([pid]) }
 * ])
 * // Product renders first, pricing and inventory fill in as they arrive
 */
export function useParallelData(queries) {
    return queries.map(q => useSFCCQuery(q.key, q.fetcher, q.options || {}));
}

// ─── 5. MemoizedProductTile ───────────────────────────────────────────────────

/**
 * A memoized product tile that only re-renders when the product ID or
 * selected variant changes — prevents the entire product grid from
 * re-rendering on cart updates, filter changes, or hover states.
 *
 * @param {Object} props
 * @param {Object} props.product         - Product data from SCAPI
 * @param {Object} [props.pricing]       - Optional separate pricing data
 * @param {Object} [props.inventory]     - Optional separate inventory data
 * @param {boolean}[props.isPriority]    - First product in LCP position
 * @param {Function}[props.onAddToCart]
 */
export const MemoizedProductTile = memo(function ProductTile({
    product,
    pricing,
    inventory,
    isPriority = false,
    onAddToCart
}) {
    const [isWishlisted, setIsWishlisted] = useState(false);

    // Derive display values with useMemo to avoid recalculation on unrelated renders
    const displayData = useMemo(() => {
        const image      = product.imageGroups?.find(g => g.viewType === 'small')?.images?.[0];
        const isInStock  = inventory?.stockLevel > 0 ?? product.inventory?.ats > 0;
        const salePrice  = pricing?.salePrice || product.price?.sales?.value;
        const listPrice  = pricing?.listPrice  || product.price?.list?.value;
        const isOnSale   = salePrice && listPrice && salePrice < listPrice;
        const currency   = product.currency || 'GBP';

        return { image, isInStock, salePrice, listPrice, isOnSale, currency };
    }, [product.id, pricing, inventory]);

    // Prefetch full PDP data on hover
    const { hoverHandlers } = usePrefetchOnHover(
        product.id,
        () => fetch(`/api/product/${product.id}?view=product-detail`).then(r => r.json()),
        `/api/product/${product.id}/detail`
    );

    return (
        <article {...hoverHandlers} style={{ position: 'relative' }}>
            {/* Image — fetchpriority="high" for the first tile (LCP candidate) */}
            {displayData.image && (
                <img
                    src={displayData.image.link}
                    alt={displayData.image.alt || product.name}
                    width={400}
                    height={533}
                    loading={isPriority ? 'eager' : 'lazy'}
                    fetchPriority={isPriority ? 'high' : 'low'}
                    decoding="async"
                    srcSet={buildDISSrcSet(displayData.image.link)}
                    sizes="(max-width: 544px) 50vw, (max-width: 992px) 33vw, 25vw"
                />
            )}

            {/* Sale badge */}
            {displayData.isOnSale && (
                <span aria-label="Sale">SALE</span>
            )}

            <div>
                <h3>{product.name}</h3>

                {/* Price — renders separately if pricing data arrives later */}
                <div aria-live="polite">
                    {displayData.salePrice
                        ? <>
                            <span aria-label="Sale price">
                                {formatPrice(displayData.salePrice, displayData.currency)}
                            </span>
                            {displayData.isOnSale && (
                                <s aria-label="Original price">
                                    {formatPrice(displayData.listPrice, displayData.currency)}
                                </s>
                            )}
                          </>
                        : <span>Loading price…</span>
                    }
                </div>

                {/* Inventory — live region for screen readers */}
                {!displayData.isInStock && inventory && (
                    <p role="status">Out of stock</p>
                )}
            </div>
        </article>
    );
}, (prev, next) =>
    // Custom comparison — only re-render on meaningful changes
    prev.product.id   === next.product.id   &&
    prev.isPriority   === next.isPriority   &&
    prev.pricing      === next.pricing      &&
    prev.inventory    === next.inventory
);

// ─── 6. useImagePriority ──────────────────────────────────────────────────────

/**
 * Determines which product tile image should be treated as the LCP candidate
 * and marked with fetchPriority="high". Only the first visible tile qualifies.
 *
 * @param {number} index         - Position in the product grid (0-based)
 * @param {number} [cols=4]      - Number of columns in the grid
 * @param {number} [aboveFold=2] - Number of rows visible above the fold
 * @returns {boolean}
 */
export function useImagePriority(index, cols = 4, aboveFold = 2) {
    return index < cols * aboveFold;
}

// ─── 7. ProductGridOptimizer (virtualised list) ────────────────────────────────

/**
 * Virtualized product grid using intersection observers.
 * Renders only the visible rows + a configurable buffer, preventing DOM
 * bloat on large catalog pages (200+ products) that cause slow FID.
 *
 * This is a simplified implementation — for production, consider
 * @tanstack/react-virtual or react-window.
 *
 * @param {Object} props
 * @param {Object[]} props.products   - Product data array
 * @param {number}   props.columns    - Grid columns (default: 4)
 * @param {number}   props.rowHeight  - Estimated row height in px (default: 400)
 * @param {Function} props.renderItem - (product, index) => React element
 */
export function ProductGridOptimizer({ products, columns = 4, rowHeight = 400, renderItem }) {
    const [visibleRange, setVisibleRange] = useState({ start: 0, end: 20 });
    const containerRef = useRef(null);

    const rows      = Math.ceil(products.length / columns);
    const totalPx   = rows * rowHeight;
    const bufferRows = 2;  // Extra rows to pre-render above and below

    useEffect(() => {
        if (!containerRef.current) { return; }

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) { return; }
                    const rowIdx  = parseInt(entry.target.dataset.row, 10);
                    const newStart = Math.max(0, (rowIdx - bufferRows) * columns);
                    const newEnd   = Math.min(products.length, (rowIdx + bufferRows + 1) * columns);
                    setVisibleRange({ start: newStart, end: newEnd });
                });
            },
            { rootMargin: `${rowHeight * bufferRows}px 0px` }
        );

        containerRef.current.querySelectorAll('[data-row]').forEach(el => observer.observe(el));
        return () => observer.disconnect();
    }, [products.length, columns, rowHeight, bufferRows]);

    return (
        <div ref={containerRef} style={{ position: 'relative', height: totalPx }}>
            {Array.from({ length: rows }).map((_, rowIdx) => {
                const rowStart = rowIdx * columns;
                const rowEnd   = Math.min(rowStart + columns, products.length);
                const rowItems = products.slice(rowStart, rowEnd);

                // Sentinel div for each row — intersection triggers range update
                return (
                    <div
                        key={rowIdx}
                        data-row={rowIdx}
                        style={{ position: 'absolute', top: rowIdx * rowHeight, width: '100%' }}
                    >
                        {rowStart >= visibleRange.start && rowEnd <= visibleRange.end
                            ? rowItems.map((product, i) =>
                                renderItem(product, rowStart + i)
                              )
                            : <div style={{ height: rowHeight }} aria-hidden="true" />
                        }
                    </div>
                );
            })}
        </div>
    );
}

// ─── Utility: DIS srcset builder ──────────────────────────────────────────────

function buildDISSrcSet(baseURL) {
    if (!baseURL) { return undefined; }
    const widths = [200, 400, 600, 800];
    return widths
        .map(w => `${baseURL}?sw=${w}&q=75&fmt=webp ${w}w`)
        .join(', ');
}

function formatPrice(amount, currency) {
    if (amount == null) { return ''; }
    try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
    } catch {
        return `${currency} ${amount.toFixed(2)}`;
    }
}
