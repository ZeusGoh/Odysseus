/* state.js — Shared state. Everything keyed by symbol, then by timeframe key, plus analyse(),
   which turns freshly pulled candles into stochastic series, cross states and divergences.
   part of VL */

/* ---------- state ---------- */
// everything keyed first by symbol code, then by timeframe key
const data = {}, stoch = {}, states = {}, divsAll = {}, divNow = {};
const dataDepth = {};                  // symbol -> bars held, so shallow scans get refilled
let shown = ['1D','4H'], lastOk = 0;
let active = 'BTC';
let view = 'terminal';                 // 'terminal' | 'watch'
let watch = [];                        // tracked symbol codes, persisted
let watchBusy = false, watchDirty = false;
let recents = [];

const $ = id => document.getElementById(id);
function fmtUsd(v){
  const dp = v>=100 ? 0 : v>=1 ? 2 : v>=0.01 ? 4 : 6;
  return '$' + v.toLocaleString('en-US',{minimumFractionDigits:dp, maximumFractionDigits:dp});
}
const n1 = v => (Math.round(v*10)/10).toFixed(1);

function analyse(sym){
  stoch[sym]   = stoch[sym]   || {};
  states[sym]  = states[sym]  || {};
  divsAll[sym] = divsAll[sym] || {};
  divNow[sym]  = divNow[sym]  || {};
  for(const tf of TFS){
    const c = data[sym] && data[sym][tf.key];
    if(!c) continue;
    const high=c.map(x=>x.h), low=c.map(x=>x.l), close=c.map(x=>x.c);
    const s = stochastic(high, low, close, 5, 3, 3);
    const openT = c[c.length-1].t, closeT = barClose(tf, openT);
    const liveBar = Date.now() < closeT ? c.length-1 : -1;
    const behind  = liveBar<0 && (Date.now()-closeT) > (tf.ms || 2678400e3)*0.5;
    stoch[sym][tf.key]   = {...s, candles:c, liveBar, openT, closeT, behind, ema:emaRead(close)};
    states[sym][tf.key]  = crossState(s.k, s.d, 4, liveBar);
    divsAll[sym][tf.key] = divergences(s.k, s.d, high, low, {});
    divNow[sym][tf.key]  = currentDivergence(divsAll[sym][tf.key], s.k);
  }
}
