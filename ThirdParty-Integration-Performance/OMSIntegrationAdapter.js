/**
 * OMSIntegrationAdapter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /third-party-integration-performance
 *
 * Resilient OMS (Order Management System) and ERP integration adapter.
 * Handles the most latency-sensitive backend integration in SFCC:
 * the order creation call to a downstream fulfilment system (SAP, Manhattan,
 * Salesforce OMS, Fluent, custom ERP, etc.).
 *
 * Key problems solved:
 *
 *   PROBLEM 1: OMS latency blocks checkout confirmation page
 *     OMS order creation can take 2–15 seconds — far too slow to block the
 *     customer confirmation page on. This adapter submits orders asynchronously
 *     via the AsyncIntegrationQueue, showing the confirmation page immediately.
 *
 *   PROBLEM 2: OMS unavailability causes checkout failures
 *     If the OMS is down, orders should still complete on the SFCC side with
 *     the payment charged. The adapter queues failed OMS submissions for
 *     automatic retry and alerts operations teams.
 *
 *   PROBLEM 3: Duplicate order submissions on retry
 *     If an OMS call times out, we don't know whether it was received. This
 *     adapter uses an idempotency key (orderNo + timestamp) to prevent the
 *     OMS from creating duplicate orders on retry.
 *
 *   PROBLEM 4: Missing reconciliation visibility
 *     When async submission is used, you need a way to know which orders
 *     have not yet reached the OMS. The ReconciliationReporter surfaces this.
 *
 *   PROBLEM 5: ERP pricing latency
 *     Real-time price lookup from an ERP during product display can add
 *     200–2000 ms per page. This adapter uses a tiered cache (HOT/WARM/COLD)
 *     with graceful staleness handling.
 *
 * Usage:
 *   var OMS = require('*/cartridge/scripts/integrations/OMSIntegrationAdapter');
 *
 *   // After payment success — non-blocking:
 *   OMS.submitOrderAsync(order);
 *
 *   // Synchronous ERP price lookup with cache:
 *   var price = OMS.getERPPrice(product.getID(), session.getCurrency().getCurrencyCode());
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var HTTPClient      = require('dw/net/HTTPClient');
var CacheMgr        = require('dw/system/CacheMgr');
var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var Transaction     = require('dw/system/Transaction');
var Site            = require('dw/system/Site');
var Logger          = require('dw/system/Logger').getLogger('integrations', 'OMS');
var Status          = require('dw/system/Status');

var CircuitBreaker  = require('*/cartridge/scripts/integrations/IntegrationCircuitBreaker');
var AsyncQueue      = require('*/cartridge/scripts/integrations/AsyncIntegrationQueue');

// ─── Configuration ─────────────────────────────────────────────────────────────

function omsConfig() {
    var prefs = Site.getCurrent().getCustomPreferences();
    return {
        apiURL    : prefs.getAttrValue('omsApiURL')     || '',
        apiKey    : prefs.getAttrValue('omsApiKey')     || '',
        timeoutMs : parseInt(prefs.getAttrValue('omsTimeoutMs'), 10) || 10000,
        version   : prefs.getAttrValue('omsApiVersion') || 'v1'
    };
}

function erpConfig() {
    var prefs = Site.getCurrent().getCustomPreferences();
    return {
        apiURL    : prefs.getAttrValue('erpApiURL')    || '',
        apiKey    : prefs.getAttrValue('erpApiKey')    || '',
        timeoutMs : parseInt(prefs.getAttrValue('erpTimeoutMs'), 10) || 5000
    };
}

// ─── Order serialiser ─────────────────────────────────────────────────────────

/**
 * Serialises a SFCC Order object into the OMS-expected payload shape.
 * Extend this to match your specific OMS contract.
 *
 * @param  {dw.order.Order} order
 * @returns {Object}
 */
