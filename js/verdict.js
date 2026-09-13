/* verdict.js — The verdict engine. Turns the panel's own numbers into a graded read on a trade,
   and the offline reader Logan falls back to when there is no API key.
   part of VL */

/* ---------- Logan, offline ----------
   A deterministic reader. Not a language model: it walks the same numbers the
   panel shows and states what they say, including what the signal history says
   about this kind of setup. Free, instant, offline, and it cannot invent a
   figure — but it only answers the questions it was taught to answer.       */
/* ============================================================
   The verdict engine.

   Grades a live cross against what that exact setup has actually done on this
   coin before. Deliberately hard to please: the historical record holds a veto,
   so no amount of BTC agreement or trend alignment can promote a setup whose
   own history says it does not work. Most crosses will not grade well — on the
   measured data hit rates sit near 50% — and saying so plainly is the honest
   output, not a broken one.

   It is deterministic and needs no API key, so the app can answer "is this
   worth taking" on its own. Logan gets the same engine as a tool, so when a key
   is connected he reasons from a scored assessment rather than eyeballing.
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
    divergence = {present:true, legs:dv.legs+1, settled:!dv.pending,
                  backedSamples: bk ? bk.n : 0,
                  upliftPoints: uplift==null ? null : +uplift.toFixed(2)};
    if(uplift != null && uplift > 0){
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
    byHorizon: lgHorizons(b.sum.byH, frameKey),
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

/*  The question names a coin more often than not, and answering about whatever
    happens to be open instead is worse than useless — it looks like an answer. */
function findTicker(text){
  const pool = UNIVERSE || SYMBOLS;
  const stop = new Set(['CAN','YOU','READ','THE','FOR','AND','WHAT','IS','IT','ME','MY','ON','OF',
    'TO','DO','GOOD','BAD','TRADE','BUY','SELL','NOW','THIS','THAT','ANY','GIVE','SHOW','HOW',
    'ABOUT','WORTH','SETUP','COIN','PLEASE','PLS','OK','LOOK','AT','CHECK','TELL','WITH','ARE',
    'SHOULD','WOULD','COULD','TAKE','LONG','SHORT','IN','OUT','UP','DOWN','GET','GOT','SEE','WIN']);
  const words = String(text||'').toUpperCase().match(/[A-Z0-9]{2,12}/g) || [];
  for(const w of words){
    if(stop.has(w)) continue;
    if(pool.some(s=>s.sym === w)) return w;
  }
  return null;
}

// the no-key path: load whatever coin was asked about, then read it
async function offlineAnswer(text){
  const want = findTicker(text);
  let sym = active;
  if(want && want !== active){
    try{ sym = await lgEnsureCoin(want); }catch(e){ sym = active; }
  }
  return offlineRead(sym, want && want !== sym ? null : text);
}

/*  The built-in reader. No API key, no model — fixed rules over the panel's own
    numbers. It now leads with the verdict, because "is this worth taking" is
    the question actually being asked, and it reads whichever coin the question
    named rather than whichever one happens to be open.                       */
