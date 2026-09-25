/* verdict.js — The verdict engine. Turns a live cross into a graded read on the
   trade, measured against what that exact setup has done on this coin before.
   part of Odysseus */

/* ============================================================
   The verdict engine.

   Grades a live cross against what that exact setup has actually done on this
   coin before. Deliberately hard to please: the historical record holds a veto,
   so no amount of BTC agreement or trend alignment can promote a setup whose
   own history says it does not work. Most crosses will not grade well — on the
   measured data hit rates sit near 50% — and saying so plainly is the honest
   output, not a broken one.

   It is deterministic and needs no API key or network call: the app answers "is
   this worth taking" entirely from candles it already holds.
   ============================================================ */

const GRADE_NOTE = {
  'strong':   'The record behind this one is genuinely good.',
  'playable': 'There is an edge here, but it is not overwhelming.',
  'thin':     'Marginal. The edge is small enough that fees and slippage matter.',
  'no edge':  'The history does not support taking this.',
  'negative': 'This setup has lost money more often than not on this coin.',
  'untested': 'Not enough history to judge this setup at all.',
  'no signal':'Nothing has fired on this frame.'
};

function assessTrade(sym, frameKey){
  const st = states[sym] && states[sym][frameKey];
  const out = {symbol:sym, frame:frameKey, span:spanLabel(frameKey, H_MAIN)};

  if(!st || st.level==null || !(st.type==='bull' || st.type==='bear' || st.pending))
    return Object.assign(out, {grade:'no signal', score:null,
      summary:'No cross on '+frameKey+' to judge.'});

  const dir = st.dir, zone = zoneOf(st.level);
  const per = histEdge(sym);
  const b   = per.buckets[frameKey+'|'+dir+'|'+zone];
  const sM  = b && b.sum && b.sum.byH[H_MAIN];
  const n   = b ? b.sum.n : 0;

  Object.assign(out, {
    direction:dir, zone, level:+st.level.toFixed(1),
    settled: !st.pending, barsAgo: st.barsAgo==null ? null : st.barsAgo
  });

  if(!sM || n < 8)
    return Object.assign(out, {grade:'untested', score:null, signals:n,
      summary:'A '+frameKey+' '+dir+' cross from '+zone+' has fired only '+n+' time'+
        (n===1?'':'s')+' in the loaded history on '+sym+' — too few to judge.'});

  // real price direction, not the scoring convention
  const move  = dir==='bull' ? sM.med : -sM.med;
  const hit   = sM.win;
  const edgeX = bucketEdge(b);
  const thin  = n < 30;
  const reasons = [], warnings = [];
  let score = 0;

  score += (hit - 50) * 1.2;
  if(hit >= 55) reasons.push('has been right '+hit+'% of '+n+' past tries');
  if(hit <= 45) warnings.push('has been right only '+hit+'% of '+n+' past tries');

  if(isFinite(edgeX)){
    score += Math.max(-1, Math.min(edgeX, 3)) * 8;
    if(edgeX >= 1.5) reasons.push('moves '+edgeX.toFixed(1)+'x what an ordinary '+frameKey+' cross does');
    else if(edgeX <= 0.5) warnings.push('barely outruns an ordinary '+frameKey+' cross');
  }

  // divergence is credited on measured uplift, not on being present
  const dv = divNow[sym] && divNow[sym][frameKey];
  const bk = b.backed && b.backed.byH[H_MAIN];
  let divergence = null;
  if(dv && dv.dir === dir && (dv.pending || dv.barsAgo <= 12)){
    const uplift = (bk && bk.n >= 3) ? bk.med - sM.med : null;
    divergence = {present:true, hidden:!!dv.hidden, legs:dv.legs+1, settled:!dv.pending,
                  backedSamples: bk ? bk.n : 0,
                  upliftPoints: uplift==null ? null : +uplift.toFixed(2)};
    if(dv.hidden){
      score += 4;  reasons.push('hidden divergence under it — the pullback ran deeper on the lines than on price, the continuation shape; not credited like a regular one because the record does not measure it');
    } else if(uplift != null && uplift > 0){
      score += 14; reasons.push('divergence backing it, worth '+uplift.toFixed(2)+' extra points historically');
    } else if(uplift != null){
      score += 2;  warnings.push('divergence is present but has not helped this setup before');
    } else {
      score += 5;  reasons.push('divergence backing it (too few backed samples to price)');
    }
  }

  let btcTone = null;
  if(sym !== BTC && states[BTC]){
    const bv = btcVerdict(dir, frameKey);
    btcTone = bv.tone;
    if(bv.tone === 'up'){   score += 12; reasons.push('BTC is pointing the same way'); }
    if(bv.tone === 'down'){ score -= 15; warnings.push('it is fighting BTC'); }
  }

  const er = stoch[sym] && stoch[sym][frameKey] && stoch[sym][frameKey].ema;
  let emaTone = null;
  if(er && er.ok){
    emaTone = er.above ? 'above' : 'below';
    if((dir==='bull' && er.above) || (dir==='bear' && !er.above)){
      score += 10; reasons.push('running with the 200 EMA');
    } else {
      score -= 12; warnings.push('counter-trend against the 200 EMA');
    }
  }

  if(st.pending){ score -= 6; warnings.push('still on the live bar, so it can unwind before close'); }
  else score += 6;

  if(thin){ score -= 10; warnings.push('thin sample at '+n+' signals'); }
  else score += 8;

  score = Math.round(score);

  /*  Grade, then let the record veto it. Confluence is allowed to improve a
      setup that already works; it is never allowed to rescue one that does
      not. Without this a coin-flip cross with BTC and the 200 onside would
      read "strong", which is how a backtest turns into a losing habit.      */
  let grade = score >= 35 ? 'strong'
            : score >= 15 ? 'playable'
            : score >= 0  ? 'thin'
            : 'no edge';
  if(hit <= 50 && move <= 0)        grade = 'negative';
  else if(hit < 50)                 grade = 'no edge';
  if(grade === 'strong' && (hit < 55 || thin)) grade = 'playable';

  const dirWord = move >= 0 ? 'up' : 'down';
  const summary =
    frameKey+' '+dir+' cross from '+zone+' on '+sym+': '+grade.toUpperCase()+'. '+
    'This setup has been right '+hit+'% of '+n+' times, median '+
    (move>=0?'+':'')+move.toFixed(2)+'% ('+dirWord+') over the '+spanLabel(frameKey,H_MAIN)+
    ' after the cross. '+GRADE_NOTE[grade];

  return Object.assign(out, {
    grade, score, signals:n, thinSample:thin,
    hitRate: hit+'%',
    medianMove: (move>=0?'+':'')+move.toFixed(2)+'%',
    beatsOrdinaryCross: isFinite(edgeX) ? +edgeX.toFixed(2) : null,
    byHorizon: horizonTable(b.sum.byH, frameKey),
    divergence, btc:btcTone, ema200:emaTone,
    reasons, warnings, summary
  });
}

// the best live cross on a coin, heaviest frame winning ties
function bestTrade(sym){
  const ranked = TRADE_ORDER.slice();
  let best = null;
  TFS.forEach(tf=>{
    const a = assessTrade(sym, tf.key);
    if(a.grade === 'no signal') return;
    const r = ranked.indexOf(a.grade), br = best ? ranked.indexOf(best.grade) : -1;
    if(!best || r > br || (r === br && tf.weight > TFS.find(t=>t.key===best.frame).weight)) best = a;
  });
  return best;
}
const TRADE_ORDER = ['no signal','negative','no edge','untested','thin','playable','strong'];

/*  The per-horizon breakdown that rides along with every assessment. It used to
    live in logan.js, because the agent was its only caller; it is the verdict
    engine's own arithmetic and belongs here, and moving it is what let the agent
    layer be deleted without taking the grading with it.                       */
function horizonTable(byH, frame){
  return HORIZONS.reduce((o,h)=>{
    const st = byH && byH[h];
    o[spanLabel(frame,h)] = st ? {hit:st.win+'%', median:st.med+'%', samples:st.n} : null;
    return o;
  },{});
}