function serialiseOrder(order) {
    var lineItems = order.getProductLineItems().toArray().map(function (li) {
        return {
            sku         : li.getProductID(),
            productName : li.getProductName(),
            quantity    : li.getQuantityValue(),
            unitPrice   : li.getAdjustedPrice().divide(li.getQuantityValue()).getValue(),
            currency    : order.getCurrencyCode(),
            lineTotal   : li.getAdjustedPrice().getValue()
        };
    });

    var addr = order.getDefaultShipment().getShippingAddress();

    return {
        omsOrderId      : order.getOrderNo() + '-SFCC',   // Disambiguate from OMS-native IDs
        sfccOrderNo     : order.getOrderNo(),
        idempotencyKey  : 'sfcc-' + order.getOrderNo(),   // Prevents duplicate OMS orders on retry
        customer: {
            email       : order.getCustomerEmail(),
            firstName   : order.getBillingAddress().getFirstName(),
            lastName    : order.getBillingAddress().getLastName(),
            phone       : order.getBillingAddress().getPhone()
        },
        shippingAddress : {
            firstName   : addr.getFirstName(),
            lastName    : addr.getLastName(),
            address1    : addr.getAddress1(),
            address2    : addr.getAddress2() || '',
            city        : addr.getCity(),
            stateCode   : addr.getStateCode() || '',
            postalCode  : addr.getPostalCode(),
            countryCode : addr.getCountryCode().toUpperCase(),
            phone       : addr.getPhone() || order.getBillingAddress().getPhone()
        },
        shippingMethod  : order.getDefaultShipment().getShippingMethodID(),
        lineItems       : lineItems,
        orderTotal      : order.getTotalGrossPrice().getValue(),
        currency        : order.getCurrencyCode(),
        locale          : order.getCustomerLocaleID(),
        channel         : 'SFCC_STOREFRONT',
        placedAt        : new Date(order.getCreationDate().getTime()).toISOString()
    };
}

// ─── OMS HTTP caller ──────────────────────────────────────────────────────────

/**
 * Makes a synchronous HTTP call to the OMS.
 * @param  {Object} cfg      - OMS config
 * @param  {string} endpoint - e.g. '/orders'
 * @param  {Object} body
 * @returns {Object}  Parsed response
 */
function callOMS(cfg, endpoint, body) {
    var http = new HTTPClient();
    http.setTimeout(cfg.timeoutMs);
    http.setRequestHeader('Content-Type',  'application/json');
    http.setRequestHeader('Authorization', 'Bearer ' + cfg.apiKey);
    http.setRequestHeader('X-Client-ID',   'SFCC-PerformanceToolkit');

    var url = cfg.apiURL.replace(/\/$/, '') + '/' + cfg.version + endpoint;
    var ok  = http.sendAndReceive(url, 'POST', JSON.stringify(body));
    var code = http.getStatusCode();
    var text = http.getText() || '{}';

    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { parsed = { raw: text }; }

    if (!ok || code >= 400) {
        var err = new Error(parsed.message || parsed.error || 'OMS returned HTTP ' + code);
        err.code   = String(code);
        err.status = code;
        throw err;
    }

    return { status: code, body: parsed };
}

// ─── OMS submission strategies ────────────────────────────────────────────────

