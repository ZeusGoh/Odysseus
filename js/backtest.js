/* backtest.js — Signal history — the backtest engine. Replays every past cross, scores what price
   did over 1/3/5/7 bars, and buckets the results by frame and setup.
   part of VL */

/* ---------- signal history ----------
   Every cross the engine can see in the loaded history is replayed and scored
   by what price actually did next. Because we hold a thousand bars, this does
   not need weeks of waiting — the record already exists in the data.
   Returns are direction-adjusted: a bear cross that is followed by a fall is
   a win, so positive always means the signal was right.                     */
/*  A (5,3,3) stochastic completes a full oversold-to-overbought traverse in
    roughly four bars. Scoring a cross at 10, 20 and 50 bars was therefore not
    measuring the signal at all — by then it had finished, reversed, and started
    over, so every row collapsed toward a coin flip. These horizons sit inside
    the life of the signal instead: 1 and 3 while it is still unfolding, 5 just
    past a typical traverse, 7 for whether it kept going.

    Everything downstream reads this array — both history tables, their headers
    and grid widths, Logan's context, and the live badge on each cross — so
    changing it here changes all of them. Nothing hardcodes a horizon.        */
const HORIZONS = [1, 3, 5, 7];

// the horizon used wherever a single headline number is needed
const H_MAIN = HORIZONS[Math.floor(HORIZONS.length/2)];
const barsLabel = h => h === 1 ? '1 bar' : h + ' bars';

/*  A horizon is counted in bars, but a bar is not the same amount of time on
    every frame: seven bars is seven hours on 1H and seven months on 1M. The
    column headers can only say "7 bars", because every row underneath them is
    a different frame — so each row prints its own real span instead, and the
    tooltip spells the columns out in full. Without this, one header means five
    different durations at once and the table quietly misleads.              */
const FRAME_UNIT = {
  '1H': {per:1, unit:'hour',  short:'h'},
  '4H': {per:4, unit:'hour',  short:'h'},
  '1D': {per:1, unit:'day',   short:'d'},
  '1W': {per:1, unit:'week',  short:'w'},
  '1M': {per:1, unit:'month', short:'mo'}
};
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

// "3 days" — one horizon on one frame, spelled out
function spanLabel(key, h){
  const u = FRAME_UNIT[key];
  return u ? plural(h*u.per, u.unit) : barsLabel(h);
}
// "12h" — the same thing, compact, for the badge on a live cross
function spanShort(key, h){
  const u = FRAME_UNIT[key];
  return u ? (h*u.per)+u.short : h+'b';
}
// "4–28 hours" — the whole horizon set on one frame
function spanRange(key){
  const u = FRAME_UNIT[key];
  if(!u) return '';
  const lo = HORIZONS[0]*u.per, hi = HORIZONS[HORIZONS.length-1]*u.per;
  return lo+'–'+plural(hi, u.unit);
}
function spanBreakdown(key){
  return HORIZONS.map(h=>barsLabel(h)+' = '+spanLabel(key,h)).join(' · ');
}

/*  A swing is only *visible* once the cross that closes its leg has printed —
    swings() records that bar as `cross`. A divergence is therefore knowable at
    the bar its final swing was confirmed, not at the bar the swing sits on.  */
function divKnownAt(x){
  const pts = x.points || [];
  const last = pts[pts.length-1];
  return (last && last.cross != null) ? last.cross : x.to;
}

