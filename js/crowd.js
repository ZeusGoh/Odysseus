/* crowd.js — Crowd. Sweeps the perp board for positioning: who is long, who
   is short, how crowded they are, and whether they are being paid or
   punished for it.

   The stochastic scanner asks whether a coin is turning. This one asks who
   is on which side and what it costs them to stay there. Four inputs, read
   together rather than one at a time:

     funding      what longs pay shorts (or the reverse) per 8h — the price
                  of holding the crowded side
     open interest  how much leverage is on the book, and whether it is
                  being added or unwound
     long/short   the share of accounts long — retail positioning, which is
                  the crowd that gets squeezed
     price        what all of that is doing to the tape

   Price up on rising OI with cheap funding is fresh money. Price up on
   falling OI is shorts being forced out, which ends when the shorts run
   out. Price flat on rising OI with expensive funding is a crowd paying to
   hold a position that is not working — that is fuel, and the tag says for
   which side. Each read is one of four kinds, and every point of the score
   is traceable to a line in the row's `why`, same as the scanner.

   Public endpoints only, the same book market-data.js reads. Nothing here
   knows what the stochastic says — the two scanners are meant to be read
   side by side, and the Analyst's news side already reads OI and funding
   the same way (news.js's nvFlow is reused, not copied).
   part of Odysseus */

/* ---------- config ---------- */
const CROWD_POOL = 8;
const CROWD_MIN_TURNOVER = 5e6;       // under this a funding print is noise, not a crowd
const CROWD_MIN_SCORE = 12;           // below this there is no read worth a row

const crowdCfg = {side:'both', depth:50, kind:'any'};
let crowdRows = [], crowding = false, crowdAbort = false, crowdRan = false;
let lastCrowd = null, crowdBtc = null;

/* ==CROWD_START== */
/*  Thresholds, in one place. Funding is per 8h as a percentage (0.05 = 0.05%
    per 8h ≈ 55% a year). Negative funding is rarer, so its bar is lower. The
    long/short ratio is the share of accounts long; alts run long-biased at
    rest, so "heavy long" starts above 0.65, not 0.5.                       */
const CROWD = {
  fundLong: 0.05,  fundLongX: 0.10,     // crowded / extreme, longs paying
  fundShort: -0.03, fundShortX: -0.075, // crowded / extreme, shorts paying
  ratioLong: 0.65, ratioLongX: 0.75,
  ratioShort: 0.40, ratioShortX: 0.32,
  move: 2,          // a 24h price move that counts, %
  oiUp: 3,          // an OI change that counts, %
  oiBuild: 5,       // OI building on a flat price, %
  flat: 1.5,        // "flat" price, %
  overhang: 1.5,    // OI value / 24h turnover past which moves get sharp
};

function crowdFundingRead(pct){
  if(pct == null || !isFinite(pct)) return {side:null, level:0};
  if(pct >= CROWD.fundLongX)  return {side:'long',  level:2};
  if(pct >= CROWD.fundLong)   return {side:'long',  level:1};
  if(pct <= CROWD.fundShortX) return {side:'short', level:2};
  if(pct <= CROWD.fundShort)  return {side:'short', level:1};
  return {side:null, level:0};
}

function crowdRatioRead(r){
  if(r == null || !isFinite(r)) return {side:null, level:0};
  if(r >= CROWD.ratioLongX)  return {side:'long',  level:2};
  if(r >= CROWD.ratioLong)   return {side:'long',  level:1};
  if(r <= CROWD.ratioShortX) return {side:'short', level:2};
  if(r <= CROWD.ratioShort)  return {side:'short', level:1};
  return {side:null, level:0};
}

