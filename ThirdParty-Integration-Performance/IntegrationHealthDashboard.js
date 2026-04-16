/**
 * IntegrationHealthDashboard.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /third-party-integration-performance
 *
 * Real-time health monitoring aggregator for all third-party integrations.
 * Exposes a SFCC Controller endpoint that returns a JSON health summary —
 * plug this into Datadog, Splunk, PagerDuty, or your ops team's Slack channel.
 *
 * Two components:
 *
 *   SERVER-SIDE: HealthAggregator
 *     Collects circuit breaker states, async queue depths, and recent error
 *     rates across all registered integrations. Scores each integration
 *     on a 0–100 health scale. Triggers alerts via SFCC Custom Objects
 *     when an integration drops below its configured threshold.
 *
 *   CLIENT-SIDE: HealthDashboardWidget
 *     A self-contained HTML widget (included as a SFCC Content Asset) that
 *     polls the health endpoint every 30 seconds and renders a live
 *     integration status board for operations teams.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var CacheMgr        = require('dw/system/CacheMgr');
var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var Transaction     = require('dw/system/Transaction');
var Logger          = require('dw/system/Logger').getLogger('integrations', 'HealthDashboard');

var CircuitBreaker  = require('*/cartridge/scripts/integrations/IntegrationCircuitBreaker');
var AsyncQueue      = require('*/cartridge/scripts/integrations/AsyncIntegrationQueue');

// ─── Integration registry ─────────────────────────────────────────────────────

/**
 * All monitored integrations — extend with your project-specific services.
 * Each entry defines the circuit breaker name, alert threshold, and SLA.
 */
var INTEGRATION_REGISTRY = [
    {
        id         : 'payment-stripe',
        label      : 'Stripe Payment',
        category   : 'PAYMENT',
        slaMs      : 5000,
        alertBelow : 80   // Alert if health score drops below 80%
    },
    {
        id         : 'payment-adyen',
        label      : 'Adyen Payment',
        category   : 'PAYMENT',
        slaMs      : 5000,
        alertBelow : 80
    },
    {
        id         : 'oms-createOrder',
        label      : 'OMS Order Creation',
        category   : 'OMS',
        slaMs      : 10000,
        alertBelow : 70
    },
    {
        id         : 'erp-price',
        label      : 'ERP Pricing',
        category   : 'ERP',
        slaMs      : 3000,
        alertBelow : 75
    },
    {
        id         : 'tax',
        label      : 'Tax Calculation',
        category   : 'TAX',
        slaMs      : 2000,
        alertBelow : 85
    },
    {
        id         : 'fraud',
        label      : 'Fraud Scoring',
        category   : 'FRAUD',
        slaMs      : 2000,
        alertBelow : 75
    }
];

// ─── Health score calculator ──────────────────────────────────────────────────

/**
 * Calculates a 0–100 health score for an integration from its circuit breaker state.
 *
 * Scoring rules:
 *   CLOSED   + 0 recent failures   = 100
 *   CLOSED   + some slow calls     = 70–95 (proportional to slow call rate)
 *   HALF_OPEN                      = 50
 *   OPEN                           = 0
 *
 * @param  {Object} cbStatus - From CircuitBreaker.status()
 * @returns {number} 0–100
 */