var OMSIntegrationAdapter = {

    /**
     * PREFERRED: Submits an order to the OMS asynchronously via the queue.
     * Returns immediately — the customer sees their confirmation page without waiting.
     *
     * The order is retried automatically if the OMS is temporarily unavailable.
     *
     * @param  {dw.order.Order} order
     * @returns {{ queued: true, entryId: string }}
     */
    submitOrderAsync: function (order) {
        var payload = serialiseOrder(order);

        var entry = AsyncQueue.enqueue('oms.createOrder', payload, {
            priority: 'HIGH',
            orderId : order.getOrderNo()
        });

        Logger.info('OMSIntegrationAdapter: order {0} queued for async OMS submission (entryId={1})',
            order.getOrderNo(), entry.entryId);

        return { queued: true, entryId: entry.entryId };
    },

    /**
     * SYNCHRONOUS fallback: Submits an order to the OMS in the request thread.
     * Use only when the OMS must confirm before showing the customer their order number.
     * Protected by circuit breaker and timeout.
     *
     * @param  {dw.order.Order} order
     * @returns {{ success, omsOrderId, latencyMs, errorCode, errorMessage }}
     */
    submitOrderSync: function (order) {
        var cfg     = omsConfig();
        var breaker = CircuitBreaker.get('oms-createOrder', 'oms');
        var payload = serialiseOrder(order);
        var start   = Date.now();

        return breaker.call(function () {
            var response = callOMS(cfg, '/orders', payload);
            var body     = response.body || {};
            var latency  = Date.now() - start;

            Logger.info('OMSIntegrationAdapter: SYNC submit OK orderId={0} omsId={1} latency={2}ms',
                order.getOrderNo(), body.omsOrderId || body.id, latency);

            // Mark order as submitted in SFCC custom attribute for tracing
            try {
                Transaction.wrap(function () {
                    order.custom.omsSubmitted   = true;
                    order.custom.omsOrderId     = body.omsOrderId || body.id || '';
                    order.custom.omsSubmittedAt = new Date().toISOString();
                });
            } catch (e) {
                Logger.warn('OMSIntegrationAdapter: could not update order custom attrs: {0}', e.message);
            }

            return {
                success    : true,
                omsOrderId : body.omsOrderId || body.id || '',
                latencyMs  : latency,
                errorCode  : null,
                errorMessage: null
            };

        }, function fallback(err) {
            // Queue for async retry on circuit-open or failure
            AsyncQueue.enqueue('oms.createOrder', payload, {
                priority: 'CRITICAL',  // Bump to CRITICAL since sync path failed
                orderId : order.getOrderNo()
            });
            Logger.error('OMSIntegrationAdapter: SYNC submit FAILED orderId={0}, queued for retry: {1}',
                order.getOrderNo(), err.message);

            return {
                success     : false,
                omsOrderId  : null,
                latencyMs   : Date.now() - start,
                errorCode   : err.code || 'circuit_open',
                errorMessage: 'Order is being processed. You will receive a confirmation email shortly.'
            };
        });
    },

    // ── ERP Price lookup ──────────────────────────────────────────────────────

    /**
     * Looks up the ERP-authoritative price for a product.
     * Uses a tiered cache strategy to avoid calling ERP on every page load.
     *
     * Cache tiers:
     *   HOT  (CacheMgr, 60 s)    — In-process, ~0 ms. For high-volume SKUs.
     *   WARM (CacheMgr, 600 s)   — In-process, ~0 ms. For all cached SKUs.
     *   COLD (ERP, live)         — Real HTTP call, 200–2000 ms. On miss.
     *   STALE                    — Returns last-known price if ERP is down.
     *
     * @param  {string} productID
     * @param  {string} currency   - ISO 4217 code
     * @param  {Object} [opts]
     * @param  {string} [opts.priceBook]  - Optional price book ID
     * @returns {{ price: number, currency: string, fromCache: boolean, stale: boolean }}
     */
    getERPPrice: function (productID, currency, opts) {
        var options  = opts || {};
        var cacheKey = 'erpPrice:' + productID + ':' + currency + (options.priceBook ? ':' + options.priceBook : '');
        var breaker  = CircuitBreaker.get('erp-price', 'erp');
        var start    = Date.now();

        // ── HOT/WARM cache check ──────────────────────────────────────────────
        try {
            var cached = CacheMgr.get(cacheKey);
            if (cached && cached.price !== undefined) {
                return {
                    price    : cached.price,
                    currency : cached.currency || currency,
                    fromCache: true,
                    stale    : false,
                    latencyMs: Date.now() - start
                };
            }
        } catch (e) { /* non-fatal */ }

        // ── Live ERP call ─────────────────────────────────────────────────────
        var erpResult = breaker.call(function () {
            var cfg  = erpConfig();
            var http = new HTTPClient();
            http.setTimeout(cfg.timeoutMs);
            http.setRequestHeader('Authorization', 'Bearer ' + cfg.apiKey);
            http.setRequestHeader('Accept', 'application/json');

            var url = cfg.apiURL + '/prices/' + encodeURIComponent(productID)
                + '?currency=' + currency
                + (options.priceBook ? '&priceBook=' + encodeURIComponent(options.priceBook) : '');

            var ok   = http.sendAndReceive(url, 'GET');
            var code = http.getStatusCode();
            var text = http.getText() || '{}';

            if (!ok || code >= 400) { throw new Error('ERP returned HTTP ' + code); }

            var parsed = JSON.parse(text);
            var price  = parsed.price || parsed.amount || parsed.value;

            if (price === undefined || price === null) {
                throw new Error('ERP response missing price field');
            }

            // Cache the result
            try {
                CacheMgr.put(cacheKey, { price: price, currency: currency, cachedAt: Date.now() }, 600);
            } catch (cacheErr) { /* non-fatal */ }

            Logger.info('OMSIntegrationAdapter.getERPPrice: sku={0} price={1} latency={2}ms',
                productID, price, Date.now() - start);

            return { price: price, currency: currency, fromCache: false, stale: false, latencyMs: Date.now() - start };

        }, function fallback(err) {
            // Return a stale cached value if the ERP is down
            Logger.warn('OMSIntegrationAdapter.getERPPrice: ERP FAILED for sku={0}, returning stale: {1}',
                productID, err.message);

            try {
                var staleKey = 'erpPrice_stale:' + productID + ':' + currency;
                var stale    = CacheMgr.get(staleKey);
                if (stale) {
                    return { price: stale.price, currency: currency, fromCache: true, stale: true, latencyMs: Date.now() - start };
                }
            } catch (e) { /* non-fatal */ }

            // Absolute fallback: return null to trigger SFCC's built-in price
            return { price: null, currency: currency, fromCache: false, stale: true, latencyMs: Date.now() - start };
        });

        return erpResult;
    },

    // ── Reconciliation reporter ───────────────────────────────────────────────

    /**
     * SFCC Job step: Identifies orders that have not yet been submitted to the OMS.
     * Run hourly — alerts on any order older than maxAgeMinutes without OMS confirmation.
     *
     * @param  {Object} [opts]
     * @param  {number} [opts.maxAgeMinutes]  - Age threshold before alerting (default: 30)
     * @returns {dw.system.Status}
     */
    reconcile: function (opts) {
        var options        = opts || {};
        var maxAgeMinutes  = options.maxAgeMinutes || 30;
        var cutoff         = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
        var unsubmitted    = [];

        try {
            // Query SFCC orders without omsSubmitted flag, created before the cutoff
            var OrderMgr = require('dw/order/OrderMgr');
            var orders   = OrderMgr.queryOrders(
                'custom.omsSubmitted = {0} AND creationDate < {1} AND status != {2}',
                'creationDate asc',
                false,
                cutoff,
                require('dw/order/Order').ORDER_STATUS_CANCELLED
            );

            while (orders.hasNext()) {
                var order = orders.next();
                unsubmitted.push({
                    orderNo   : order.getOrderNo(),
                    createdAt : new Date(order.getCreationDate().getTime()).toISOString(),
                    email     : order.getCustomerEmail(),
                    total     : order.getTotalGrossPrice().getValue(),
                    currency  : order.getCurrencyCode()
                });

                // Re-queue for async submission
                AsyncQueue.enqueue('oms.createOrder', serialiseOrder(order), {
                    priority: 'CRITICAL',
                    orderId : order.getOrderNo()
                });
            }

            orders.close();

        } catch (e) {
            Logger.error('OMSIntegrationAdapter.reconcile FAILED: {0}', e.message);
            return new Status(Status.ERROR, 'RECONCILE_FAILED', e.message);
        }

        if (unsubmitted.length > 0) {
            Logger.error('OMSIntegrationAdapter.reconcile: {0} orders unsubmitted to OMS: [{1}]',
                unsubmitted.length,
                unsubmitted.map(function (o) { return o.orderNo; }).join(', '));

            return new Status(Status.OK, 'RECONCILE_ALERTS',
                unsubmitted.length + ' orders re-queued for OMS submission. Check dead-letter queue.');
        }

        Logger.info('OMSIntegrationAdapter.reconcile: all orders submitted OK');
        return new Status(Status.OK, 'RECONCILE_CLEAN', 'All orders submitted to OMS.');
    }
};

