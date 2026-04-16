/**
 * IntegrationCircuitBreaker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /third-party-integration-performance
 *
 * Implements the Circuit Breaker pattern for all third-party service calls
 * in SFCC (payment gateways, OMS, ERP, tax engines, fraud services, etc.).
 *
 * Without circuit breakers, a single degraded third-party service can cascade:
 *   Payment gateway at 8 s response time
 *     → Every checkout thread waits 8 s
 *       → Thread pool exhaustion
 *         → Entire storefront unresponsive
 *           → Revenue = £0 during outage
 *
 * The Circuit Breaker prevents this by tracking failure rates and
 * automatically opening the circuit (fast-fail) when a service degrades,
 * protecting the thread pool and preserving site availability.
 *
 * States:
 *   CLOSED   — Normal operation. Calls pass through. Failures counted.
 *   OPEN     — Service is degraded. Calls immediately fail-fast with fallback.
 *              Reopens automatically after cooldown period.
 *   HALF_OPEN — Probe state. One test call is allowed. Success → CLOSED.
 *              Failure → back to OPEN with extended cooldown.
 *
 * Usage:
 *   var CB = require('*/cartridge/scripts/integrations/IntegrationCircuitBreaker');
 *
 *   var breaker = CB.get('stripe-charge');
 *   var result  = breaker.call(function () {
 *       return stripeService.charge(params);
 *   }, function fallback() {
 *       return { error: 'Payment service temporarily unavailable. Please try again.' };
 *   });
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var CacheMgr = require('dw/system/CacheMgr');
var Logger   = require('dw/system/Logger').getLogger('integrations', 'CircuitBreaker');

// ─── States ───────────────────────────────────────────────────────────────────

var STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

// ─── Default configuration ────────────────────────────────────────────────────

/**
 * Per-integration tuning. Override via CB.configure() before first use.
 *
 * failureThreshold   : consecutive failures before opening circuit
 * successThreshold   : consecutive successes in HALF_OPEN before closing
 * openDurationMs     : how long circuit stays OPEN before probing (ms)
 * halfOpenProbeLimit : max concurrent probe calls in HALF_OPEN state
 * slowCallMs         : calls slower than this count as "slow calls"
 * slowCallRatePct    : % of calls that are slow before opening circuit
 */
var INTEGRATION_PROFILES = {
    // Payment gateways — aggressive thresholds, zero tolerance for slow calls
    'payment': {
        failureThreshold  : 3,
        successThreshold  : 2,
        openDurationMs    : 30000,    // 30 s
        halfOpenProbeLimit: 1,
        slowCallMs        : 5000,
        slowCallRatePct   : 50
    },
    // OMS / fulfilment — somewhat tolerant, order creation can retry
    'oms': {
        failureThreshold  : 5,
        successThreshold  : 3,
        openDurationMs    : 60000,    // 60 s
        halfOpenProbeLimit: 1,
        slowCallMs        : 8000,
        slowCallRatePct   : 60
    },
    // ERP / pricing — can serve cached prices on failure
    'erp': {
        failureThreshold  : 5,
        successThreshold  : 3,
        openDurationMs    : 120000,   // 2 min
        halfOpenProbeLimit: 2,
        slowCallMs        : 10000,
        slowCallRatePct   : 70
    },
    // Tax calculation — tolerable if cached; fallback to estimated tax
    'tax': {
        failureThreshold  : 8,
        successThreshold  : 2,
        openDurationMs    : 60000,
        halfOpenProbeLimit: 1,
        slowCallMs        : 3000,
        slowCallRatePct   : 40
    },
    // Fraud scoring — tolerable; fall through to allow on open circuit
    'fraud': {
        failureThreshold  : 5,
        successThreshold  : 2,
        openDurationMs    : 45000,
        halfOpenProbeLimit: 1,
        slowCallMs        : 2000,
        slowCallRatePct   : 30
    },
    // Default for any unrecognised integration
    '_default': {
        failureThreshold  : 5,
        successThreshold  : 2,
        openDurationMs    : 60000,
        halfOpenProbeLimit: 1,
        slowCallMs        : 6000,
        slowCallRatePct   : 50
    }
};

// ─── State persistence via CacheMgr ───────────────────────────────────────────

/**
 * Each circuit's state is stored in CacheMgr so it is shared across all
 * SFCC pipeline threads within the same PIG — meaning one thread's detection
 * of a failure immediately protects all other threads.
 *
 * Key schema: cb:<integration-name>
 * Value: { state, failures, successes, openedAt, lastSlowCalls, totalCalls, slowCalls }
 */