/*  The read. `m` is one coin's metrics:
      chg24, chg4      price change, %
      fundingPct       current funding, % per 8h
      fundAvgPct       mean of the last several fundings, % per 8h (or null)
      ratio, ratioAvg  share of accounts long, now and the 24h mean (or null)
      oiChg24, oiChg4  open interest change, %
      oiToTurnover     OI value / 24h turnover (or null)
      turnover         24h turnover, $
    Returns null when nothing here adds up to a read, else
      {dir, score, kind, tag, why, crowd} — `crowd` is which side is crowded
    (long / short / null), which the row shows whatever the direction.

    Points go into a bull pile or a bear pile with a reason each; the read is
    the bigger pile, and the score is what is left after the other pile has
    argued back. Kind is whichever bucket put the most points on the winning
    side, so the tag says what the read actually rests on.                 */
function crowdScore(m){
  const f = crowdFundingRead(m.fundingPct);
  const r = crowdRatioRead(m.ratio);
  const bull = [], bear = [];
  const put = (list, pts, why, bucket) => list.push({pts, why, bucket});
  const fmtF = p => (p > 0 ? '+' : '') + p.toFixed(3) + '%/8h';

  // which side is crowded, if either — funding leads, the ratio seconds it
  let crowd = f.side || r.side || null;
  if(f.side && r.side && f.side !== r.side) crowd = f.level >= r.level ? f.side : r.side;

  /* A. the crowd is paying — lean against it */
  if(f.side === 'long')  put(bear, f.level === 2 ? 30 : 15, 'longs paying ' + fmtF(m.fundingPct), 'crowded');
  if(f.side === 'short') put(bull, f.level === 2 ? 30 : 15, 'shorts paying ' + fmtF(m.fundingPct), 'crowded');
  if(r.side === 'long')  put(bear, r.level === 2 ? 22 : 12, Math.round(m.ratio*100) + '% of accounts long', 'crowded');
  if(r.side === 'short') put(bull, r.level === 2 ? 22 : 12, Math.round((1-m.ratio)*100) + '% of accounts short', 'crowded');
  if(f.side && m.fundAvgPct != null && isFinite(m.fundAvgPct) && Math.abs(m.fundingPct) > 1.5*Math.abs(m.fundAvgPct) + 0.005)
    put(f.side === 'long' ? bear : bull, 8, 'funding climbing (avg ' + fmtF(m.fundAvgPct) + ')', 'crowded');
  if(r.side && m.ratioAvg != null && isFinite(m.ratioAvg)){
    const d = m.ratio - m.ratioAvg;
    if(r.side === 'long' && d >= 0.05)  put(bear, 6, 'crowd still piling in', 'crowded');
    if(r.side === 'short' && d <= -0.05) put(bull, 6, 'crowd still piling in', 'crowded');
  }

  /* B. the crowd is trapped — price against them, and they are adding */
  if(crowd === 'long'  && m.chg24 <= -CROWD.move && m.oiChg24 >= CROWD.oiUp)
    put(bear, 20, 'longs trapped: price ' + m.chg24.toFixed(1) + '%, OI +' + m.oiChg24.toFixed(1) + '%', 'crowded');
  if(crowd === 'short' && m.chg24 >=  CROWD.move && m.oiChg24 >= CROWD.oiUp)
    put(bull, 20, 'shorts trapped: price +' + m.chg24.toFixed(1) + '%, OI +' + m.oiChg24.toFixed(1) + '%', 'crowded');

  /* C. fresh money — the move is being bought with leverage, and cheaply.
        Only with no crowd on either side: rising OI on a falling price with
        longs paying is longs adding underwater (B), not shorts pressing. */
  if(!crowd && m.chg24 >= CROWD.move && m.oiChg24 >= CROWD.oiUp && m.fundingPct < CROWD.fundLong*0.6)
    put(bull, 25, 'new longs, not yet crowded', 'fresh');
  if(!crowd && m.chg24 <= -CROWD.move && m.oiChg24 >= CROWD.oiUp && m.fundingPct > CROWD.fundShort*0.6)
    put(bear, 25, 'new shorts, not yet crowded', 'fresh');

  /* D. a squeeze in progress — the move is positions closing, not opening */
  if(m.chg24 >= CROWD.move && m.oiChg24 <= -CROWD.oiUp)
    put(bear, 14, 'rally on falling OI — shorts covering, not buying', 'squeeze');
  if(m.chg24 <= -CROWD.move && m.oiChg24 <= -CROWD.oiUp)
    put(bull, 14, 'drop on falling OI — longs flushed, selling spent', 'squeeze');

  /* E. coiled — leverage loading on a flat price; funding says which way */
  if(Math.abs(m.chg24) < CROWD.flat && m.oiChg24 >= CROWD.oiBuild){
    if(m.fundingPct >= 0.02)       put(bear, 8, 'OI +' + m.oiChg24.toFixed(1) + '% on a flat price, longs paying', 'coiled');
    else if(m.fundingPct <= -0.01) put(bull, 8, 'OI +' + m.oiChg24.toFixed(1) + '% on a flat price, shorts paying', 'coiled');
    else { put(bull, 4, 'OI +' + m.oiChg24.toFixed(1) + '% on a flat price', 'coiled'); put(bear, 4, 'OI +' + m.oiChg24.toFixed(1) + '% on a flat price', 'coiled'); }
  }

  const sum = l => l.reduce((s,x)=>s+x.pts, 0);
  let b = sum(bull), s = sum(bear);
  if(!b && !s) return null;
  const dir = b >= s ? 'bull' : 'bear';
  const win = dir === 'bull' ? bull : bear;
  let score = Math.max(b, s) - Math.min(b, s) * 0.5;
  const why = win.slice().sort((x,y)=>y.pts-x.pts).map(x=>x.why);

  /* F. the same read, sharper: heavy OI against the day's turnover */
  if(m.oiToTurnover != null && isFinite(m.oiToTurnover) && m.oiToTurnover >= CROWD.overhang){
    score += 6; why.push('OI ' + m.oiToTurnover.toFixed(1) + '× daily turnover — moves will be sharp');
  }
  /* G. a thin book cannot carry a crowd */
  if(isFinite(m.turnover) && m.turnover < CROWD_MIN_TURNOVER){ score *= 0.6; why.push('thin book'); }

  score = Math.round(score);
  if(score < CROWD_MIN_SCORE) return null;

  // the kind is the bucket that did the most work on the winning side
  const byBucket = {};
  for(const x of win) byBucket[x.bucket] = (byBucket[x.bucket]||0) + x.pts;
  const kind = Object.keys(byBucket).sort((a,c)=>byBucket[c]-byBucket[a])[0];
  const tag = kind === 'crowded' ? (dir === 'bear' ? 'Crowded longs' : 'Crowded shorts')
            : kind === 'fresh'   ? (dir === 'bull' ? 'New longs' : 'New shorts')
            : kind === 'squeeze' ? (dir === 'bear' ? 'Short squeeze, fragile' : 'Long flush, spent')
            : 'OI building';
  return {dir, score, kind, tag, why, crowd};
}

