/* indicators.js — Indicator maths. Pure functions over price arrays — stochastic (5,3,3), crosses,
   swings, divergence, the 200 EMA. No DOM, no network, no app state: everything here
   can be unit-tested on synthetic candles.
   part of Odysseus */
/* ==MATH_START== */
function sma(arr, p){
  const out = new Array(arr.length).fill(null);
  let sum = 0, count = 0;
  for(let i=0;i<arr.length;i++){
    const v = arr[i];
    if(v===null||v===undefined||Number.isNaN(v)){ sum=0; count=0; continue; }
    sum += v; count++;
    if(count>p){ sum -= arr[i-p]; count=p; }
    if(count===p) out[i] = sum/p;
  }
  return out;
}

function stochastic(high, low, close, kLen, kSmooth, dLen){
  const n = close.length;
  const raw = new Array(n).fill(null);
  for(let i=kLen-1;i<n;i++){
    let hh=-Infinity, ll=Infinity;
    for(let j=i-kLen+1;j<=i;j++){
      if(high[j]>hh) hh=high[j];
      if(low[j]<ll) ll=low[j];
    }
    raw[i] = (hh===ll) ? 50 : ((close[i]-ll)/(hh-ll))*100;
  }
  const k = sma(raw, kSmooth);
  const d = sma(k, dLen);
  return {k, d};
}

function zoneOf(v){
  if(v<=20) return 'oversold';
  if(v<80)  return 'middle';
  return 'overbought';
}

function crossQuality(dir, level){
  const z = zoneOf(level);
  if(dir==='bull'){
    if(z==='oversold') return {zone:z, note:'strongest — turning up from oversold'};
    if(z==='middle')   return {zone:z, note:'continuation through the middle'};
    return {zone:z, note:'stretched — overbought already'};
  }
  if(z==='overbought') return {zone:z, note:'strongest — rolling over from overbought'};
  if(z==='middle')     return {zone:z, note:'continuation through the middle'};
  return {zone:z, note:'stretched — oversold already'};
}

// Every cross in the series, oldest first.
function crossPoints(k, d){
  const out = [];
  for(let i=1;i<k.length;i++){
    if(k[i]===null||d[i]===null||k[i-1]===null||d[i-1]===null) continue;
    const now = k[i]-d[i], prev = k[i-1]-d[i-1];
    if(prev<=0 && now>0)      out.push({i, dir:'bull', level:(k[i]+d[i])/2});
    else if(prev>=0 && now<0) out.push({i, dir:'bear', level:(k[i]+d[i])/2});
  }
  return out;
}

function gapSeries(k, d, n){
  const out = [];
  for(let i=Math.max(0,k.length-n);i<k.length;i++){
    out.push(k[i]===null||d[i]===null ? null : k[i]-d[i]);
  }
  return out;
}

/*  The most recent cross, however far back it is — no lookback window, so what
    the app reports is the same cross you can see on the chart. `fresh` says
    whether it is recent enough to act on; `pending` whether its bar is open.  */