function offlineRead(symArg, text){
  const sym = symArg || active, meta = symbolOf(sym);
  const st = states[sym];
  if(!st) return 'No data loaded for '+meta.sym+' yet.';
  const out = [];

  // 1. the verdict, first
  const v = bestTrade(sym);
  if(v && v.grade !== 'no signal'){
    out.push(v.summary);
    if(v.reasons && v.reasons.length)   out.push('For it: '+v.reasons.join('; ')+'.');
    if(v.warnings && v.warnings.length) out.push('Against it: '+v.warnings.join('; ')+'.');
    const others = TFS.map(t=>assessTrade(sym, t.key))
      .filter(a=>a.grade!=='no signal' && a.frame!==v.frame && a.score!=null)
      .map(a=>a.frame+' '+a.direction+' '+a.grade);
    if(others.length) out.push('Other frames with something live: '+others.join('; ')+'.');
  } else {
    out.push('Nothing has crossed on '+meta.sym+' recently, so there is no setup to grade.');
  }

  // 2. the composite
  const score = bias(st, WEIGHTS);
  const dirWord = score>8 ? 'bullish' : score<-8 ? 'bearish' : 'mixed';
  const agree = TFS.filter(t=>{ const x=sideOf(st[t.key]); return score>=0 ? x>0 : x<0; });
  out.push(meta.sym+' reads '+dirWord+' overall, composite '+(score>0?'+':'')+score+
    (dirWord==='mixed' ? '. The frames disagree, which is usually a reason to wait rather than pick a side.'
      : ', with '+agree.length+' of 5 frames pointing the same way'+
        (agree.some(t=>t.weight>=4) ? ', including the slow ones that carry the most weight.'
                                    : ', though only the fast frames — the monthly and weekly are not confirming.')));

  // 3. what actually fired
  const fired = TFS.map(t=>({t, s:st[t.key]}))
    .filter(x=>x.s && (x.s.type==='bull'||x.s.type==='bear'||x.s.pending));
  if(fired.length){
    out.push('Crosses on the board: '+fired.map(x=>{
      const d = x.s.dir==='bull' ? 'bull' : 'bear';
      return x.t.key+' '+d+' cross at %K '+x.s.level.toFixed(1)+' ('+zoneOf(x.s.level)+
        (x.s.pending ? ', still on the live bar'
                     : ', settled '+(x.s.barsAgo===0 ? 'on the last closed bar'
                                   : x.s.barsAgo===1 ? '1 bar ago' : x.s.barsAgo+' bars ago'))+')';
    }).join('; ')+'.');
  } else {
    const near = TFS.map(t=>({t, s:st[t.key]})).filter(x=>x.s && x.s.nearing);
    out.push(near.length
      ? 'No cross yet, but '+near.map(x=>x.t.key+' has %K turning '+
          (x.s.dir==='bull'?'up into':'down into')+' %D from '+x.s.gap.toFixed(1)+' away').join('; ')+
          '. That is a lean, not a signal.'
      : 'No cross on any frame in the last few bars, and %K is not turning into %D anywhere.');
  }

  // 4. divergence
  const dvs = TFS.map(t=>({t, d:divNow[sym] && divNow[sym][t.key]}))
    .filter(x=>x.d && (x.d.pending || x.d.barsAgo<=12));
  if(dvs.length)
    out.push('Divergence: '+dvs.map(x=>x.t.key+' '+x.d.dir+', a run across '+(x.d.legs+1)+' swings'+
      (x.d.pending?' still forming':'')).join('; ')+'.');

  // 5. the market itself
  if(sym!==BTC && states[BTC]){
    const al = alignBtc(st);
    if(al.n) out.push(al.pct>=40
      ? 'This is running with BTC on '+al.agree+' of '+al.n+' frames, which is the condition you normally want before taking an alt.'
      : al.pct<=-40
      ? 'This is fighting BTC on '+al.clash+' of '+al.n+' frames. Taking it means betting against the market driver.'
      : 'Against BTC it is split — '+al.agree+' frames with, '+al.clash+' against.');
  }

  // 6. the 200
  const emaFrames = TFS.filter(t=>stoch[sym][t.key] && stoch[sym][t.key].ema && stoch[sym][t.key].ema.ok);
  if(emaFrames.length){
    const above = emaFrames.filter(t=>stoch[sym][t.key].ema.above);
    out.push('Price sits above the 200 EMA on '+above.length+' of '+emaFrames.length+' frames'+
      (above.length===emaFrames.length ? ' — a clean bullish regime.'
        : above.length===0 ? ' — a bearish regime throughout, so bull crosses here are counter-trend.' : '.'));
  }

  out.push('— Built-in reader: fixed rules over the panel, no reasoning and no tools. '+
    'Connect an API key above and Logan answers this himself, checking other coins and the record as he goes. '+
    'The trade decision and the risk stay yours either way.');
  return out.join('\n\n');
}

// a compact briefing the user can paste into a Claude conversation
function briefing(){
  const c = loganContext();
  const L = [];
  L.push('VL terminal snapshot — '+c.symbol+' ('+c.name+') on '+c.venue);
  L.push('Price '+(c.price!=null?fmtUsd(c.price):'n/a')+', composite '+c.composite+' (weighted -100..100, 1M=5 down to 1H=1)');
  L.push('');
  L.push('Frames (stochastic 5,3,3):');
  c.frames.forEach(f=>{
    L.push('  '+f.frame+'  K '+f.K+' / D '+f.D+'  spread '+f.spread+'  zone '+f.zone+
      '  signal '+f.signal+(f.settled===false?' UNSETTLED':'')+
      (f.barsSinceCross!=null?' ('+f.barsSinceCross+' bars ago)':'')+
      (f.divergence?'  divergence '+f.divergence.direction+' x'+f.divergence.legs+
        (f.divergence.settled?'':' forming'):''));
  });
  if(states[BTC] && active!==BTC){
    const al = alignBtc(states[active]);
    L.push('');
    L.push('Versus BTC: '+al.agree+' frames agree, '+al.clash+' disagree (alignment '+al.pct+')');
  }
  const em = TFS.filter(t=>stoch[active][t.key] && stoch[active][t.key].ema && stoch[active][t.key].ema.ok);
  if(em.length){
    const ab = em.filter(t=>stoch[active][t.key].ema.above).map(t=>t.key);
    const be = em.filter(t=>!stoch[active][t.key].ema.above).map(t=>t.key);
    L.push('200 EMA: above on '+(ab.length?ab.join(','):'none')+
           ' | below on '+(be.length?be.join(','):'none'));
  }
  const h = historyFor(active);
  const rows = Object.values(h.buckets).filter(b=>b.sum.n>=10 && b.sum.byH[H_MAIN])
    .sort((a,b)=>b.sum.byH[H_MAIN].med-a.sum.byH[H_MAIN].med).slice(0,6);
  if(rows.length){
    L.push('');
    L.push('Signal history on this coin, measured '+barsLabel(H_MAIN)+' after the cross '+
           '(direction-adjusted; the real span differs per frame and is shown on each row):');
    rows.forEach(b=>L.push('  '+b.frame+' '+b.dir+' from '+b.zone+
      ' ['+spanLabel(b.frame, H_MAIN)+']  n='+b.sum.n+
      '  hit '+b.sum.byH[H_MAIN].win+'%  median '+b.sum.byH[H_MAIN].med+'%'));
  }
  if(watch.length){
    L.push('');
    L.push('Watchlist: '+watch.map(code=>code+(states[code]?' '+bias(states[code],WEIGHTS):'')).join(', '));
  }
  L.push('');
  L.push('Rules: direction alone decides a cross; zones grade quality not direction (oversold 0-20, middle 21-79, overbought 80-100); divergence heights come off %K only and a line is void if %K cuts through it.');
  return L.join('\n');
}