/*  Metrics out of the raw series. Pure, so a test can hand in arrays.
      oi      [{t, oi}] hourly, ascending      ratio [{t, buy}] hourly, ascending
      fund    [rate, …] most recent last       kl    [{t, c}] hourly, ascending  */
function crowdMetrics(t, oi, ratio, fund, kl){
  const pct = (now, then) => (then && isFinite(then) && isFinite(now)) ? (now-then)/then*100 : null;
  const at = (arr, back, key) => arr && arr.length > back ? arr[arr.length-1-back][key] : null;
  const last = (arr, key) => arr && arr.length ? arr[arr.length-1][key] : null;
  const fundPct = isFinite(t.funding) ? t.funding*100 : (fund && fund.length ? fund[fund.length-1]*100 : null);
  const fundAvg = fund && fund.length >= 3 ? fund.reduce((s,x)=>s+x, 0)/fund.length*100 : null;
  const ratioNow = last(ratio, 'buy');
  const ratioAvg = ratio && ratio.length >= 6 ? ratio.reduce((s,x)=>s+x.buy, 0)/ratio.length : null;
  return {
    chg24: isFinite(t.chg) ? t.chg : (pct(last(kl,'c'), at(kl, 24, 'c')) ?? 0),
    chg4:  pct(last(kl,'c'), at(kl, 4, 'c')),
    fundingPct: fundPct, fundAvgPct: fundAvg,
    ratio: ratioNow, ratioAvg,
    oiChg24: pct(last(oi,'oi'), at(oi, 24, 'oi')) ?? 0,
    oiChg4:  pct(last(oi,'oi'), at(oi, 4, 'oi')),
    oiToTurnover: isFinite(t.oiVal) && t.turnover > 0 ? t.oiVal/t.turnover : null,
    turnover: t.turnover,
  };
}
/*  The read at every hour of a window, for the Crowd terminal. Each series
    is hourly and ascending; funding is per settlement (every 8h) and is
    read as a step — the latest settlement at or before the hour. Metrics at
    hour i are the same crowdMetrics the sweep uses, computed from the 24
    hours behind i, so a read here is exactly what the sweep would have said
    then. Returns [{t, close, m, read}] for every hour with a full lookback.
      kl [{t, c}]   oi [{t, oi}]   ratio [{t, buy}]   fund [{t, r}]
    `t` is the coin's ticker row (turnover, oiVal), held constant across the
    window — there is no hourly turnover history, and it only damps.       */