function replayCrosses(candles, k, d, opts){
  const o = opts || {};
  const pts = crossPoints(k, d);
  const divs = divergences(k, d, candles.map(c=>c.h), candles.map(c=>c.l), {});
  const out = [];
  const maxH = HORIZONS[HORIZONS.length-1];

  /*  The final candle is still forming while the market is open, so its close
      moves. Scoring a signal against it makes the newest rows in the table
      change under you between refreshes, and quietly counts a price that
      never settled. Anything reaching into the live bar is left unscored.   */
  const lastClosed = (o.liveBar != null && o.liveBar >= 0)
    ? o.liveBar - 1 : candles.length - 1;

  pts.forEach(p=>{
    if(p.i + maxH > lastClosed) return;            // not enough settled future to judge it
    const entry = candles[p.i].c;
    if(!isFinite(entry) || entry<=0) return;
    const rets = {};
    HORIZONS.forEach(h=>{
      const fut = candles[p.i+h];
      if(!fut){ rets[h] = null; return; }
      const raw = (fut.c - entry)/entry*100;
      rets[h] = p.dir==='bull' ? raw : -raw;       // so + always means the call was right
    });
    /*  Was a divergence already on the screen when this cross fired? The old
        test used Math.abs, which let a divergence that only completed AFTER
        the cross count as having backed it — information the trader could not
        have had. It has to be confirmed at or before the cross bar, settled
        rather than still forming, and recent enough to still be the reason.  */
    const backed = divs.some(x=>{
      if(x.dir !== p.dir || x.pending) return false;
      const known = divKnownAt(x);
      return known <= p.i && (p.i - known) <= 3;
    });
    out.push({i:p.i, t:candles[p.i].t, dir:p.dir, level:p.level,
              zone:zoneOf(p.level), backed, entry, rets});
  });
  return out;
}

function summarise(rows){
  if(!rows.length) return null;
  const stat = h => {
    const vals = rows.map(r=>r.rets[h]).filter(v=>v!=null && isFinite(v));
    if(!vals.length) return null;
    const sorted = [...vals].sort((a,b)=>a-b);
    const med = sorted.length%2 ? sorted[(sorted.length-1)/2]
                                : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;
    const wins = vals.filter(v=>v>0).length;
    return {n:vals.length, win:Math.round(wins/vals.length*100),
            med:+med.toFixed(2), avg:+(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2)};
  };
  const byH = {};
  HORIZONS.forEach(h=> byH[h] = stat(h));
  return {n:rows.length, byH};
}

/*  Group the replay by the distinctions that plausibly matter: which frame,
    which direction, which zone the cross fired in, and whether divergence
    backed it.                                                              */
/*  The typical size of a move on this frame, used to judge a setup against
    its own frame rather than against the clock. Seven bars on the monthly is
    years of price; seven on the hourly is an afternoon. Ranking raw percentages
    across frames therefore just sorts by bar length, which is why the slowest
    frames always floated to the top of the setup table regardless of quality. */
function frameBaseline(rows){
  const vals = rows.map(r=>r.rets[H_MAIN])
                   .filter(v=>v!=null && isFinite(v))
                   .map(Math.abs)
                   .sort((a,b)=>a-b);
  if(!vals.length) return null;
  const m = vals.length >> 1;
  const med = vals.length%2 ? vals[m] : (vals[m-1]+vals[m])/2;
  return med > 0 ? med : null;
}

// how far a setup beats what its own frame does on an ordinary cross
function bucketEdge(b){
  const st = b && b.sum && b.sum.byH[H_MAIN];
  if(!st || !b.baseline) return -Infinity;
  return st.med / b.baseline;
}

function historyFor(sym, frameKeys){
  const keys = frameKeys || TFS.map(t=>t.key);
  const out = {frames:{}, buckets:{}, total:0};
  keys.forEach(key=>{
    const st = stoch[sym] && stoch[sym][key];
    if(!st || !st.candles) return;
    const rows = replayCrosses(st.candles, st.k, st.d, {liveBar: st.liveBar});
    const baseline = frameBaseline(rows);
    out.frames[key] = {all: summarise(rows), rows, baseline};
    out.total += rows.length;

    ['bull','bear'].forEach(dir=>{
      ['oversold','middle','overbought'].forEach(zone=>{
        const sel = rows.filter(r=>r.dir===dir && r.zone===zone);
        if(sel.length < 3) return;                    // too few to say anything
        out.buckets[key+'|'+dir+'|'+zone] = {
          frame:key, dir, zone, baseline, sum:summarise(sel),
          backed: summarise(sel.filter(r=>r.backed))
        };
      });
    });
  });
  return out;
}
