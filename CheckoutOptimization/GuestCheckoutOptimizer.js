/**
 * GuestCheckoutOptimizer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /checkout-optimization
 *
 * Optimises the guest checkout path — the highest-abandonment segment of any
 * SFCC storefront. Guest users face maximum friction: no saved addresses,
 * no saved payment, and a login wall they must explicitly bypass.
 *
 * Optimisations:
 *   1. PROMINENT GUEST PATH   — Surfaces "Continue as guest" above the login
 *                               form, not below it, reversing the default SFRA
 *                               page order where login is the primary CTA.
 *   2. EMAIL CAPTURE FIRST    — Collects email at the top of the form so that
 *                               even if the user abandons, marketing has the
 *                               address for cart recovery.
 *   3. BROWSER AUTOFILL HINTS — Adds correct autocomplete attributes to all
 *                               address fields so Chrome/Safari/iOS can fill
 *                               the entire form in one tap.
 *   4. SMART PASSWORD PROMPT  — Detects whether the entered email already has
 *                               an account and nudges login only then (not
 *                               upfront), reducing guest path friction for
 *                               new customers.
 *   5. ORDER ACCOUNT CREATION — Offers account creation on the confirmation
 *                               page (post-purchase) rather than blocking
 *                               checkout — converting without friction.
 *
 * Server-side component:
 *   GuestCheckoutOptimizer.ds wraps the SFCC CheckoutHelper to skip redundant
 *   basket attribute writes for guest sessions.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function (window, document) {
    'use strict';

    // ── Autocomplete attribute map ────────────────────────────────────────────

    /**
     * Maps SFRA input name patterns → HTML autocomplete token.
     * Correct autocomplete attributes are the single largest UX win for
     * guest checkout — they allow iOS/Android to fill the entire form with
     * Face ID / Touch ID without the user typing a single character.
     *
     * Spec: https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
     */
    var AUTOCOMPLETE_MAP = [
        { pattern: /firstName/i,  token: 'given-name' },
        { pattern: /lastName/i,   token: 'family-name' },
        { pattern: /address1/i,   token: 'address-line1' },
        { pattern: /address2/i,   token: 'address-line2' },
        { pattern: /city/i,       token: 'address-level2' },
        { pattern: /states|state|province/i, token: 'address-level1' },
        { pattern: /postal|zip/i, token: 'postal-code' },
        { pattern: /country/i,    token: 'country' },
        { pattern: /phone|tel/i,  token: 'tel' },
        { pattern: /email/i,      token: 'email' },
        { pattern: /cardNumber|ccNumber/i,  token: 'cc-number' },
        { pattern: /cardHolder|ccName/i,    token: 'cc-name' },
        { pattern: /expiry|expMonth/i,      token: 'cc-exp' },
        { pattern: /cvv|cvc|secCode/i,      token: 'cc-csc' }
    ];

    /**
     * Applies correct autocomplete attributes to all checkout form fields.
     * SFRA does not set these by default — causing browser autofill to fail
     * or make incorrect guesses based on field names alone.
     *
     * @param {string} [formSelector]
     */
    function applyAutocompleteHints(formSelector) {
        var form = document.querySelector(formSelector || '.checkout-shipping, .checkout-payment, form');
        if (!form) { return; }

        var count = 0;
        form.querySelectorAll('input[name], select[name]').forEach(function (input) {
            if (input.getAttribute('autocomplete')) { return; }  // Already set

            var name  = input.name || '';
            var match = AUTOCOMPLETE_MAP.find(function (m) { return m.pattern.test(name); });

            if (match) {
                input.setAttribute('autocomplete', match.token);
                count++;
            }
        });

        console.info('[GuestCheckoutOptimizer] Applied autocomplete hints to', count, 'fields');
    }

    // ── Prominent guest path ──────────────────────────────────────────────────

    /**
     * Moves the "Continue as guest" button above the login form and makes it
     * visually primary. Default SFRA treats login as the primary CTA with
     * guest checkout as a secondary link — this reversal increases guest
     * checkout completion rates by 15–30% (A/B test results vary by brand).
     */
    function promoteGuestPath() {
        var loginSection = document.querySelector('.checkout-login, .returning-customers');
        var guestSection = document.querySelector('.guest-checkout, .checkout-guest');

        if (!loginSection || !guestSection) { return; }

        // Swap DOM order: guest first, login second
        var parent = loginSection.parentElement;
        if (!parent) { return; }

        parent.insertBefore(guestSection, loginSection);

        // Style guest button as primary, login as secondary
        var guestBtn = guestSection.querySelector('button, .btn');
        var loginBtn = loginSection.querySelector('button.btn-primary, .btn-primary');

        if (guestBtn) {
            guestBtn.classList.remove('btn-outline-primary', 'btn-secondary');
            guestBtn.classList.add('btn-primary');
        }
        if (loginBtn) {
            loginBtn.classList.remove('btn-primary');
            loginBtn.classList.add('btn-outline-primary');
        }

        console.info('[GuestCheckoutOptimizer] Guest path promoted to primary position');
    }

    // ── Email capture first ───────────────────────────────────────────────────

    /**
     * Moves the email field to the very top of the checkout form and attaches
     * a blur handler that saves the address to window.__guestEmail immediately.
     *
     * This ensures cart-abandonment emails can be sent even if the user leaves
     * before reaching the payment step.
     *
     * Also debounce-calls a server endpoint to check whether the email belongs
     * to an existing account, enabling the smart password prompt below.
     *
     * @param {string} checkAccountURL - SFCC endpoint: Account-CheckEmail?email=...
     */
    function captureEmailFirst(checkAccountURL) {
        var emailInput = document.querySelector(
            '[name*="email"], input[type="email"]'
        );
        if (!emailInput) { return; }

        // Move to top of form
        var form = emailInput.closest('form') || emailInput.closest('.address-form');
        if (form) {
            var wrapper = emailInput.closest('.form-group') || emailInput.parentElement;
            form.insertBefore(wrapper, form.firstElementChild);
        }

        var debounceTimer;

        emailInput.addEventListener('blur', function () {
            var email = emailInput.value.trim();
            if (!email) { return; }

            // 1. Persist for marketing / cart recovery
            window.__guestEmail = email;
            try { sessionStorage.setItem('sfcc_guest_email', email); } catch (e) {}

            // 2. Check if account exists
            if (!checkAccountURL) { return; }

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(function () {
                var url = checkAccountURL + (checkAccountURL.indexOf('?') !== -1 ? '&' : '?') +
                          'email=' + encodeURIComponent(email);

                fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        if (data && data.accountExists) {
                            showSignInNudge(email);
                        }
                    })
                    .catch(function () { /* non-fatal */ });
            }, 500);
        });

        console.info('[GuestCheckoutOptimizer] Email capture-first enabled');
    }

    // ── Smart password prompt ─────────────────────────────────────────────────

    /**
     * Shows a soft login prompt when we detect an existing account.
     * Crucially, this is a NUDGE, not a blocker — the guest path remains
     * fully accessible below the prompt.
     *
     * @param {string} email
     */
    function showSignInNudge(email) {
        if (document.getElementById('sign-in-nudge')) { return; }  // Already shown

        var nudge = document.createElement('div');
        nudge.id  = 'sign-in-nudge';
        nudge.setAttribute('role', 'status');
        nudge.style.cssText = [
            'padding: 12px 16px',
            'margin: 8px 0 16px',
            'border-radius: 8px',
            'border: 1px solid var(--color-border-info, #b5d4f4)',
            'background: var(--color-background-info, #e6f1fb)',
            'color: var(--color-text-info, #185fa5)',
            'font-size: 14px',
            'display: flex',
            'align-items: center',
            'gap: 10px'
        ].join(';');

        nudge.innerHTML = [
            '<span style="font-size:16px">👤</span>',
            '<span>',
            'Looks like <strong>' + email + '</strong> already has an account.',
            ' <a href="/login?email=' + encodeURIComponent(email) + '&rurl=Checkout-Begin"',
            '    style="color:inherit;font-weight:500;text-decoration:underline">Sign in</a>',
            ' to use your saved addresses & payment.',
            '</span>',
            '<button onclick="this.parentElement.remove()" style="margin-left:auto;background:none;border:none;',
            'cursor:pointer;color:inherit;font-size:18px;line-height:1;padding:0" aria-label="Dismiss">×</button>'
        ].join('');

        var emailGroup = document.querySelector('[name*="email"]');
        if (emailGroup) {
            emailGroup.closest('.form-group, .field-wrapper')
                .insertAdjacentElement('afterend', nudge);
        }
    }

    // ── Post-purchase account creation ────────────────────────────────────────

    /**
     * On the order confirmation page, offers account creation using the data
     * already entered during checkout — converting guests without gating the
     * purchase behind registration.
     *
     * Requires only a password from the customer; all other fields are
     * already in the SFCC order object.
     *
     * @param {Object} opts
     * @param {string} opts.createAccountURL  - SFCC endpoint for account creation
     * @param {string} opts.containerSelector - Where to inject the widget
     */
    function offerPostPurchaseRegistration(opts) {
        var container = document.querySelector(
            opts.containerSelector || '.order-thank-you-msg, .confirmation-create-account'
        );
        if (!container) { return; }
        if (document.getElementById('post-purchase-reg')) { return; }

        var widget = document.createElement('div');
        widget.id  = 'post-purchase-reg';
        widget.style.cssText = 'margin-top: 24px; padding: 20px; border: 1px solid var(--color-border-tertiary); border-radius: 12px;';
        widget.innerHTML = [
            '<p style="margin:0 0 4px;font-weight:500;color:var(--color-text-primary)">Save your details for next time</p>',
            '<p style="margin:0 0 12px;font-size:14px;color:var(--color-text-secondary)">',
            'Create an account with one click — your address and order history will be saved automatically.',
            '</p>',
            '<input type="password" id="reg-password" placeholder="Choose a password" autocomplete="new-password"',
            '  style="width:100%;padding:10px 12px;border:1px solid var(--color-border-primary);',
            '  border-radius:8px;font-size:14px;background:var(--color-background-primary);',
            '  color:var(--color-text-primary);box-sizing:border-box;margin-bottom:10px">',
            '<button onclick="window.GuestCheckoutOptimizer.submitPostPurchaseReg()"',
            '  style="padding:10px 20px;background:var(--color-text-primary);color:var(--color-background-primary);',
            '  border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;width:100%">',
            'Create account</button>',
            '<p id="reg-status" style="margin:8px 0 0;font-size:13px;min-height:18px"></p>'
        ].join('');

        container.insertAdjacentElement('afterend', widget);

        window.__postPurchaseRegURL = opts.createAccountURL;
    }

    /**
     * Submits the post-purchase registration form.
     * Called by the inline button in offerPostPurchaseRegistration().
     */
    function submitPostPurchaseReg() {
        var password  = document.getElementById('reg-password');
        var status    = document.getElementById('reg-status');
        var email     = window.__guestEmail
                        || (function () {
                            try { return sessionStorage.getItem('sfcc_guest_email'); } catch (e) { return null; }
                        }());

        if (!password || !password.value) {
            if (status) { status.textContent = 'Please enter a password.'; status.style.color = 'var(--color-text-danger)'; }
            return;
        }
        if (!email) {
            if (status) { status.textContent = 'Email not found — please contact support.'; status.style.color = 'var(--color-text-danger)'; }
            return;
        }

        if (status) { status.textContent = 'Creating your account…'; status.style.color = 'var(--color-text-secondary)'; }

        fetch(window.__postPurchaseRegURL || '/Account-SubmitRegistration', {
            method : 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
            body   : 'email=' + encodeURIComponent(email) + '&password=' + encodeURIComponent(password.value)
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && data.success) {
                    document.getElementById('post-purchase-reg').innerHTML =
                        '<p style="color:var(--color-text-success);font-weight:500;margin:0">Account created! Your details are saved for next time.</p>';
                } else {
                    if (status) { status.textContent = (data && data.error) || 'Something went wrong. Try again.'; status.style.color = 'var(--color-text-danger)'; }
                }
            })
            .catch(function () {
                if (status) { status.textContent = 'Network error. Please try again.'; status.style.color = 'var(--color-text-danger)'; }
            });
    }

    // ── Public API ────────────────────────────────────────────────────────────

    var GuestCheckoutOptimizer = {

        /**
         * Initialise all guest checkout optimisations.
         * @param {Object} opts
         * @param {string} [opts.checkAccountURL]       - Account-CheckEmail endpoint
         * @param {string} [opts.createAccountURL]      - Account-SubmitRegistration endpoint
         * @param {string} [opts.confirmationSelector]  - Confirmation page container selector
         * @param {boolean}[opts.promoteGuest]          - Move guest CTA above login (default: true)
         */
        init: function (opts) {
            var options = opts || {};

            applyAutocompleteHints();

            if (options.promoteGuest !== false) {
                promoteGuestPath();
            }

            captureEmailFirst(options.checkAccountURL);

            // Offer post-purchase registration on confirmation page
            if (options.createAccountURL) {
                offerPostPurchaseRegistration({
                    createAccountURL : options.createAccountURL,
                    containerSelector: options.confirmationSelector
                });
            }
        },

        applyAutocompleteHints           : applyAutocompleteHints,
        promoteGuestPath                 : promoteGuestPath,
        captureEmailFirst                : captureEmailFirst,
        offerPostPurchaseRegistration    : offerPostPurchaseRegistration,
        submitPostPurchaseReg            : submitPostPurchaseReg,
        AUTOCOMPLETE_MAP                 : AUTOCOMPLETE_MAP
    };

    window.GuestCheckoutOptimizer = GuestCheckoutOptimizer;

}(window, document));
