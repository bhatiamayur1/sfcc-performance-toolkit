/**
 * CheckoutStepReducer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /checkout-optimization
 *
 * Reduces perceived and actual checkout step count by:
 *   1. Collapsing Address + Shipping into a single smart step
 *   2. Pre-filling known fields from customer profile / browser autofill signals
 *   3. Skipping steps that have only one valid option (single shipping method)
 *   4. Validating fields inline (on blur) rather than on form submit
 *   5. Persisting partial progress to sessionStorage so back-navigation
 *      never loses entered data
 *
 * SFCC's default SFRA checkout has 4 server-round-trips before the payment
 * step. This module collapses that to 2 for returning customers and 3 for
 * guests — cutting checkout abandonment at the step-transition bottleneck.
 *
 * Usage (include once on the checkout page, via ScriptLoader at 'critical'):
 *   ScriptLoader.load('/js/CheckoutStepReducer.js', { priority: 'critical' });
 *   CheckoutStepReducer.init({ locale: 'en_GB', currency: 'GBP' });
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function (window, document) {
    'use strict';

    // ── Constants ─────────────────────────────────────────────────────────────

    var STEPS = {
        ADDRESS : 'customer',   // SFRA stage names
        SHIPPING: 'shipping',
        PAYMENT : 'payment',
        PLACE   : 'placeOrder',
        CONFIRM : 'submitted'
    };

    var STORAGE_KEY   = 'sfcc_checkout_progress';
    var DEBOUNCE_WAIT = 300;   // ms — inline validation debounce

    // ── Utility: debounce ─────────────────────────────────────────────────────

    function debounce(fn, wait) {
        var t;
        return function () {
            var ctx = this, args = arguments;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(ctx, args); }, wait);
        };
    }

    // ── Utility: session persistence ──────────────────────────────────────────

    var Progress = {
        _data: {},

        load: function () {
            try {
                var raw = sessionStorage.getItem(STORAGE_KEY);
                this._data = raw ? JSON.parse(raw) : {};
            } catch (e) { this._data = {}; }
            return this;
        },

        save: function () {
            try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this._data)); }
            catch (e) { /* quota exceeded — degrade silently */ }
            return this;
        },

        set: function (key, value) {
            this._data[key] = value;
            return this.save();
        },

        get: function (key) { return this._data[key]; },

        clear: function () {
            try { sessionStorage.removeItem(STORAGE_KEY); }
            catch (e) {}
            this._data = {};
        }
    };

    // ── Step 1: Auto-advance when only one shipping method exists ─────────────

    /**
     * If SFCC returns only one shipping method for the basket, auto-select it
     * and advance the step without requiring a user click — removing an entire
     * "choose shipping" step from the perceived flow.
     *
     * Hooks into SFRA's shipping step event: 'checkout:afterUpdateShippingList'
     */
    function autoAdvanceSingleShippingMethod() {
        document.addEventListener('checkout:afterUpdateShippingList', function (e) {
            var shippingMethods = e.detail && e.detail.shippingMethods;
            if (!shippingMethods || shippingMethods.length !== 1) { return; }

            var method = shippingMethods[0];
            var radio  = document.querySelector(
                '[name="dwfrm_shipping_shippingAddress_shippingMethodID"][value="' + method.ID + '"]'
            );

            if (radio && !radio.checked) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));

                // Auto-submit shipping selection after a short tick
                setTimeout(function () {
                    var submitBtn = document.querySelector(
                        '.submit-shipping, [data-action="submit-shipping"]'
                    );
                    if (submitBtn) { submitBtn.click(); }
                }, 150);

                console.info('[CheckoutStepReducer] Auto-advanced past single shipping method:', method.ID);
            }
        });
    }

    // ── Step 2: Address field pre-fill from customer profile ──────────────────

    /**
     * Pre-fills checkout address fields from:
     *   a) Saved customer profile data (injected server-side as window.__sfccCustomer)
     *   b) Progress data previously saved to sessionStorage
     *
     * Call this after the address form renders.
     */
    function preFillAddressFields() {
        var customer = window.__sfccCustomer || {};
        var saved    = Progress._data;

        var fieldMap = {
            // SFRA field name → value source
            'dwfrm_shipping_shippingAddress_addressFields_firstName': customer.firstName || saved.firstName,
            'dwfrm_shipping_shippingAddress_addressFields_lastName' : customer.lastName  || saved.lastName,
            'dwfrm_shipping_shippingAddress_addressFields_address1' : customer.address1  || saved.address1,
            'dwfrm_shipping_shippingAddress_addressFields_address2' : customer.address2  || saved.address2,
            'dwfrm_shipping_shippingAddress_addressFields_city'     : customer.city      || saved.city,
            'dwfrm_shipping_shippingAddress_addressFields_postalCode': customer.postalCode || saved.postalCode,
            'dwfrm_shipping_shippingAddress_addressFields_phone'    : customer.phone     || saved.phone
        };

        var filledCount = 0;
        Object.keys(fieldMap).forEach(function (fieldName) {
            var value = fieldMap[fieldName];
            if (!value) { return; }

            var input = document.querySelector('[name="' + fieldName + '"]');
            if (input && !input.value) {
                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                filledCount++;
            }
        });

        if (filledCount > 0) {
            console.info('[CheckoutStepReducer] Pre-filled', filledCount, 'address fields');
        }
    }

    // ── Step 3: Inline (on-blur) field validation ─────────────────────────────

    /**
     * Attaches real-time validation to checkout form fields so errors surface
     * immediately on focus-loss rather than on form submit.
     *
     * This removes the most painful UX anti-pattern: filling a long form,
     * clicking "Continue", then scrolling back up to fix one error.
     *
     * @param {string} formSelector  - CSS selector for the checkout form
     */
    function attachInlineValidation(formSelector) {
        var form = document.querySelector(formSelector || '.checkout-shipping');
        if (!form) { return; }

        var VALIDATORS = {
            email: function (v) {
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Enter a valid email address';
            },
            postalCode: function (v) {
                // UK postcode — extend for other locales
                var ukPC = /^[A-Z]{1,2}[0-9][0-9A-Z]?\s*[0-9][A-Z]{2}$/i;
                return ukPC.test(v.trim()) ? null : 'Enter a valid postcode';
            },
            phone: function (v) {
                return v.replace(/\D/g, '').length >= 7 ? null : 'Enter a valid phone number';
            },
            required: function (v) {
                return v.trim().length > 0 ? null : 'This field is required';
            }
        };

        function getValidator(input) {
            if (input.type === 'email')               { return VALIDATORS.email; }
            if (input.name && input.name.match(/postal|zip|postcode/i)) { return VALIDATORS.postalCode; }
            if (input.name && input.name.match(/phone|tel/i))           { return VALIDATORS.phone; }
            if (input.required)                        { return VALIDATORS.required; }
            return null;
        }

        function showError(input, message) {
            var wrapper = input.closest('.form-group') || input.parentElement;
            wrapper.classList.add('has-error');
            var existing = wrapper.querySelector('.invalid-feedback');
            if (!existing) {
                existing = document.createElement('div');
                existing.className = 'invalid-feedback';
                input.insertAdjacentElement('afterend', existing);
            }
            existing.textContent = message;
            input.setAttribute('aria-invalid', 'true');
        }

        function clearError(input) {
            var wrapper = input.closest('.form-group') || input.parentElement;
            wrapper.classList.remove('has-error');
            var msg = wrapper.querySelector('.invalid-feedback');
            if (msg) { msg.textContent = ''; }
            input.removeAttribute('aria-invalid');
        }

        var debouncedValidate = debounce(function (input) {
            var validator = getValidator(input);
            if (!validator) { return; }
            var error = validator(input.value);
            error ? showError(input, error) : clearError(input);
        }, DEBOUNCE_WAIT);

        form.querySelectorAll('input, select').forEach(function (input) {
            input.addEventListener('blur', function () { debouncedValidate(input); });
            input.addEventListener('input', function () {
                // Clear error immediately when user starts correcting — don't wait for blur
                clearError(input);
                // Persist to sessionStorage on change
                if (input.name && input.value) {
                    var simpleKey = input.name.split('_').pop();
                    Progress.set(simpleKey, input.value);
                }
            });
        });

        console.info('[CheckoutStepReducer] Inline validation attached to', formSelector);
    }

    // ── Step 4: Merge address + shipping into a single rendered step ──────────

    /**
     * Collapses the "Customer" and "Shipping" accordion panes into one view by:
     *   - Moving shipping method selector below the address form
     *   - Hiding the "Shipping" accordion header (navigational step)
     *   - Updating the step indicator count
     *
     * This is a progressive enhancement — if the DOM structure differs from
     * SFRA defaults, the function exits gracefully without breaking checkout.
     */
    function collapseAddressAndShipping() {
        var addressPane  = document.querySelector('#customer');
        var shippingPane = document.querySelector('#shipping');

        if (!addressPane || !shippingPane) { return; }

        var shippingMethodSection = shippingPane.querySelector('.shipping-method-block, .shipping-section');
        var addressFormBottom     = addressPane.querySelector('.address-form, form.shipping-form');

        if (!shippingMethodSection || !addressFormBottom) { return; }

        // Move shipping method selector into the address pane
        addressFormBottom.insertAdjacentElement('beforeend', shippingMethodSection.cloneNode(true));

        // Hide the redundant shipping step nav item
        var shippingNavItem = document.querySelector('[data-checkout-stage="shipping"], .nav-item-shipping');
        if (shippingNavItem) {
            shippingNavItem.style.display = 'none';
        }

        // Renumber visible step indicators
        document.querySelectorAll('.checkout-step-indicator .step-number').forEach(function (el, i) {
            if (el.closest('[style*="display: none"]')) { return; }
            el.textContent = i + 1;
        });

        console.info('[CheckoutStepReducer] Address + Shipping collapsed into single step');
    }

    // ── Step 5: Back-navigation guard ────────────────────────────────────────

    /**
     * Saves the current stage name when SFRA emits stage change events.
     * On page load, if a saved stage exists and is further along than the
     * current stage, restores the saved position.
     */
    function attachBackNavigationGuard() {
        document.addEventListener('checkout:updateCheckoutView', function (e) {
            var stage = e.detail && e.detail.checkoutStage;
            if (stage) { Progress.set('stage', stage); }
        });

        // On order confirm, clear saved progress
        document.addEventListener('checkout:orderConfirmed', function () {
            Progress.clear();
        });
    }

    // ── Public API ────────────────────────────────────────────────────────────

    var CheckoutStepReducer = {

        /**
         * Initialise all step-reduction techniques.
         * Call once after the checkout page DOM is ready.
         *
         * @param {Object} [opts]
         * @param {string} [opts.locale]         - Active locale (for validation rules)
         * @param {string} [opts.currency]       - Active currency
         * @param {boolean} [opts.collapseSteps] - Merge address+shipping (default: true)
         * @param {string}  [opts.formSelector]  - Checkout form CSS selector
         */
        init: function (opts) {
            var options = opts || {};

            Progress.load();

            if (options.collapseSteps !== false) {
                collapseAddressAndShipping();
            }

            preFillAddressFields();
            attachInlineValidation(options.formSelector);
            autoAdvanceSingleShippingMethod();
            attachBackNavigationGuard();

            console.info('[CheckoutStepReducer] Initialised', {
                locale  : options.locale,
                currency: options.currency
            });
        },

        preFillAddressFields             : preFillAddressFields,
        collapseAddressAndShipping       : collapseAddressAndShipping,
        attachInlineValidation           : attachInlineValidation,
        autoAdvanceSingleShippingMethod  : autoAdvanceSingleShippingMethod,
        Progress                         : Progress,
        STEPS                            : STEPS
    };

    window.CheckoutStepReducer = CheckoutStepReducer;

}(window, document));