function crowdSeries(t, kl, oi, ratio, fund){
  const out = [];
  if(!kl || kl.length < 25) return out;
  const oiAt = new Map((oi||[]).map(x=>[x.t, x.oi]));
  const rAt  = new Map((ratio||[]).map(x=>[x.t, x.buy]));
  const fs = (fund||[]).slice().sort((a,b)=>a.t-b.t);
  const H = 3600e3;
  for(let i = 24; i < kl.length; i++){
    const now = kl[i].t, then = kl[i-24].t;
    const c0 = kl[i-24].c, c1 = kl[i].c;
    if(!(c0 > 0) || !(c1 > 0)) continue;
    const o0 = oiAt.get(then), o1 = oiAt.get(now);
    const o4 = oiAt.get(now - 4*H);
    const rs = []; for(let k = 0; k < 24; k++){ const v = rAt.get(now - k*H); if(isFinite(v)) rs.push(v); }
    const fUpTo = fs.filter(f=>f.t <= now);
    const fLast8 = fUpTo.slice(-8);
    const m = {
      chg24: (c1-c0)/c0*100,
      chg4:  kl[i-4] && kl[i-4].c > 0 ? (c1-kl[i-4].c)/kl[i-4].c*100 : null,
      fundingPct: fUpTo.length ? fUpTo[fUpTo.length-1].r*100 : null,
      fundAvgPct: fLast8.length >= 3 ? fLast8.reduce((s,f)=>s+f.r,0)/fLast8.length*100 : null,
      ratio: rs.length ? rs[0] : null,
      ratioAvg: rs.length >= 6 ? rs.reduce((s,v)=>s+v,0)/rs.length : null,
      oiChg24: (o0 > 0 && o1 > 0) ? (o1-o0)/o0*100 : 0,
      oiChg4:  (o4 > 0 && o1 > 0) ? (o1-o4)/o4*100 : null,
      oiToTurnover: t && isFinite(t.oiVal) && t.turnover > 0 ? t.oiVal/t.turnover : null,
      turnover: t ? t.turnover : NaN,
    };
    out.push({t: now, close: c1, m, read: crowdScore(m)});
  }
  return out;
}

/*  Did the lean point the right way `ahead` hours later. Same deadband idea
    as the analyst record: under half a percent either way is flat, not a
    verdict. Only hours with a full look-ahead are graded; the rest are
    still open. Hourly reads overlap — 24 consecutive hours of "crowded
    longs" are one crowd, not 24 independent calls — so the rate is a
    reading of this coin's recent character, never a sample size.        */
