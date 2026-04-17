/**
 * PersonalizationImpactMonitor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /personalization-performance/monitoring
 *
 * Quantifies the performance cost of personalization decisions in real time.
 *
 * Problem: engineering teams often don't know what personalization is
 * actually costing them. This monitor exposes:
 *   • Latency overhead per personalization tier (ms added vs anonymous)
 *   • Cache hit rate degradation caused by personalization
 *   • Segment distribution (what % of traffic is in each tier)
 *   • Fragment load time (client-side, per fragment)
 *   • Cumulative Layout Shift (CLS) caused by late-loading fragments
 *
 * Two components:
 *   SERVER-SIDE: PersonalizationProfiler — instruments SFCC controllers
 *   CLIENT-SIDE: FragmentTimingObserver — measures browser-side fragment load
 *
 * Usage (server-side, in every personalised controller):
 *   var Monitor = require('*/cartridge/scripts/personalization/PersonalizationImpactMonitor');
 *   var profiler = Monitor.startRequest({ pageType: 'home', segment: segment });
 *   // ... render personalised content ...
 *   profiler.finish({ cacheHit: true });
 *
 * Usage (client-side, in htmlHead.isml):
 *   ${pdict.fragmentTimingScript}
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

var CacheMgr = require('dw/system/CacheMgr');
var Logger   = require('dw/system/Logger').getLogger('personalization', 'ImpactMonitor');

// ─── Thresholds ───────────────────────────────────────────────────────────────

var THRESHOLDS = {
    /** Max acceptable latency overhead for SEGMENT tier vs anonymous (ms) */
    SEGMENT_OVERHEAD_WARN    : 50,
    SEGMENT_OVERHEAD_CRITICAL: 200,

    /** Max acceptable latency overhead for ATTRIBUTE tier (ms) */
    ATTRIBUTE_OVERHEAD_WARN  : 150,
    ATTRIBUTE_OVERHEAD_CRIT  : 500,

    /** Min acceptable cache hit rate per tier */
    CACHE_HIT_RATE_WARN      : 0.60,
    CACHE_HIT_RATE_CRITICAL  : 0.40,

    /** Max acceptable fragment load time (ms) */
    FRAGMENT_LOAD_WARN       : 300,
    FRAGMENT_LOAD_CRITICAL   : 800,

    /** CLS threshold for personalization-induced layout shift */
    CLS_WARN                 : 0.05,
    CLS_CRITICAL             : 0.1
};

// ─── In-process stats accumulators ───────────────────────────────────────────

var STATS_TTL    = 3600;
var STATS_PREFIX = 'ps:monitor:';

function loadStats(key) {
    try { return CacheMgr.get(STATS_PREFIX + key) || {}; }
    catch (e) { return {}; }
}

function saveStats(key, data) {
    try { CacheMgr.put(STATS_PREFIX + key, data, STATS_TTL); }
    catch (e) { /* non-fatal */ }
}

function incrementStat(key, field, value) {
    var stats = loadStats(key);
    stats[field] = (stats[field] || 0) + (value || 1);
    saveStats(key, stats);
}

function recordLatency(key, ms) {
    var stats = loadStats(key);
    stats.totalRequests  = (stats.totalRequests  || 0) + 1;
    stats.totalLatencyMs = (stats.totalLatencyMs || 0) + ms;
    stats.maxLatencyMs   = Math.max(stats.maxLatencyMs || 0, ms);
    stats.minLatencyMs   = Math.min(stats.minLatencyMs || Infinity, ms);
    saveStats(key, stats);
}

// ─── SERVER-SIDE: PersonalizationProfiler ────────────────────────────────────

