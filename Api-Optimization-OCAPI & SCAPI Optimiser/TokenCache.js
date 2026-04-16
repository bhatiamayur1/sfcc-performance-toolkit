/**
 * TokenCache.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /api-optimization
 *
 * Caches OCAPI / SCAPI client-credential (machine-to-machine) access tokens
 * in dw.system.CacheMgr so that each server thread reuses a valid token
 * instead of issuing a new /oauth2/token request per API call.
 *
 * Impact:
 *   A busy storefront can make thousands of token requests per minute. Each
 *   one adds 80–200 ms of network latency AND counts against rate limits.
 *   This module reduces token requests to near-zero during normal operation.
 *
 * Usage:
 *   var TokenCache = require('*/cartridge/scripts/perf/TokenCache');
 *
 *   var token = TokenCache.getToken({
 *       clientID    : Site.getCurrent().getCustomPreferenceValue('ocapiClientID'),
 *       clientSecret: Site.getCurrent().getCustomPreferenceValue('ocapiClientSecret'),
 *       tokenURL    : 'https://account.demandware.com/dwsso/oauth2/access_token'
 *   });
 *
 *   // Use token in OCAPI/SCAPI calls
 *   request.setRequestHeader('Authorization', 'Bearer ' + token);
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var CacheMgr   = require('dw/system/CacheMgr');
var HTTPClient = require('dw/net/HTTPClient');
var Logger     = require('dw/system/Logger').getLogger('perf', 'TokenCache');

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Cache key prefix. The client ID is appended so multiple clients
 * coexist without collision.
 */
var CACHE_KEY_PREFIX = 'oauth2_token:';

/**
 * Number of seconds before actual token expiry to pre-emptively refresh.
 * Prevents edge cases where a token expires mid-request.
 */
var EXPIRY_BUFFER_SECONDS = 60;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Requests a fresh access token from the OAuth2 token endpoint using the
 * client_credentials grant.
 *
 * @param  {string} tokenURL
 * @param  {string} clientID
 * @param  {string} clientSecret
 * @returns {{ access_token: string, expires_in: number }}
 */
function fetchFreshToken(tokenURL, clientID, clientSecret) {
    var http = new HTTPClient();
    http.setTimeout(5000);

    var credentials = require('dw/util/Base64').encode(clientID + ':' + clientSecret);
    http.setRequestHeader('Authorization', 'Basic ' + credentials);
    http.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');

    var body = 'grant_type=client_credentials';
    var ok   = http.sendAndReceive(tokenURL, 'POST', body);

    if (!ok || http.getStatusCode() !== 200) {
        throw new Error(
            '[TokenCache] Token endpoint returned ' + http.getStatusCode() +
            ' for client ' + clientID
        );
    }

    var parsed = JSON.parse(http.getText());

    if (!parsed || !parsed.access_token) {
        throw new Error('[TokenCache] Invalid token response — missing access_token field');
    }

    return parsed;
}

/**
 * Computes the effective TTL to use when caching the token, accounting for
 * the expiry buffer.
 *
 * @param  {number} expiresIn - Seconds until token expiry (from OAuth response)
 * @returns {number} TTL in seconds (minimum 10 s)
 */
function effectiveTTL(expiresIn) {
    var ttl = (expiresIn || 1800) - EXPIRY_BUFFER_SECONDS;
    return Math.max(ttl, 10);
}

// ─── Public API ───────────────────────────────────────────────────────────────

var TokenCache = {

    /**
     * Returns a valid access token, retrieving from cache or fetching fresh.
     *
     * @param  {Object} config
     * @param  {string} config.clientID
     * @param  {string} config.clientSecret
     * @param  {string} config.tokenURL
     * @returns {string} Raw access token string
     */
    getToken: function (config) {
        if (!config || !config.clientID || !config.clientSecret || !config.tokenURL) {
            throw new TypeError('[TokenCache] config must include clientID, clientSecret, and tokenURL');
        }

        var cacheKey = CACHE_KEY_PREFIX + config.clientID;

        // ── 1. Try cache ──────────────────────────────────────────────────────
        try {
            var cached = CacheMgr.get(cacheKey);
            if (cached && cached.access_token) {
                Logger.info('TokenCache HIT clientID={0}', config.clientID);
                return cached.access_token;
            }
        } catch (readErr) {
            Logger.warn('TokenCache read error: {0}', readErr.message);
        }

        // ── 2. Fetch fresh token ──────────────────────────────────────────────
        Logger.info('TokenCache MISS — fetching fresh token clientID={0}', config.clientID);

        var tokenData;
        try {
            tokenData = fetchFreshToken(config.tokenURL, config.clientID, config.clientSecret);
        } catch (fetchErr) {
            Logger.error('TokenCache fetch failed clientID={0}: {1}', config.clientID, fetchErr.message);
            throw fetchErr;
        }

        // ── 3. Store in cache ─────────────────────────────────────────────────
        var ttl = effectiveTTL(tokenData.expires_in);
        try {
            CacheMgr.put(cacheKey, tokenData, ttl);
            Logger.info('TokenCache STORED clientID={0} ttl={1}s', config.clientID, ttl);
        } catch (writeErr) {
            Logger.warn('TokenCache write error: {0}', writeErr.message);
        }

        return tokenData.access_token;
    },

    /**
     * Force-evicts the cached token for a given client ID.
     * Call this if you receive a 401 to ensure the next call fetches a fresh token.
     *
     * @param {string} clientID
     */
    invalidate: function (clientID) {
        try {
            CacheMgr.remove(CACHE_KEY_PREFIX + clientID);
            Logger.info('TokenCache INVALIDATED clientID={0}', clientID);
        } catch (e) {
            Logger.warn('TokenCache invalidation error: {0}', e.message);
        }
    }
};

module.exports = TokenCache;