const CROWD_DEADBAND = 0.5;
function crowdSeriesTally(series, ahead){
  const A = ahead || 24;
  const t = {n:0, right:0, wrong:0, flat:0, open:0, rate:null, byKind:{}};
  const byT = new Map(series.map(s=>[s.t, s.close]));
  for(const s of series){
    if(!s.read) continue;
    const later = byT.get(s.t + A*3600e3);
    const k = t.byKind[s.read.kind] = t.byKind[s.read.kind] || {n:0, right:0, wrong:0, flat:0, open:0, rate:null};
    t.n++; k.n++;
    if(later == null){ t.open++; k.open++; continue; }
    const pct = (later - s.close)/s.close*100;
    const dirPct = s.read.dir === 'bear' ? -pct : pct;
    const g = dirPct > CROWD_DEADBAND ? 'right' : dirPct < -CROWD_DEADBAND ? 'wrong' : 'flat';
    t[g]++; k[g]++;
    s.grade = g; s.later = pct;
  }
  const rate = x => { const d = x.right + x.wrong; x.rate = d ? Math.round(x.right/d*100) : null; };
  rate(t); Object.values(t.byKind).forEach(rate);
  return t;
}
/* ==CROWD_END== */

/* ---------- the sweep ---------- */
async function crowdPool(items, limit, fn, onProgress){
  let next = 0, done = 0;
  const out = new Array(items.length);
  const worker = async () => {
    while(next < items.length && !crowdAbort){
      const i = next++;
      try{ out[i] = await fn(items[i]); }catch(e){ out[i] = null; }
      done++;
      if(onProgress) onProgress(done, items.length);
    }
  };
  await Promise.all(Array.from({length:Math.min(limit, items.length)}, worker));
  return out;
}

// the board, with the two fields the tickers already carry for free
async function crowdUniverse(){
  const res = await bybit('/tickers?category='+MARKET);
  return (res.list||[])
    .filter(t=>/USDT$/.test(t.symbol))
    .map(t=>({
      sym: t.symbol.replace(/USDT$/,''), bybit: t.symbol,
      price:+t.lastPrice, chg:(+t.price24hPcnt)*100, turnover:+t.turnover24h,
      funding:+t.fundingRate, oiVal:+t.openInterestValue,
      nextFunding: +t.nextFundingTime || null,
    }))
    .filter(t=>isFinite(t.turnover) && t.turnover>0)
    .sort((a,b)=>b.turnover-a.turnover);
}

async function crowdSymbol(t){
  // a series Bybit refuses for this contract is null evidence, not a dropped coin
  const soft = q => bybit(q).catch(() => ({ list: [] }));
  const [oiRes, rRes, fRes, kRes] = await Promise.all([
    soft('/open-interest?category=linear&symbol='+t.bybit+'&intervalTime=1h&limit=25'),
    soft('/account-ratio?category=linear&symbol='+t.bybit+'&period=1h&limit=25'),
    soft('/funding/history?category=linear&symbol='+t.bybit+'&limit=8'),
    bybit('/kline?category=linear&symbol='+t.bybit+'&interval=60&limit=26'),
  ]);
  const oi = (oiRes.list||[]).map(x=>({t:+x.timestamp, oi:+x.openInterest})).filter(x=>x.oi>0).sort((a,b)=>a.t-b.t);
  const ratio = (rRes.list||[]).map(x=>({t:+x.timestamp, buy:+x.buyRatio})).filter(x=>isFinite(x.buy)).sort((a,b)=>a.t-b.t);
  const fund = (fRes.list||[]).map(x=>({t:+x.fundingRateTimestamp, r:+x.fundingRate})).filter(x=>isFinite(x.r)).sort((a,b)=>a.t-b.t).map(x=>x.r);
  const kl = (kRes.list||[]).map(x=>({t:+x[0], c:+x[4]})).sort((a,b)=>a.t-b.t);
  const m = crowdMetrics(t, oi, ratio, fund, kl);
  const read = crowdScore(m);
  const flow = nvFlow(m.chg24, m.oiChg24);
  return {...t, m, read, flow};
}