var PersonalizationProfiler = {

    /**
     * Starts profiling a personalised request.
     * Returns a handle with a finish() method.
     *
     * @param  {Object} ctx
     * @param  {string} ctx.pageType  - 'home'|'plp'|'pdp'|'search'
     * @param  {string} ctx.segment   - Customer segment
     * @param  {string} ctx.tier      - Personalization tier
     * @returns {{ finish: Function }}
     */
    startRequest: function (ctx) {
        var startMs = Date.now();
        var self    = this;

        return {
            /**
             * Records the outcome of this personalised request.
             * @param  {Object} result
             * @param  {boolean} result.cacheHit   - Was response served from cache?
             * @param  {number}  [result.fragmentCount] - Fragments rendered
             * @param  {string}  [result.error]    - Error message if failed
             */
            finish: function (result) {
                var latencyMs = Date.now() - startMs;
                result        = result || {};

                var statsKey = ctx.tier + ':' + ctx.pageType;

                // Record latency
                recordLatency(statsKey, latencyMs);

                // Record cache outcome
                incrementStat(statsKey, result.cacheHit ? 'cacheHits' : 'cacheMisses');

                // Record segment distribution
                incrementStat('segment:' + (ctx.segment || 'unknown'), 'count');

                // Log slow personalised responses
                var overheadThresholds = {
                    ANONYMOUS  : 0,
                    SEGMENT    : THRESHOLDS.SEGMENT_OVERHEAD_WARN,
                    ATTRIBUTE  : THRESHOLDS.ATTRIBUTE_OVERHEAD_WARN,
                    INDIVIDUAL : THRESHOLDS.ATTRIBUTE_OVERHEAD_CRIT
                };

                var warnThreshold = overheadThresholds[ctx.tier] || 200;

                if (latencyMs > THRESHOLDS.ATTRIBUTE_OVERHEAD_CRIT) {
                    Logger.error('PS_PERF CRITICAL tier={0} seg={1} page={2} latency={3}ms',
                        ctx.tier, ctx.segment, ctx.pageType, latencyMs);
                } else if (latencyMs > warnThreshold) {
                    Logger.warn('PS_PERF SLOW tier={0} seg={1} page={2} latency={3}ms',
                        ctx.tier, ctx.segment, ctx.pageType, latencyMs);
                } else {
                    Logger.info('PS_PERF OK tier={0} seg={1} page={2} latency={3}ms cached={4}',
                        ctx.tier, ctx.segment, ctx.pageType, latencyMs, result.cacheHit);
                }
            }
        };
    },

    /**
     * Returns aggregated performance statistics.
     * Used by the monitoring dashboard endpoint.
     *
     * @returns {Object}  Stats by tier and segment
     */
    getStats: function () {
        var tiers     = ['ANONYMOUS', 'SEGMENT', 'ATTRIBUTE', 'INDIVIDUAL'];
        var pageTypes = ['home', 'plp', 'pdp', 'search', 'cart', 'checkout'];
        var segments  = ['anonymous', 'new-visitor', 'returning', 'loyal', 'vip', 'abandoner'];

        var result = { byTier: {}, bySegment: {}, alerts: [] };

        // Tier stats
        tiers.forEach(function (tier) {
            result.byTier[tier] = {};
            pageTypes.forEach(function (pt) {
                var stats     = loadStats(tier + ':' + pt);
                var total     = stats.totalRequests || 0;
                var avgMs     = total ? Math.round(stats.totalLatencyMs / total) : 0;
                var cacheRate = total
                    ? ((stats.cacheHits || 0) / total)
                    : null;

                result.byTier[tier][pt] = {
                    requests  : total,
                    avgMs     : avgMs,
                    maxMs     : stats.maxLatencyMs || 0,
                    cacheHitRate: cacheRate !== null ? parseFloat(cacheRate.toFixed(2)) : null
                };

                // Generate alerts
                if (cacheRate !== null && cacheRate < THRESHOLDS.CACHE_HIT_RATE_CRITICAL) {
                    result.alerts.push({
                        level  : 'CRITICAL',
                        message: 'Cache hit rate for ' + tier + '/' + pt + ' is ' +
                                 (cacheRate * 100).toFixed(0) + '% — below ' +
                                 (THRESHOLDS.CACHE_HIT_RATE_CRITICAL * 100) + '% threshold'
                    });
                }
            });
        });

        // Segment distribution
        var totalSegmentReqs = 0;
        segments.forEach(function (seg) {
            var s = loadStats('segment:' + seg);
            result.bySegment[seg] = s.count || 0;
            totalSegmentReqs += (s.count || 0);
        });

        // Convert counts to percentages
        if (totalSegmentReqs > 0) {
            segments.forEach(function (seg) {
                result.bySegment[seg + '_pct'] = parseFloat(
                    ((result.bySegment[seg] / totalSegmentReqs) * 100).toFixed(1)
                );
            });
        }

        return result;
    },

    THRESHOLDS: THRESHOLDS
};