function calculateHealthScore(cbStatus) {
    if (!cbStatus) { return -1; }   // -1 = unknown / not yet initialised

    if (cbStatus.state === 'OPEN')      { return 0; }
    if (cbStatus.state === 'HALF_OPEN') { return 50; }

    // CLOSED — factor in slow call rate
    var slowRate = cbStatus.totalCalls > 5
        ? (cbStatus.slowCalls / cbStatus.totalCalls)
        : 0;

    var score = 100 - (slowRate * 40);   // Max 40-point penalty for slow calls

    // Deduct for recent consecutive failures (haven't hit threshold yet)
    var maxFail = cbStatus.config && cbStatus.config.failureThreshold || 5;
    if (cbStatus.failures > 0) {
        score -= (cbStatus.failures / maxFail) * 20;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Determines the status label from a health score.
 * @param  {number} score
 * @returns {'HEALTHY'|'DEGRADED'|'CRITICAL'|'DOWN'|'UNKNOWN'}
 */
function healthLabel(score) {
    if (score === -1)    { return 'UNKNOWN'; }
    if (score === 0)     { return 'DOWN'; }
    if (score < 50)      { return 'CRITICAL'; }
    if (score < 80)      { return 'DEGRADED'; }
    return 'HEALTHY';
}

// ─── Alert management ─────────────────────────────────────────────────────────

var ALERT_CO_TYPE = 'IntegrationAlert';

function raiseAlert(integrationId, score, cbStatus) {
    try {
        Transaction.wrap(function () {
            var alertId  = 'alert-' + integrationId + '-' + Date.now();
            var obj      = CustomObjectMgr.createCustomObject(ALERT_CO_TYPE, alertId);
            obj.custom.integrationId = integrationId;
            obj.custom.healthScore   = score;
            obj.custom.circuitState  = cbStatus ? cbStatus.state : 'UNKNOWN';
            obj.custom.alertedAt     = new Date().toISOString();
            obj.custom.resolved      = false;
        });
        Logger.error('INTEGRATION ALERT: {0} health={1}% state={2}',
            integrationId, score, cbStatus ? cbStatus.state : 'UNKNOWN');
    } catch (e) {
        Logger.warn('IntegrationHealthDashboard: could not create alert: {0}', e.message);
    }
}

// ─── Health Aggregator ────────────────────────────────────────────────────────

var HealthAggregator = {

    /**
     * Returns a complete health summary for all registered integrations.
     * Caches the result for 15 seconds to avoid hammering CacheMgr on every poll.
     *
     * @returns {Object}  Health summary object
     */
    getSummary: function () {
        var CACHE_KEY = 'integration_health_summary';

        try {
            var cached = CacheMgr.get(CACHE_KEY);
            if (cached) { return cached; }
        } catch (e) { /* non-fatal */ }

        var integrations  = [];
        var overallScores = [];
        var queueStats    = AsyncQueue.getStats();
        var now           = new Date().toISOString();

        INTEGRATION_REGISTRY.forEach(function (reg) {
            var cbStatus = null;
            try {
                var breaker = CircuitBreaker.get(reg.id);
                cbStatus    = breaker.status();
            } catch (e) {
                Logger.warn('HealthDashboard: could not get status for {0}: {1}', reg.id, e.message);
            }

            var score  = calculateHealthScore(cbStatus);
            var status = healthLabel(score);

            if (score !== -1 && score < reg.alertBelow) {
                raiseAlert(reg.id, score, cbStatus);
            }

            overallScores.push(score === -1 ? 100 : score);  // Unknown = assume healthy

            integrations.push({
                id          : reg.id,
                label       : reg.label,
                category    : reg.category,
                healthScore : score,
                status      : status,
                slaMs       : reg.slaMs,
                alertBelow  : reg.alertBelow,
                circuit     : cbStatus ? {
                    state      : cbStatus.state,
                    failures   : cbStatus.failures,
                    successes  : cbStatus.successes,
                    openedAt   : cbStatus.openedAt,
                    totalCalls : cbStatus.totalCalls,
                    slowCalls  : cbStatus.slowCalls
                } : null
            });
        });

        var overallScore  = overallScores.length
            ? Math.round(overallScores.reduce(function (s, v) { return s + v; }, 0) / overallScores.length)
            : 100;

        var summary = {
            generatedAt   : now,
            overallScore  : overallScore,
            overallStatus : healthLabel(overallScore),
            integrations  : integrations,
            asyncQueue    : queueStats,
            alerts        : {
                critical : integrations.filter(function (i) { return i.status === 'CRITICAL' || i.status === 'DOWN'; }).length,
                degraded : integrations.filter(function (i) { return i.status === 'DEGRADED'; }).length
            }
        };

        try { CacheMgr.put(CACHE_KEY, summary, 15); } catch (e) { /* non-fatal */ }

        return summary;
    },

    INTEGRATION_REGISTRY: INTEGRATION_REGISTRY,
    calculateHealthScore : calculateHealthScore,
    healthLabel          : healthLabel
};

// ─── Client-side health dashboard widget ─────────────────────────────────────

var DASHBOARD_HTML = [
'<!DOCTYPE html>',
'<html lang="en">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1">',
'<title>Integration Health Dashboard</title>',
'<style>',
'  * { box-sizing: border-box; margin: 0; padding: 0; }',
'  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
'    background: #0f1117; color: #e2e8f0; min-height: 100vh; padding: 24px; }',
'  h1 { font-size: 20px; font-weight: 600; color: #f8fafc; margin-bottom: 4px; }',
'  .subtitle { font-size: 13px; color: #64748b; margin-bottom: 24px; }',
'  .overall { display: flex; align-items: center; gap: 16px; background: #1e2433;',
'    border-radius: 12px; padding: 16px 20px; margin-bottom: 20px; border: 1px solid #2d3748; }',
'  .score-ring { width: 60px; height: 60px; position: relative; flex-shrink: 0; }',
'  .score-ring svg { transform: rotate(-90deg); }',
'  .score-num { position: absolute; inset: 0; display: flex; align-items: center;',
'    justify-content: center; font-size: 15px; font-weight: 700; }',
'  .overall-label h2 { font-size: 16px; font-weight: 600; }',
'  .overall-label p { font-size: 12px; color: #64748b; margin-top: 2px; }',
'  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }',
'  .card { background: #1e2433; border-radius: 10px; padding: 16px;',
'    border: 1px solid #2d3748; transition: border-color .2s; }',
'  .card:hover { border-color: #4a5568; }',
'  .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }',
'  .card-label { font-size: 14px; font-weight: 600; color: #e2e8f0; }',
'  .card-cat { font-size: 10px; color: #64748b; margin-top: 2px; letter-spacing: .05em; }',
'  .badge { font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 20px; letter-spacing: .05em; }',
'  .HEALTHY  { background: #14532d; color: #4ade80; }',
'  .DEGRADED { background: #713f12; color: #fbbf24; }',
'  .CRITICAL { background: #7f1d1d; color: #f87171; }',
'  .DOWN     { background: #450a0a; color: #ef4444; border: 1px solid #ef4444; }',
'  .UNKNOWN  { background: #1e293b; color: #64748b; }',
'  .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }',
'  .bar-label { font-size: 11px; color: #64748b; width: 70px; flex-shrink: 0; }',
'  .bar-bg { flex: 1; height: 6px; background: #2d3748; border-radius: 3px; overflow: hidden; }',
'  .bar-fill { height: 100%; border-radius: 3px; transition: width .5s; }',
'  .bar-val { font-size: 11px; color: #94a3b8; width: 30px; text-align: right; flex-shrink: 0; }',
'  .circuit { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }',
'  .circuit-chip { font-size: 10px; padding: 2px 6px; border-radius: 4px; background: #2d3748; color: #94a3b8; }',
'  .queue-section { background: #1e2433; border-radius: 10px; padding: 16px;',
'    border: 1px solid #2d3748; margin-top: 20px; }',
'  .queue-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 12px; }',
'  .queue-stat { text-align: center; }',
'  .queue-num { font-size: 24px; font-weight: 700; }',
'  .queue-num.ok { color: #4ade80; }',
'  .queue-num.warn { color: #fbbf24; }',
'  .queue-num.danger { color: #f87171; }',
'  .queue-lbl { font-size: 11px; color: #64748b; margin-top: 2px; }',
'  .refresh { font-size: 11px; color: #4a5568; margin-top: 20px; text-align: center; }',
'  .error { background: #7f1d1d; border-radius: 8px; padding: 12px 16px; color: #fca5a5; font-size: 13px; }',
'</style>',
'</head>',
'<body>',
'<h1>Integration Health</h1>',
'<p class="subtitle" id="last-updated">Loading…</p>',
'<div id="overall"></div>',
'<div class="grid" id="cards"></div>',
'<div class="queue-section">',
'  <div style="font-size:13px;font-weight:600;color:#e2e8f0">Async Queue</div>',
'  <div class="queue-grid" id="queue"></div>',
'</div>',
'<p class="refresh" id="refresh-msg"></p>',
'<script>',
'var ENDPOINT = "/on/demandware.store/Sites-__SITE_ID__-Site/default/IntegrationHealth-Summary";',
'var INTERVAL = 30000;',
'',
'function scoreColor(s) {',
'  return s >= 80 ? "#4ade80" : s >= 50 ? "#fbbf24" : "#f87171";',
'}',
'',
'function ring(score) {',
'  var c = scoreColor(score);',
'  var r = 24; var circ = 2 * Math.PI * r;',
'  var dash = (score / 100) * circ;',
'  return \'<svg width="60" height="60" viewBox="0 0 60 60">\'',
'    + \'<circle cx="30" cy="30" r="\' + r + \'" fill="none" stroke="#2d3748" stroke-width="5"/>\'',
'    + \'<circle cx="30" cy="30" r="\' + r + \'" fill="none" stroke="\' + c + \'" stroke-width="5"\'',
'    + \' stroke-dasharray="\' + dash.toFixed(1) + \' \' + circ.toFixed(1) + \'"/>\'',
'    + \'</svg><div class="score-num" style="color:\' + c + \'">\' + score + \'</div>\';',
'}',
'',
'function render(data) {',
'  document.getElementById("last-updated").textContent = "Updated: " + new Date(data.generatedAt).toLocaleTimeString();',
'',
'  document.getElementById("overall").innerHTML = \'<div class="overall">\'',
'    + \'<div class="score-ring">\' + ring(data.overallScore) + \'</div>\'',
'    + \'<div class="overall-label"><h2 style="color:\' + scoreColor(data.overallScore) + \'">\'',
'    + data.overallStatus + \'</h2>\'',
'    + \'<p>\' + data.integrations.length + \' integrations · \'',
'    + data.alerts.critical + \' critical · \' + data.alerts.degraded + \' degraded</p>\'',
'    + \'</div></div>\';',
'',
'  var cards = data.integrations.map(function(i) {',
'    var sc    = i.healthScore === -1 ? "?" : i.healthScore;',
'    var col   = i.healthScore >= 0 ? scoreColor(i.healthScore) : "#64748b";',
'    var chips = i.circuit ? [',
'      "Failures: " + i.circuit.failures,',
'      "Calls: " + i.circuit.totalCalls,',
'      "Slow: " + i.circuit.slowCalls',
'    ] : [];',
'    return \'<div class="card">\'',
'      + \'<div class="card-header">\'',
'      + \'<div><div class="card-label">\' + i.label + \'</div><div class="card-cat">\' + i.category + \'</div></div>\'',
'      + \'<span class="badge \' + i.status + \'">\' + i.status + \'</span>\'',
'      + \'</div>\'',
'      + \'<div class="bar-row"><span class="bar-label">Health</span>\'',
'      + \'<div class="bar-bg"><div class="bar-fill" style="width:\' + (i.healthScore >= 0 ? i.healthScore : 0) + \'%;background:\' + col + \'"></div></div>\'',
'      + \'<span class="bar-val" style="color:\' + col + \'">\' + sc + \'%</span></div>\'',
'      + (i.circuit && i.circuit.state !== "CLOSED" ? \'<div class="bar-row">\'',
'        + \'<span class="bar-label">Circuit</span>\'',
'        + \'<span class="badge \' + (i.circuit.state === "OPEN" ? "DOWN" : "DEGRADED") + \'">\' + i.circuit.state + \'</span>\'',
'        + \'</div>\' : "")',
'      + \'<div class="circuit">\' + chips.map(function(c){ return \'<span class="circuit-chip">\' + c + \'</span>\'; }).join("") + \'</div>\'',
'      + \'</div>\';',
'  }).join("");',
'  document.getElementById("cards").innerHTML = cards;',
'',
'  var q = data.asyncQueue;',
'  document.getElementById("queue").innerHTML = [',
'    \'<div class="queue-stat"><div class="queue-num \' + (q.pending > 100 ? "warn" : "ok") + \'">\' + q.pending + \'</div><div class="queue-lbl">Pending</div></div>\',',
'    \'<div class="queue-stat"><div class="queue-num \' + (q.failed > 0 ? "warn" : "ok") + \'">\' + q.failed + \'</div><div class="queue-lbl">Failed (retry)</div></div>\',',
'    \'<div class="queue-stat"><div class="queue-num \' + (q.deadLetter > 0 ? "danger" : "ok") + \'">\' + q.deadLetter + \'</div><div class="queue-lbl">Dead Letter</div></div>\'',
'  ].join("");',
'',
'  var countdown = INTERVAL / 1000;',
'  document.getElementById("refresh-msg").textContent = "Auto-refreshes every " + countdown + "s";',
'}',
'',
'function load() {',
'  fetch(ENDPOINT)',
'    .then(function(r) { return r.json(); })',
'    .then(function(d) { render(d); })',
'    .catch(function(e) {',
'      document.getElementById("cards").innerHTML = \'<div class="error">Could not load health data: \' + e.message + \'</div>\';',
'    });',
'}',
'',
'load();',
'setInterval(load, INTERVAL);',
'</script>',
'</body>',
'</html>'
].join('\n');

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    HealthAggregator     : HealthAggregator,
    getDashboardHTML     : function () { return DASHBOARD_HTML; },
    INTEGRATION_REGISTRY : INTEGRATION_REGISTRY
};