async function runCrowd(){
  if(crowding) return;
  crowding = true; crowdAbort = false;
  $('cr-run').hidden = true; $('cr-stop').hidden = false;
  $('cr-bar').hidden = false;
  $('crrows').innerHTML = '<div class="loading">Pulling the board…</div>';
  try{
    const all = await crowdUniverse();
    const uni = crowdCfg.depth>=9999 ? all : all.slice(0, crowdCfg.depth);
    // BTC is the reference whatever the depth — the board's own funding is read against it
    const btcT = all.find(t=>t.sym==='BTC');
    if(btcT && !uni.includes(btcT)) uni.unshift(btcT);
    const started = Date.now();
    const rows = await crowdPool(uni, CROWD_POOL, crowdSymbol, (done, total)=>{
      $('cr-fill').style.width = Math.round(done/total*100)+'%';
      const el = (Date.now()-started)/1000;
      const eta = done ? Math.round(el/done*(total-done)) : 0;
      $('cr-prog').textContent = done+' / '+total+' coins · '+(total*4)+' requests'+(eta>2 ? ' · about '+eta+'s left' : '');
    });
    const got = rows.filter(Boolean);
    crowdBtc = got.find(r=>r.sym==='BTC') || null;
    crowdRows = got.filter(r=>r.read).sort((a,b)=>b.read.score-a.read.score);
    crowdRan = true;
    lastCrowd = {scanned:uni.length, board:all.length, failed:rows.filter(h=>h===undefined||h===null).length, secs:Math.round((Date.now()-started)/1000)};
    renderCrowd();
  }catch(e){
    $('crrows').innerHTML = '<div class="loading">Sweep failed: '+e.message+'</div>';
  }finally{
    crowding = false; crowdAbort = false;
    $('cr-run').hidden = false; $('cr-stop').hidden = true;
    $('cr-bar').hidden = true; $('cr-fill').style.width = '0%';
  }
}

/* ---------- render ---------- */
function crowdFundCell(pct){
  if(pct == null || !isFinite(pct)) return '<span class="dim">—</span>';
  const r = crowdFundingRead(pct);
  const cls = r.side === 'long' ? (r.level === 2 ? 'hot' : 'warm') : r.side === 'short' ? (r.level === 2 ? 'cold' : 'cool') : '';
  return '<span class="crf '+cls+'" title="'+(pct*3*365).toFixed(0)+'% annualised">'+(pct>0?'+':'')+pct.toFixed(3)+'%</span>';
}
function crowdRatioCell(r){
  if(r == null || !isFinite(r)) return '<span class="dim">—</span>';
  const x = crowdRatioRead(r);
  const cls = x.side === 'long' ? (x.level === 2 ? 'hot' : 'warm') : x.side === 'short' ? (x.level === 2 ? 'cold' : 'cool') : '';
  return '<span class="crf '+cls+'" title="share of accounts long">'+Math.round(r*100)+'% L</span>';
}
function crowdOiCell(p){
  if(p == null || !isFinite(p)) return '<span class="dim">—</span>';
  return '<span class="'+(p>=3?'up':p<=-3?'down':'dim')+'">'+(p>0?'+':'')+p.toFixed(1)+'%</span>';
}

function crowdVisible(){
  return crowdRows.filter(r=>{
    if(crowdCfg.side==='long'  && r.read.dir!=='bull') return false;
    if(crowdCfg.side==='short' && r.read.dir!=='bear') return false;
    if(crowdCfg.kind!=='any'   && r.read.kind!==crowdCfg.kind) return false;
    return true;
  });
}