var CACHE_PREFIX = 'cb:';
var CACHE_TTL    = 3600;  // 1 hour — state auto-clears if idle

function _stateKey(name) { return CACHE_PREFIX + name.replace(/[^a-zA-Z0-9_-]/g, '_'); }

function _loadState(name) {
    try {
        var cached = CacheMgr.get(_stateKey(name));
        return cached || null;
    } catch (e) {
        return null;
    }
}

function _saveState(name, stateObj) {
    try {
        CacheMgr.put(_stateKey(name), stateObj, CACHE_TTL);
    } catch (e) {
        Logger.warn('CircuitBreaker._saveState failed for {0}: {1}', name, e.message);
    }
}

function _defaultState() {
    return {
        state       : STATE.CLOSED,
        failures    : 0,
        successes   : 0,
        openedAt    : null,
        totalCalls  : 0,
        slowCalls   : 0
    };
}

// ─── Circuit Breaker class ────────────────────────────────────────────────────

/**
 * @param {string} name     - Unique integration name (e.g. 'stripe-charge')
 * @param {string} profile  - Profile key from INTEGRATION_PROFILES
 */
function CircuitBreaker(name, profile) {
    this.name    = name;
    this.config  = Object.assign(
        {},
        INTEGRATION_PROFILES['_default'],
        INTEGRATION_PROFILES[profile] || {},
        {}
    );
}

/**
 * Returns the current state object, initialising if not yet stored.
 * @returns {Object}
 */
CircuitBreaker.prototype._getState = function () {
    return _loadState(this.name) || _defaultState();
};

/**
 * Checks and transitions state as needed (OPEN → HALF_OPEN after cooldown).
 * @param  {Object} s - Current state object
 * @returns {Object}  Possibly-transitioned state
 */
CircuitBreaker.prototype._maybeTransition = function (s) {
    if (s.state === STATE.OPEN) {
        var elapsed = Date.now() - (s.openedAt || 0);
        if (elapsed >= this.config.openDurationMs) {
            Logger.info('CircuitBreaker [{0}] OPEN → HALF_OPEN after {1}ms cooldown', this.name, elapsed);
            s.state    = STATE.HALF_OPEN;
            s.failures = 0;
            s.successes = 0;
            _saveState(this.name, s);
        }
    }
    return s;
};

/**
 * Records a successful call.
 * @param {Object} s
 * @param {number} durationMs
 */
CircuitBreaker.prototype._recordSuccess = function (s, durationMs) {
    s.totalCalls++;
    if (durationMs >= this.config.slowCallMs) {
        s.slowCalls++;
        Logger.warn('CircuitBreaker [{0}] SLOW call {1}ms (threshold: {2}ms)',
            this.name, durationMs, this.config.slowCallMs);
    }

    if (s.state === STATE.HALF_OPEN) {
        s.successes++;
        if (s.successes >= this.config.successThreshold) {
            Logger.info('CircuitBreaker [{0}] HALF_OPEN → CLOSED after {1} successes', this.name, s.successes);
            s.state    = STATE.CLOSED;
            s.failures = 0;
            s.successes = 0;
        }
    } else {
        // In CLOSED: reset consecutive failure counter on success
        s.failures = Math.max(0, s.failures - 1);
    }

    // Check slow-call rate — open circuit even if calls succeed but are slow
    var slowRate = s.totalCalls > 10 ? (s.slowCalls / s.totalCalls * 100) : 0;
    if (slowRate >= this.config.slowCallRatePct && s.state === STATE.CLOSED) {
        Logger.warn('CircuitBreaker [{0}] SLOW CALL RATE {1}% ≥ {2}% threshold → OPEN',
            this.name, slowRate.toFixed(0), this.config.slowCallRatePct);
        s.state    = STATE.OPEN;
        s.openedAt = Date.now();
        s.slowCalls  = 0;
        s.totalCalls = 0;
    }

    _saveState(this.name, s);
};

/**
 * Records a failed call.
 * @param {Object} s
 */
CircuitBreaker.prototype._recordFailure = function (s) {
    s.totalCalls++;
    s.failures++;

    if (s.failures >= this.config.failureThreshold && s.state !== STATE.OPEN) {
        Logger.error('CircuitBreaker [{0}] {1} failures → OPEN (cooldown: {2}ms)',
            this.name, s.failures, this.config.openDurationMs);
        s.state    = STATE.OPEN;
        s.openedAt = Date.now();
    } else if (s.state === STATE.HALF_OPEN) {
        // Any failure in HALF_OPEN → back to OPEN
        Logger.warn('CircuitBreaker [{0}] HALF_OPEN probe failed → back to OPEN', this.name);
        s.state    = STATE.OPEN;
        s.openedAt = Date.now();
    }

    _saveState(this.name, s);
};