// ─── CLIENT-SIDE: FragmentTimingObserver (browser IIFE) ───────────────────────

/* eslint-disable */
var FRAGMENT_TIMING_SCRIPT = [
'<script id="ps-fragment-timing">',
'(function(win,doc){',
'  "use strict";',
'  var timings={};var clsBefore=0;',
'  doc.addEventListener("ps:loaded",function(e){',
'    var name=e.detail&&e.detail.name;',
'    if(!name)return;',
'    var el=doc.getElementById("ps-fragment-"+name);',
'    if(!el)return;',
'    var start=performance.getEntriesByType("resource")',
'      .find(function(r){return r.name.indexOf(el.dataset.endpoint)!==-1;});',
'    var ms=start?Math.round(start.duration):0;',
'    timings[name]={ms:ms,segment:e.detail.segment,ok:true};',
'    var rating=ms<300?"good":ms<800?"needs-improvement":"poor";',
'    if(typeof gtag==="function"){',
'      gtag("event","ps_fragment_load",{',
'        fragment_name:name,',
'        load_ms:ms,',
'        rating:rating,',
'        segment:e.detail.segment,',
'        non_interaction:true',
'      });',
'    }',
'    if(ms>800){',
'      console.warn("[PSMonitor] Slow fragment:",name,ms+"ms");',
'    }',
'  });',
'  doc.addEventListener("ps:fallback",function(e){',
'    var name=e.detail&&e.detail.name;',
'    if(name){timings[name]={ms:-1,ok:false};}',
'  });',
'  if("LayoutShift" in win){',
'    var clsObs=new PerformanceObserver(function(list){',
'      list.getEntries().forEach(function(e){',
'        if(!e.hadRecentInput){clsBefore+=e.value;}',
'      });',
'    });',
'    try{clsObs.observe({type:"layout-shift",buffered:true});}catch(er){}',
'  }',
'  win.addEventListener("load",function(){',
'    setTimeout(function(){',
'      var psFragments=doc.querySelectorAll("[data-fragment]");',
'      var loaded=doc.querySelectorAll(".ps-loaded").length;',
'      var clsAfter=0;',
'      try{',
'        var entries=performance.getEntriesByType("layout-shift")||[];',
'        entries.forEach(function(e){if(!e.hadRecentInput)clsAfter+=e.value;});',
'      }catch(e){}',
'      var clsFromPersonalization=Math.max(0,clsAfter-clsBefore);',
'      if(clsFromPersonalization>0.05){',
'        console.warn("[PSMonitor] CLS from personalization:",clsFromPersonalization.toFixed(4));',
'      }',
'      win.__psTimings={timings:timings,fragmentCount:psFragments.length,loadedCount:loaded,clsImpact:clsFromPersonalization};',
'    },2000);',
'  });',
'}(window,document));',
'</script>'
].join('\n');
/* eslint-enable */

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    Profiler              : PersonalizationProfiler,
    fragmentTimingScript  : FRAGMENT_TIMING_SCRIPT,
    THRESHOLDS            : THRESHOLDS
};