function renderCrowd(){
  const host = $('crrows');
  if(!host) return;
  const SHOW = 25;
  const rows = crowdVisible();
  if(!crowdRan){
    host.innerHTML = '<div class="loading">Pick your filters and hit Run sweep.</div>';
  } else if(!rows.length){
    host.innerHTML = '<div class="loading">Nothing on the board reads as crowded, fresh, squeezed or coiled with these filters.</div>';
  } else {
    host.innerHTML = '';
    rows.slice(0, SHOW).forEach((r,i)=>{
      const rd = r.read;
      const col = rd.dir==='bull' ? 'var(--up)' : 'var(--down)';
      const el = document.createElement('div');
      el.className = 'crrow';
      el.innerHTML =
        '<div class="scrank">'+(i+1)+'</div>'+
        '<div class="scsym">'+nvIcon(r.sym)+'<b>'+r.sym+'</b><em>'+fmtVol(r.turnover)+'</em></div>'+
        '<div class="sclast num">'+fmtUsd(r.price)+'</div>'+
        '<div class="scchg num '+(r.chg>=0?'up':'down')+'">'+(r.chg>=0?'+':'')+r.chg.toFixed(1)+'%</div>'+
        '<div class="scsetup"><span style="color:'+col+'">'+rd.tag+'</span><em>'+rd.why.join(' · ')+'</em></div>'+
        '<div class="crcell num">'+crowdFundCell(r.m.fundingPct)+'</div>'+
        '<div class="crcell num">'+crowdRatioCell(r.m.ratio)+'</div>'+
        '<div class="crcell num">'+crowdOiCell(r.m.oiChg24)+'</div>'+
        '<div class="crflow"><span class="crtag '+r.flow.cls+'" title="'+r.flow.why+'">'+r.flow.tag+'</span></div>'+
        '<div class="scscore" style="color:'+col+'">'+rd.score+'</div>'+
        '<div class="sctrack"><button class="x'+(watch.includes(r.sym)?' on':'')+'" data-sym="'+r.sym+'" title="Track">★</button></div>';
      el.addEventListener('click', e=>{
        if(e.target.closest('.x')) return;
        switchSymbol(r.sym); setView('crowdterm');
      });
      host.appendChild(el);
    });
    host.querySelectorAll('.x').forEach(b=>{
      b.onclick = e=>{
        e.stopPropagation();
        const sym = b.dataset.sym;
        watch.includes(sym) ? removeWatch(sym) : addWatch(sym);
        b.classList.toggle('on', watch.includes(sym));
      };
    });
  }
  const longs = rows.filter(r=>r.read.dir==='bull').length;
  const btc = crowdBtc && crowdBtc.m;
  $('crsub').textContent = crowdRan && lastCrowd
    ? rows.length+' of '+lastCrowd.scanned+' read · '+longs+' lean long, '+(rows.length-longs)+' lean short · '+lastCrowd.secs+'s'+
      (lastCrowd.failed ? ' · '+lastCrowd.failed+' unavailable' : '')+
      (btc ? ' · BTC funding '+(btc.fundingPct>0?'+':'')+btc.fundingPct.toFixed(3)+'%, OI '+(btc.oiChg24>0?'+':'')+btc.oiChg24.toFixed(1)+'% 24h' : '')
    : 'Sweeps the perp board for crowded, fresh, squeezed and coiled positioning.';
  $('crnote').textContent = crowdRan
    ? (rows.length>SHOW ? 'Showing the top '+SHOW+' of '+rows.length+'. ' : '')+
      'Crowded = one side paying and piling in; the lean is against it. Fresh = the move is being bought with cheap leverage; the lean is with it. '+
      'Squeeze / flush = the move is positions closing, not opening — fragile. Coiled = OI loading on a flat price; funding says which way. '+
      'Funding is per 8h; L is the share of accounts long; OI is the 24h change in open interest.'
    : '';
}

function buildCrowdControls(){
  const chip = (host, items, isOn, onPick) => {
    const box = $(host); if(!box) return; box.innerHTML = '';
    items.forEach(([val,label])=>{
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', isOn(val));
      b.onclick = ()=>{ onPick(val); buildCrowdControls(); renderCrowd(); };
      box.appendChild(b);
    });
  };
  chip('cr-side', [['both','Both'],['long','Lean long'],['short','Lean short']], v=>crowdCfg.side===v, v=>{crowdCfg.side=v;});
  chip('cr-kind', [['any','Any'],['crowded','Crowded'],['fresh','Fresh money'],['squeeze','Squeeze / flush'],['coiled','Coiled']], v=>crowdCfg.kind===v, v=>{crowdCfg.kind=v;});
  chip('cr-depth', [[50,'Top 50'],[100,'Top 100'],[250,'Top 250'],[9999,'Every coin']], v=>crowdCfg.depth===v, v=>{crowdCfg.depth=v;});
}