function crossState(k, d, freshWithin, liveBar, cfg){
  const c = cfg || {};
  const nearGap  = c.nearGap  === undefined ? 6 : c.nearGap;   // how close counts as near
  const nearBars = c.nearBars === undefined ? 3 : c.nearBars;  // and how soon it would meet
  const last = k.length-1;
  if(last<3||k[last]===null||d[last]===null) return {type:'none'};
  const gap = Math.abs(k[last]-d[last]);

  const pts = crossPoints(k, d);
  if(!pts.length){
    // never crossed in the loaded history — still worth flagging if it is
    // currently sitting at a stochastic extreme
    const z0 = zoneOf(k[last]);
    if(z0 !== 'middle') return {
      type: z0==='oversold' ? 'watch-bull' : 'watch-bear',
      dir: z0==='oversold' ? 'bull' : 'bear',
      watching:true, pending:false, level:k[last], k:k[last], d:d[last], gap, barsAgo:0
    };
    return {type:'flat', gap, level:k[last], k:k[last], d:d[last]};
  }

  const p = pts[pts.length-1];
  const barsAgo = last - p.i;
  const pending = p.i === liveBar;

  // a cross that has already printed takes precedence over one merely approaching
  if(pending || barsAgo <= freshWithin){
    return {
      type: (pending ? 'potential-' : '') + p.dir,
      dir: p.dir, pending, barsAgo, level: p.level,
      fresh: barsAgo <= freshWithin,
      at: p.i, k: k[last], d: d[last], gap
    };
  }

  /*  No recent cross, so look at where %K is heading. It counts as approaching
      only when %K is itself turning toward %D — a shrinking gap caused by %D
      drifting into a flat %K is not %K pointing at anything.                */
  const g0 = k[last]-d[last], g1 = k[last-1]-d[last-1];
  const kSlope = k[last]-k[last-1];
  const closing = Math.abs(g0) < Math.abs(g1);
  const pointing = g0 < 0 ? kSlope > 0 : kSlope < 0;
  const speed = Math.abs(g1)-Math.abs(g0);
  const eta = speed > 0 ? gap/speed : Infinity;

  if(gap >= 0.2 && closing && pointing && (gap <= nearGap || eta <= nearBars)){
    return {
      type: g0 < 0 ? 'nearing-bull' : 'nearing-bear',
      dir: g0 < 0 ? 'bull' : 'bear',
      nearing: true, pending: false, gap, speed, eta,
      level: k[last], k: k[last], d: d[last],
      barsAgo, at: p.i, fresh: false
    };
  }

  /*  Nothing crossed and nothing is visibly turning toward %D — but if price
      is sitting at a stochastic extreme right now, that alone is a potential
      reversal worth flagging (oversold → watch for a bull cross, overbought
      → watch for a bear cross), which is more useful than reporting however
      old the last actual cross happened to be. `fresh` is deliberately left
      unset rather than false: this isn't a stale cross, so it should not be
      greyed out the way one is.                                            */
  const zNow = zoneOf(k[last]);
  if(zNow !== 'middle'){
    return {
      type: zNow==='oversold' ? 'watch-bull' : 'watch-bear',
      dir: zNow==='oversold' ? 'bull' : 'bear',
      watching:true, pending:false, level:k[last], k:k[last], d:d[last], gap, barsAgo
    };
  }

  // otherwise report the last cross as before, however old it is
  return {
    type: p.dir, dir: p.dir, pending:false, barsAgo, level: p.level,
    fresh: false, at: p.i, k: k[last], d: d[last], gap
  };
}

function sideOf(s){
  if(!s) return 0;
  const w = s.fresh===false ? 0.5 : 1;
  switch(s.type){
    case 'bull': return 1*w;
    case 'bear': return -1*w;
    case 'potential-bull': return 0.6;
    case 'potential-bear': return -0.6;
    case 'nearing-bull': return 0.35;      // leaning, not yet a signal
    case 'nearing-bear': return -0.35;
    case 'watch-bull': return 0.25;        // sitting at an extreme, no cross yet at all
    case 'watch-bear': return -0.25;
    case 'flat': return s.level>=50 ? 0.4 : -0.4;
    default: return 0;
  }
}

// Index of the local extreme of `arr` within `span` bars either side of i.
function swingAt(arr, i, span, kind){
  let best = i;
  const lo = Math.max(0, i-span), hi = Math.min(arr.length-1, i+span);
  for(let j=lo;j<=hi;j++){
    if(arr[j]===null) continue;
    if(arr[best]===null || (kind==='low' ? arr[j] < arr[best] : arr[j] > arr[best])) best = j;
  }
  return best;
}

/*  A leg runs from one cross to the next. Its height is the extreme the LINES
    reached during that leg — the highest point of %K or %D for a top, the
    lowest for a bottom — NOT the level where the two lines crossed. The price
    anchor is the actual high or low of that same leg.                        */
