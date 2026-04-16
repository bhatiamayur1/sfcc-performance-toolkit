/**
 * PaymentLatencyHandler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /checkout-optimization
 *
 * Payment gateway calls are the single largest latency bottleneck in SFCC
 * checkout — typically 400–1800 ms per call. This module applies four
 * complementary strategies to make that latency invisible or recoverable:
 *
 *   1. PRECONNECT WARMUP
 *      Issues TCP+TLS preconnects to the payment gateway as soon as the
 *      payment step is visible — before the customer finishes typing their
 *      card number. Eliminates the ~200 ms connection setup from the critical
 *      path.
 *
 *   2. PAYMENT SCRIPT PRELOAD
 *      Preloads the payment provider's SDK (Stripe.js, Adyen, PayPal) as a
 *      high-priority script during the address/shipping step so it is fully
 *      parsed before the customer reaches payment.
 *
 *   3. OPTIMISTIC UI LOCK
 *      On "Place Order" click: immediately disables the button, shows a
 *      spinner, and locks the form — giving the user instant feedback and
 *      preventing double-submits. Unlocks automatically on error.
 *
 *   4. TIMEOUT + RETRY WRAPPER
 *      Wraps the Place Order AJAX call with a configurable timeout and
 *      exponential-backoff retry for transient gateway failures. On
 *      unrecoverable failure, surfaces a user-friendly message with a
 *      "Try again" CTA rather than a blank screen.
 *
 *   5. SERVER-SIDE: SFCC PaymentInstrument pre-validation
 *      A SFCC script helper that validates card BINs and checks for fraud
 *      signals BEFORE calling the payment gateway — avoiding gateway latency
 *      on known-invalid cards.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function (window, document) {
    'use strict';

    // ── Configuration ─────────────────────────────────────────────────────────

    var CONFIG = {
        /** Timeout for place-order AJAX call (ms) */
        placeOrderTimeout: 12000,

        /** Max retry attempts on transient failure */
        maxRetries: 2,

        /** Base delay for exponential backoff (ms) */
        retryBaseDelay: 800,

        /** HTTP status codes that are worth retrying */
        retryableStatuses: [429, 500, 502, 503, 504],

        /** Payment provider preconnect origins — add your gateway here */
        preconnectOrigins: [
            'https://js.stripe.com',
            'https://api.stripe.com',
            'https://www.paypal.com',
            'https://www.paypalobjects.com',
            'https://checkoutshopper-live.adyen.com',
            'https://live.adyen.com'
        ],

        /** Selector for the Place Order button */
        placeOrderSelector: '.place-order, [data-action="placeOrder"], #dwfrm_billing button[type="submit"]',

        /** Selector for the payment form */
        paymentFormSelector: '#dwfrm_billing, .payment-form'
    };

    // ── 1. Preconnect warmup ──────────────────────────────────────────────────

    /**
     * Injects <link rel="preconnect"> tags for the payment gateway as soon
     * as the payment step accordion opens — before the user's hands reach
     * the card number field.
     *
     * @param {string[]} [origins]  - Override default preconnect origins
     */
    function warmupPreconnects(origins) {
        var targets = origins || CONFIG.preconnectOrigins;

        targets.forEach(function (origin) {
            // Skip if already preconnected
            if (document.querySelector('link[rel="preconnect"][href="' + origin + '"]')) { return; }

            var link = document.createElement('link');
            link.rel  = 'preconnect';
            link.href = origin;
            link.setAttribute('crossorigin', 'anonymous');
            document.head.appendChild(link);
        });

        console.info('[PaymentLatencyHandler] Preconnected to', targets.length, 'payment origins');
    }

    /**
     * Triggers preconnect warmup when the payment accordion step is activated.
     * Hooks into SFRA's stage change event.
     */
    function attachPaymentStepWarmup() {
        document.addEventListener('checkout:updateCheckoutView', function (e) {
            var stage = e.detail && e.detail.checkoutStage;
            if (stage === 'payment') {
                warmupPreconnects();
            }
        });

        // Also trigger if payment step is already visible on load
        var paymentStep = document.querySelector('#payment.active, #payment.checkout-step.active');
        if (paymentStep) {
            warmupPreconnects();
        }
    }

    // ── 2. Payment SDK preload ────────────────────────────────────────────────

    /**
     * Preloads the payment SDK script during the shipping step so it's
     * parsed and ready before the customer navigates to payment.
     *
     * @param {string} sdkURL     - URL to the payment provider's JS SDK
     * @param {string} [loadOnStage] - SFRA stage at which to trigger loading (default: 'shipping')
     */
    function preloadPaymentSDK(sdkURL, loadOnStage) {
        if (!sdkURL) { return; }
        var triggerStage = loadOnStage || 'shipping';

        function doPreload() {
            if (document.querySelector('script[src="' + sdkURL + '"]')) { return; }

            // Use <link rel="preload"> first to get the bytes downloading
            var preload     = document.createElement('link');
            preload.rel     = 'preload';
            preload.href    = sdkURL;
            preload.as      = 'script';
            document.head.appendChild(preload);

            // Then inject the actual <script> — the browser uses the preloaded bytes
            var script   = document.createElement('script');
            script.src   = sdkURL;
            script.async = true;
            document.head.appendChild(script);

            console.info('[PaymentLatencyHandler] Payment SDK preloaded:', sdkURL);
        }

        document.addEventListener('checkout:updateCheckoutView', function (e) {
            var stage = e.detail && e.detail.checkoutStage;
            if (stage === triggerStage) { doPreload(); }
        });
    }

    // ── 3. Optimistic UI lock ─────────────────────────────────────────────────

    /**
     * Spinner HTML injected inside the Place Order button during processing.
     */
    var SPINNER_HTML = [
        '<span class="payment-spinner" style="',
        'display:inline-block;width:16px;height:16px;',
        'border:2px solid currentColor;border-top-color:transparent;',
        'border-radius:50%;animation:spin .7s linear infinite;',
        'margin-right:8px;vertical-align:middle',
        '"></span>'
    ].join('');

    var _spinnerStyle = null;

    function injectSpinnerKeyframes() {
        if (_spinnerStyle) { return; }
        _spinnerStyle = document.createElement('style');
        _spinnerStyle.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
        document.head.appendChild(_spinnerStyle);
    }

    /**
     * Locks the Place Order button and payment form during processing.
     * Returns an unlock function to call on completion/error.
     *
     * @param {string} [processingText]  - Button label during processing
     * @returns {Function} unlock()
     */
    function lockPaymentUI(processingText) {
        injectSpinnerKeyframes();

        var btn  = document.querySelector(CONFIG.placeOrderSelector);
        var form = document.querySelector(CONFIG.paymentFormSelector);

        var originalText    = btn ? btn.innerHTML : '';
        var originalDisabled = btn ? btn.disabled : false;

        if (btn) {
            btn.disabled   = true;
            btn.innerHTML  = SPINNER_HTML + (processingText || 'Processing…');
            btn.setAttribute('aria-busy', 'true');
        }

        if (form) {
            form.querySelectorAll('input, select, button').forEach(function (el) {
                el.setAttribute('data-was-disabled', el.disabled ? '1' : '0');
                el.disabled = true;
            });
        }

        return function unlock(errorMessage) {
            if (btn) {
                btn.disabled  = originalDisabled;
                btn.innerHTML = originalText;
                btn.removeAttribute('aria-busy');
            }
            if (form) {
                form.querySelectorAll('[data-was-disabled]').forEach(function (el) {
                    el.disabled = el.getAttribute('data-was-disabled') === '1';
                    el.removeAttribute('data-was-disabled');
                });
            }
            if (errorMessage) {
                showPaymentError(errorMessage);
            }
        };
    }

    // ── 4. Timeout + retry wrapper ────────────────────────────────────────────

    /**
     * Wraps the Place Order AJAX call with timeout + exponential backoff retry.
     *
     * @param {string}   url        - Place Order endpoint URL
     * @param {Object}   data       - Form data to POST
     * @param {Object}   [opts]
     * @param {number}   [opts.timeout]    - Override CONFIG.placeOrderTimeout
     * @param {number}   [opts.maxRetries] - Override CONFIG.maxRetries
     * @returns {Promise<Object>}
     */
    function placeOrderWithRetry(url, data, opts) {
        var options    = opts || {};
        var timeout    = options.timeout    || CONFIG.placeOrderTimeout;
        var maxRetries = options.maxRetries || CONFIG.maxRetries;
        var attempt    = 0;

        function attemptRequest() {
            attempt++;

            var controller = window.AbortController ? new AbortController() : null;
            var timer      = controller
                ? setTimeout(function () { controller.abort(); }, timeout)
                : null;

            var fetchOptions = {
                method : 'POST',
                headers: {
                    'Content-Type'     : 'application/x-www-form-urlencoded',
                    'X-Requested-With' : 'XMLHttpRequest'
                },
                body   : typeof data === 'string' ? data : new URLSearchParams(data).toString()
            };
            if (controller) { fetchOptions.signal = controller.signal; }

            return fetch(url, fetchOptions)
                .then(function (response) {
                    clearTimeout(timer);

                    if (!response.ok && CONFIG.retryableStatuses.indexOf(response.status) !== -1) {
                        throw Object.assign(new Error('Retryable HTTP error'), { status: response.status, retryable: true });
                    }

                    return response.json();
                })
                .catch(function (err) {
                    clearTimeout(timer);

                    var isTimeout  = err.name === 'AbortError';
                    var isRetryable = isTimeout || err.retryable;

                    if (isRetryable && attempt <= maxRetries) {
                        var delay = CONFIG.retryBaseDelay * Math.pow(2, attempt - 1);
                        console.warn('[PaymentLatencyHandler] Attempt', attempt, 'failed. Retrying in', delay, 'ms');
                        return new Promise(function (resolve) { setTimeout(resolve, delay); })
                            .then(function () { return attemptRequest(); });
                    }

                    throw err;
                });
        }

        return attemptRequest();
    }

    // ── Error display ─────────────────────────────────────────────────────────

    /**
     * Shows a user-friendly payment error with a "Try again" CTA.
     * @param {string} message
     */
    function showPaymentError(message) {
        var existing = document.getElementById('payment-error-banner');
        if (existing) { existing.remove(); }

        var banner = document.createElement('div');
        banner.id  = 'payment-error-banner';
        banner.setAttribute('role', 'alert');
        banner.style.cssText = [
            'padding:14px 16px',
            'margin:12px 0',
            'border:1px solid var(--color-border-danger)',
            'border-radius:8px',
            'background:var(--color-background-danger)',
            'color:var(--color-text-danger)',
            'font-size:14px',
            'display:flex',
            'align-items:flex-start',
            'gap:10px'
        ].join(';');

        banner.innerHTML = [
            '<span style="font-size:16px;flex-shrink:0">⚠</span>',
            '<span>',
            (message || 'Payment could not be processed. Please try again or use a different payment method.'),
            '</span>'
        ].join('');

        var placeOrderBtn = document.querySelector(CONFIG.placeOrderSelector);
        if (placeOrderBtn) {
            placeOrderBtn.insertAdjacentElement('beforebegin', banner);
            banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    // ── Intercept place-order submit ──────────────────────────────────────────

    /**
     * Intercepts the Place Order button click, applies the optimistic UI lock,
     * and wraps the AJAX call with timeout + retry logic.
     *
     * @param {string} placeOrderURL  - SFCC CheckoutServices-PlaceOrder endpoint
     */
    function interceptPlaceOrder(placeOrderURL) {
        document.addEventListener('click', function (e) {
            var btn = e.target && e.target.closest ? e.target.closest(CONFIG.placeOrderSelector) : null;
            if (!btn) { return; }

            e.preventDefault();
            e.stopImmediatePropagation();

            var unlock = lockPaymentUI('Placing your order…');
            var form   = document.querySelector(CONFIG.paymentFormSelector);
            var data   = form ? new URLSearchParams(new FormData(form)).toString() : '';

            placeOrderWithRetry(placeOrderURL || btn.form && btn.form.action || '/CheckoutServices-PlaceOrder', data)
                .then(function (result) {
                    if (result && result.error) {
                        unlock(result.errorMessage || 'Your payment was declined. Please check your details and try again.');
                    } else if (result && result.continueUrl) {
                        window.location.href = result.continueUrl;
                    } else {
                        unlock('Unexpected response. Please try again.');
                    }
                })
                .catch(function (err) {
                    console.error('[PaymentLatencyHandler] Place order failed:', err);
                    var msg = err.name === 'AbortError'
                        ? 'The request timed out. Please check your connection and try again.'
                        : 'Something went wrong. Please try again or contact support.';
                    unlock(msg);
                });
        }, true);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    var PaymentLatencyHandler = {

        /**
         * Initialise all payment latency strategies.
         *
         * @param {Object} opts
         * @param {string} [opts.placeOrderURL]   - Place order endpoint
         * @param {string} [opts.paymentSDKURL]   - Payment provider SDK URL
         * @param {string[]} [opts.preconnectOrigins] - Override preconnect targets
         */
        init: function (opts) {
            var options = opts || {};

            if (options.preconnectOrigins) {
                CONFIG.preconnectOrigins = options.preconnectOrigins;
            }

            attachPaymentStepWarmup();

            if (options.paymentSDKURL) {
                preloadPaymentSDK(options.paymentSDKURL);
            }

            interceptPlaceOrder(options.placeOrderURL);

            console.info('[PaymentLatencyHandler] Initialised');
        },

        warmupPreconnects    : warmupPreconnects,
        preloadPaymentSDK    : preloadPaymentSDK,
        lockPaymentUI        : lockPaymentUI,
        placeOrderWithRetry  : placeOrderWithRetry,
        showPaymentError     : showPaymentError,
        CONFIG               : CONFIG
    };

    window.PaymentLatencyHandler = PaymentLatencyHandler;

}(window, document));