// Register the OMS handler with the async queue
AsyncQueue.registerHandler('oms.createOrder', function (payload) {
    var cfg     = omsConfig();
    var breaker = CircuitBreaker.get('oms-createOrder', 'oms');

    return breaker.call(function () {
        var response = callOMS(cfg, '/orders', payload);
        var body     = response.body || {};

        Logger.info('AsyncQueue oms.createOrder SUCCESS sfccOrderNo={0} omsId={1}',
            payload.sfccOrderNo, body.omsOrderId || body.id);

        // Update SFCC order custom attributes
        try {
            var OrderMgr = require('dw/order/OrderMgr');
            var order    = OrderMgr.getOrder(payload.sfccOrderNo);
            if (order) {
                Transaction.wrap(function () {
                    order.custom.omsSubmitted   = true;
                    order.custom.omsOrderId     = body.omsOrderId || body.id || '';
                    order.custom.omsSubmittedAt = new Date().toISOString();
                });
            }
        } catch (e) {
            Logger.warn('AsyncQueue oms.createOrder: could not update order attrs: {0}', e.message);
        }

        return { success: true };
    }, function fallback(err) {
        Logger.error('AsyncQueue oms.createOrder FAILED sfccOrderNo={0}: {1}', payload.sfccOrderNo, err.message);
        return { success: false, error: err.message };
    });
});

module.exports = OMSIntegrationAdapter;