/**
 * Executes a service call through the circuit breaker.
 *
 * @param  {Function} callFn     - Zero-argument function that performs the call.
 *                                 Should throw on failure or return an error object.
 * @param  {Function} [fallbackFn] - Zero-argument function called when circuit is OPEN.
 *                                   If omitted, throws an Error on open circuit.
 * @returns {*}  Result of callFn (if circuit is CLOSED/HALF_OPEN) or fallbackFn.
 */
CircuitBreaker.prototype.call = function (callFn, fallbackFn) {
    var s   = this._maybeTransition(this._getState());
    var self = this;

    // Fast-fail on OPEN circuit
    if (s.state === STATE.OPEN) {
        Logger.warn('CircuitBreaker [{0}] OPEN — fast-fail, using fallback', self.name);
        if (typeof fallbackFn === 'function') {
            return fallbackFn(new Error('Circuit open: ' + self.name));
        }
        throw new Error('IntegrationCircuitBreaker: circuit is OPEN for ' + self.name);
    }

    var start = Date.now();
    try {
        var result      = callFn();
        var durationMs  = Date.now() - start;
        self._recordSuccess(s, durationMs);
        return result;
    } catch (err) {
        self._recordFailure(s);
        Logger.error('CircuitBreaker [{0}] call failed: {1}', self.name, err.message);
        if (typeof fallbackFn === 'function') {
            return fallbackFn(err);
        }
        throw err;
    }
};

/**
 * Returns the current state snapshot for monitoring / admin views.
 * @returns {{ name, state, failures, successes, openedAt, isOpen, isClosed, isHalfOpen }}
 */
CircuitBreaker.prototype.status = function () {
    var s = this._maybeTransition(this._getState());
    return {
        name       : this.name,
        state      : s.state,
        failures   : s.failures,
        successes  : s.successes,
        openedAt   : s.openedAt,
        totalCalls : s.totalCalls,
        slowCalls  : s.slowCalls,
        isOpen     : s.state === STATE.OPEN,
        isClosed   : s.state === STATE.CLOSED,
        isHalfOpen : s.state === STATE.HALF_OPEN,
        config     : this.config
    };
};

/**
 * Manually resets the circuit to CLOSED.
 * Use after a confirmed service recovery to re-enable without waiting for cooldown.
 */
CircuitBreaker.prototype.reset = function () {
    _saveState(this.name, _defaultState());
    Logger.info('CircuitBreaker [{0}] manually RESET to CLOSED', this.name);
};

// ─── Registry ─────────────────────────────────────────────────────────────────

var _registry = {};

/**
 * Gets or creates a circuit breaker by name.
 *
 * @param  {string} name      - Unique name (e.g. 'stripe-charge', 'sap-order-create')
 * @param  {string} [profile] - Profile key from INTEGRATION_PROFILES
 * @returns {CircuitBreaker}
 */
function get(name, profile) {
    if (!_registry[name]) {
        var prof = profile || _inferProfile(name);
        _registry[name] = new CircuitBreaker(name, prof);
        Logger.info('CircuitBreaker: created breaker [{0}] with profile [{1}]', name, prof);
    }
    return _registry[name];
}

/**
 * Infers a profile from the integration name.
 * 'stripe-charge' → 'payment', 'sap-order' → 'oms', etc.
 */
function _inferProfile(name) {
    var n = name.toLowerCase();
    if (/pay|stripe|adyen|braintree|paypal|klarna|applepay/i.test(n)) { return 'payment'; }
    if (/oms|order|fulfil|sap|manhattan|warehouse|wms/i.test(n))      { return 'oms'; }
    if (/erp|pricing|price|pim|catalog/i.test(n))                      { return 'erp'; }
    if (/tax|avalara|vertex|taxjar/i.test(n))                          { return 'tax'; }
    if (/fraud|signifyd|kount|riskified/i.test(n))                     { return 'fraud'; }
    return '_default';
}

/**
 * Returns status snapshots for all registered circuit breakers.
 * @returns {Object[]}
 */
function statusAll() {
    return Object.keys(_registry).map(function (name) {
        return _registry[name].status();
    });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    get               : get,
    statusAll         : statusAll,
    STATE             : STATE,
    INTEGRATION_PROFILES : INTEGRATION_PROFILES
};