function swings(k, d, high, low, includeForming){
  const pts = crossPoints(k, d);
  const out = [];

  const leg = (from, to, kind, provisional) => {
    let kIdx=null, level=null, priceIdx=null, price=null;
    for(let j=Math.max(0,from);j<=to;j++){
      if(k[j]===null) continue;
      const v = k[j];                       // %K only — it always reaches further than %D
      if(level===null || (kind==='high' ? v>level : v<level)){ level=v; kIdx=j; }
      const q = kind==='high' ? high[j] : low[j];
      if(price===null || (kind==='high' ? q>price : q<price)){ price=q; priceIdx=j; }
    }
    return kIdx===null ? null : {kIdx, level, priceIdx, price, kind, provisional:!!provisional};
  };

  for(let n=0;n<pts.length;n++){
    // a bear cross closes an up-leg, so that leg holds a top; a bull cross closes a bottom
    const from = n>0 ? pts[n-1].i : 0;
    const sw = leg(from, pts[n].i, pts[n].dir==='bear' ? 'high' : 'low', false);
    if(sw){ sw.cross = pts[n].i; out.push(sw); }
  }

  // the leg still building past the last cross, for a divergence not yet set
  if(includeForming && pts.length){
    const lastP = pts[pts.length-1];
    const kind = lastP.dir==='bull' ? 'high' : 'low';
    const sw = leg(lastP.i, k.length-1, kind, true);
    const last = k.length-1;
    if(sw && sw.kIdx > lastP.i && sw.kIdx < last && k[last]!==null && d[last]!==null){
      // only once the leg has topped or bottomed and the lines have come off it
      const now = k[last];
      if(Math.abs(sw.level - now) >= 3){ sw.cross = last; out.push(sw); }
    }
  }
  return out;
}

/*  A divergence line is only valid if nothing between its two ends breaks it:
    for a bullish line every bar in between must sit at or above it, for a
    bearish line at or below it. A lower low poking through the middle voids it. */
function unbroken(at, i1, i2, v1, v2, kind, tol){
  if(i2-i1 < 2) return true;
  for(let j=i1+1;j<i2;j++){
    const v = at(j);
    if(v===null||v===undefined) continue;
    const line = v1 + (v2-v1)*((j-i1)/(i2-i1));
    const slack = typeof tol==='function' ? tol(line) : tol;
    if(kind==='low' ? v < line - slack : v > line + slack) return false;
  }
  return true;
}

/*  Divergence compares leg heights. Two kinds:

      regular  — the reversal kind. Bullish: price lows FALLING while the
                 stochastic bottoms RISE. Bearish: price highs rising while
                 the tops fall. Price is pushing on, the oscillator is not
                 confirming.
      hidden   — the continuation kind. Bullish: price holds a HIGHER low while
                 the stochastic makes a LOWER low — the pullback went deeper on
                 the oscillator than on price, which is what a pullback in an
                 uptrend looks like when the trend is intact. Bearish is the
                 mirror: a lower high on price, a higher high on the lines.

    Both chain across legs into ONE run. A hidden run carries hidden:true so
    every reader can tell the two apart — they argue for the same direction
    but from opposite shapes, and the backtest deliberately keeps them apart. */
function divergences(k, d, high, low, cfg){
  const c = cfg || {};
  const minBars = c.minBars === undefined ? 3     : c.minBars;
  const maxBars = c.maxBars === undefined ? 40    : c.maxBars;  // no reaching across the chart
  const minK    = c.minK    === undefined ? 1     : c.minK;     // %K only has to tilt
  const minPct  = c.minPct  === undefined ? 0.001 : c.minPct;
  const maxBack = c.maxBack === undefined ? 3     : c.maxBack;
  const pierce  = c.pierce  === undefined ? 3     : c.pierce;   // slack before a line counts as broken

  const sw = swings(k, d, high, low, true);
  const rejects = [];
  const rej = (p1,p2,dir,why,hidden) => rejects.push({dir, hidden:!!hidden, from:p1.kIdx, to:p2.kIdx, why,
                                                      a:p1, b:p2, level:[p1.level,p2.level]});

  const build = (kind, dir, hidden) => {
    const list = sw.filter(x=>x.kind===kind);
    const legs = [];
    for(let b=1;b<list.length;b++){
      for(let a=b-1;a>=Math.max(0,b-maxBack);a--){
        const p1 = list[a], p2 = list[b];
        const span = p2.kIdx - p1.kIdx;
        const dp = (p2.price-p1.price)/p1.price, dk = p2.level-p1.level;
        /*  The shape test comes first for the hidden pass, silently: every pair
            that is a regular divergence is, by definition, not a hidden one,
            and listing each of those as a "rejected hidden line" would double
            the rejects with noise. Only a hidden-shaped pair that then fails a
            structural check is worth reporting.                             */
        const shape = hidden
          ? (dir==='bull' ? (dp >  minPct && dk < -minK) : (dp < -minPct && dk >  minK))
          : (dir==='bull' ? (dp < -minPct && dk >  minK) : (dp >  minPct && dk < -minK));
        if(hidden && !shape) continue;
        if(span < minBars){ rej(p1,p2,dir,'only '+span+' bars apart', hidden); continue; }
        if(span > maxBars){ rej(p1,p2,dir,span+' bars apart, over the '+maxBars+'-bar limit', hidden); continue; }
        if(!shape){
          rej(p1,p2,dir, Math.abs(dk)<minK ? '%K moved only '+dk.toFixed(1)
            : Math.abs(dp)<minPct ? 'price moved only '+(dp*100).toFixed(2)+'%'
            : 'price and %K moved the same way, not diverging');
          continue;
        }

        // the stochastic line must not be pierced anywhere between the two ends
        const lineOK = unbroken(j => k[j], p1.kIdx, p2.kIdx, p1.level, p2.level, kind, pierce);
        if(!lineOK){ rej(p1,p2,dir,'%K pierces the line between the two ends', hidden); continue; }

        // on price, what matters is not skipping a lower low (or higher high)
        // in between — a curved trend dips under its own chord without making one
        const between = list.slice(a+1, b);
        const priceOK = between.every(mid=>{
          const t = (mid.priceIdx-p1.priceIdx)/(p2.priceIdx-p1.priceIdx || 1);
          const line = p1.price + (p2.price-p1.price)*t;
          const slack = line*0.002;
          return kind==='low' ? mid.price >= line-slack : mid.price <= line+slack;
        });
        if(!priceOK){ rej(p1,p2,dir,'skips a '+(kind==='low'?'lower low':'higher high')+' in between', hidden); continue; }

        legs.push({a:p1, b:p2}); break;
      }
    }
    const runs = [];
    let run = null;
    legs.forEach(leg=>{
      if(run && run.points[run.points.length-1].kIdx === leg.a.kIdx) run.points.push(leg.b);
      else { run = {dir, hidden:!!hidden, points:[leg.a, leg.b]}; runs.push(run); }
    });
    return runs;
  };

  const out = [...build('low','bull'), ...build('high','bear'),
               ...build('low','bull',true), ...build('high','bear',true)];
  out.forEach(x=>{
    x.legs = x.points.length-1;
    x.from = x.points[0].kIdx;
    x.to   = x.points[x.points.length-1].kIdx;
    x.pending = x.points[x.points.length-1].provisional;
  });
  const kept = out.filter(x => !out.some(y =>
    y!==x && y.dir===x.dir && y.hidden===x.hidden && y.from<=x.from && y.to>=x.to && (y.to-y.from) > (x.to-x.from)));
  kept.sort((a,b)=>a.to-b.to);
  const drawn = new Set(kept.flatMap(x=>x.points.map(p=>p.kIdx)));
  kept.rejected = rejects.filter(r=>!(drawn.has(r.from)&&drawn.has(r.to)));
  return kept;
}

// The newest run, whatever its age — the table always shows the last one found,
// and reports how far back it ended so nothing disappears silently.
function currentDivergence(all, k){
  if(!all.length) return null;
  const x = all[all.length-1];
  return {...x, barsAgo: (k.length-1) - x.to};
}

function bias(states, weights){
  let sum = 0, total = 0;
  for(const key in weights){
    total += weights[key];
    sum += sideOf(states[key]) * weights[key];
  }
  return total ? Math.round((sum/total)*100) : 0;
}
/* ==MATH_END== */

/* ---------- EMA 200 trend filter ----------
   Seeded from a simple mean of the first 200 closes, then run forward. Returns
   nulls until there is enough history — plenty of perps and most monthly
   series never reach 200 bars, and a half-seeded EMA is worse than none.    */
function ema(vals, period){
  const out = new Array(vals.length).fill(null);
  if(vals.length < period) return out;
  let sum = 0;
  for(let i=0;i<period;i++) sum += vals[i];
  let prev = sum/period;
  out[period-1] = prev;
  const k = 2/(period+1);
  for(let i=period;i<vals.length;i++){
    prev = vals[i]*k + prev*(1-k);
    out[i] = prev;
  }
  return out;
}

const EMA_LEN = 200;

// price above the 200 is a bullish regime, below it bearish
function emaRead(close){
  const arr = ema(close, EMA_LEN);
  const v = arr[arr.length-1];
  if(v==null) return {ok:false, bars:close.length};
  const px = close[close.length-1];
  return {ok:true, v, arr, above:px>=v, dist:((px-v)/v)*100};
}
