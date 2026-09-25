/* ui-crowd.js — the Crowd terminal: one coin's positioning, deep.

   The Terminal is the stochastic on one coin across five frames. This is
   its sibling for positioning — the coin the app has selected, read the
   way the Crowd sweep reads it (crowd.js's crowdScore, the same function),
   with the numbers behind the read, one chart of its whole history on any
   frame (candles, open interest, funding, the share of accounts long), and the
   read recomputed at every hour of that week so you can see what it would
   have said and whether price then went that way.

   Nothing is computed here that the sweep does not compute; this only
   fetches a longer window and draws it. Follows `active`, like everything
   else on the symbol bar.
   part of Odysseus */

const CT_HOURS = 168;                 // a week, hourly
const CT_LOOK  = 24;                  // plus the lookback the first hour needs
const ctState = {sym:null, loading:false, data:null, err:null};

async function crowdTermFetch(sym){
  const meta = symbolOf(sym);
  const n = CT_HOURS + CT_LOOK + 1;
  /*  Price and the ticker are required; the three positioning series are
      not. Bybit refuses some of them for some contracts (the long/short
      ratio for USDC perpetuals, say), and a missing series is a gap in the
      read — crowdScore already treats null as "no evidence" — not a reason
      to show nothing at all. What is missing is named under the read.    */
  const soft = (q, what) => bybit(q).catch(e => ({ list: [], missing: what + ': ' + e.message }));
  const [tk, oiRes, rRes, fRes, kRes] = await Promise.all([
    bybit('/tickers?category=linear&symbol='+meta.bybit),
    soft('/open-interest?category=linear&symbol='+meta.bybit+'&intervalTime=1h&limit='+n, 'open interest'),
    soft('/account-ratio?category=linear&symbol='+meta.bybit+'&period=1h&limit='+n, 'long/short ratio'),
    soft('/funding/history?category=linear&symbol='+meta.bybit+'&limit=30', 'funding'),
    bybit('/kline?category=linear&symbol='+meta.bybit+'&interval=60&limit='+n),
  ]);
  const missing = [oiRes, rRes, fRes].map(x=>x.missing).filter(Boolean);
  const tr = (tk.list||[])[0] || {};
  if(!tr.symbol) throw new Error('Bybit has no linear ticker for '+meta.bybit);
  const t = {
    sym, bybit: meta.bybit, name: meta.name,
    price:+tr.lastPrice, chg:(+tr.price24hPcnt)*100, turnover:+tr.turnover24h,
    funding:+tr.fundingRate, oiVal:+tr.openInterestValue, oi:+tr.openInterest,
    nextFunding:+tr.nextFundingTime || null, hi:+tr.highPrice24h, lo:+tr.lowPrice24h,
  };
  const oi = (oiRes.list||[]).map(x=>({t:+x.timestamp, oi:+x.openInterest})).filter(x=>x.oi>0).sort((a,b)=>a.t-b.t);
  const ratio = (rRes.list||[]).map(x=>({t:+x.timestamp, buy:+x.buyRatio})).filter(x=>isFinite(x.buy)).sort((a,b)=>a.t-b.t);
  const fund = (fRes.list||[]).map(x=>({t:+x.fundingRateTimestamp, r:+x.fundingRate})).filter(x=>isFinite(x.r)).sort((a,b)=>a.t-b.t);
  const kl = (kRes.list||[]).map(x=>({t:+x[0], o:+x[1], h:+x[2], l:+x[3], c:+x[4], v:+x[5]})).sort((a,b)=>a.t-b.t);
  // hourly OI and ratio prints sit on the hour; klines open on the hour — align by flooring
  const floorH = x => Math.floor(x/3600e3)*3600e3;
  oi.forEach(x=> x.t = floorH(x.t)); ratio.forEach(x=> x.t = floorH(x.t));
  const m = crowdMetrics(t, oi, ratio, fund.map(f=>f.r), kl);
  const read = crowdScore(m);
  const series = crowdSeries(t, kl, oi, ratio, fund);
  const tally = crowdSeriesTally(series, 24);
  return {t, oi, ratio, fund, kl, m, read, flow: nvFlow(m.chg24, m.oiChg24), series, tally, missing, at: Date.now()};
}

async function crowdTermShow(force){
  const sym = active;
  if(!force && ctState.sym === sym && ctState.data && Date.now() - ctState.data.at < 90e3){ crowdTermRender(); return; }
  if(ctState.loading && ctState.sym === sym) return;
  ctState.sym = sym; ctState.loading = true; ctState.err = null;
  crowdTermRender();
  try{
    const d = await crowdTermFetch(sym);
    if(ctState.sym !== sym) return;         // the coin changed under us
    ctState.data = d;
  }catch(e){
    ctState.err = e.message;
  }finally{
    if(ctState.sym === sym) ctState.loading = false;
    crowdTermRender();
  }
}

/* ---------- render ---------- */
function ctPct(v, dp){ return v==null||!isFinite(v) ? '—' : (v>0?'+':'')+v.toFixed(dp==null?1:dp)+'%'; }
function ctTone(v, hi, lo){ return v==null ? '' : v>=hi ? 'up' : v<=lo ? 'down' : ''; }
function ctHours(ms){ if(!ms) return '—'; const h=(ms-Date.now())/3600e3; return h<0 ? 'now' : h<1 ? Math.round(h*60)+'m' : h.toFixed(1)+'h'; }

function crowdTermRender(){
  if(!$('ct-read')) return;
  const sym = ctState.sym || active;
  const meta = symbolOf(sym);
  if($('ct-sym')) $('ct-sym').textContent = meta.name || sym;
  const d = ctState.data && ctState.sym === sym ? ctState.data : null;

  if(ctState.err && !d){
    $('ct-read').innerHTML = '<span class="ctnone">Could not load '+sym+': '+ctState.err+'</span>';
  }
  if(!d){
    if($('ct-px')){ $('ct-px').textContent = '—'; $('ct-chg').textContent = ''; }
    ['ct-fund','ct-favg','ct-next','ct-oi','ct-oichg','ct-ls','ct-oit','ct-flow'].forEach(id=>{ const e=$(id); if(e) e.textContent='—'; });
    if(ctState.loading) $('ct-read').innerHTML = '<span class="ctnone">Reading the last week of '+sym+'…</span>';
    $('ct-strip').innerHTML = ''; $('ct-tally').textContent = '';
    cxDispose();
    return;
  }

  const {t, m, read, flow, series, tally, missing} = d;
  if($('ct-px')){
    $('ct-px').textContent = fmtUsd(t.price);
    $('ct-px').className = 'px num ' + (t.chg>=0?'up':'down');
    $('ct-chg').textContent = ctPct(t.chg, 2)+' 24h';
    $('ct-chg').className = 'chg num ' + (t.chg>=0?'up':'down');
  }

  const f = crowdFundingRead(m.fundingPct), r = crowdRatioRead(m.ratio);
  const tone = x => x.side==='long' ? 'down' : x.side==='short' ? 'up' : '';
  const set = (id, text, cls, title) => { const e=$(id); if(!e) return; e.textContent = text; e.className = 'num '+(cls||''); if(title) e.title = title; };
  set('ct-fund', m.fundingPct==null ? '—' : ctPct(m.fundingPct, 3)+' / 8h', tone(f), m.fundingPct==null ? '' : (m.fundingPct*3*365).toFixed(0)+'% annualised');
  set('ct-favg', m.fundAvgPct==null ? '—' : ctPct(m.fundAvgPct, 3), '', 'mean of the last 8 settlements');
  set('ct-next', ctHours(t.nextFunding), '', t.nextFunding ? new Date(t.nextFunding).toLocaleTimeString() : '');
  set('ct-oi', isFinite(t.oiVal) ? '$'+fmtVol(t.oiVal) : '—', '', isFinite(t.oi) ? t.oi.toLocaleString()+' contracts' : '');
  set('ct-oichg', ctPct(m.oiChg24)+' · '+ctPct(m.oiChg4)+' 4h', ctTone(m.oiChg24, 3, -3));
  set('ct-ls', m.ratio==null ? '—' : Math.round(m.ratio*100)+'% long'+(m.ratioAvg!=null ? ' · avg '+Math.round(m.ratioAvg*100)+'%' : ''), tone(r), 'share of accounts long, and its 24h mean');
  set('ct-oit', m.oiToTurnover==null ? '—' : m.oiToTurnover.toFixed(2)+'×', m.oiToTurnover>=CROWD.overhang ? 'warn' : '', 'open interest ÷ 24h turnover');
  set('ct-flow', flow.tag, flow.cls==='long'?'up':flow.cls==='short'?'down':'', flow.why);

  // the read
  const rd = $('ct-read');
  if(read){
    const col = read.dir==='bull' ? 'var(--up)' : 'var(--down)';
    rd.innerHTML =
      '<h1><span style="color:'+col+'">'+read.tag+'</span><span class="num" style="color:'+col+'">'+read.score+'</span>'+
      '<span class="ctlean '+read.dir+'">lean '+(read.dir==='bull'?'long':'short')+'</span></h1>'+
      '<ul class="ctwhy">'+read.why.map(w=>'<li>'+nvEsc(w)+'</li>').join('')+'</ul>';
  } else {
    rd.innerHTML = '<h1><span class="ctnone">No crowd read</span></h1>'+
      '<p class="ctnote">Nothing on '+sym+' is crowded, fresh, squeezed or coiled right now — the numbers above are the whole story. '+
      'A read needs '+CROWD_MIN_SCORE+' points; see the Crowd sweep\'s note for what earns them.</p>';
  }
  if(missing && missing.length)
    rd.innerHTML += '<p class="ctnote ctmissing">Bybit did not give '+nvEsc(missing.join('; '))+' for '+nvEsc(t.bybit)+
      ' — the read is made from what it did give.</p>';

  // the last week, hour by hour
  const strip = $('ct-strip');
  const last = series.slice(-CT_HOURS);
  strip.innerHTML = last.map(s=>{
    const cls = !s.read ? 'none' : s.read.dir;
    const g = s.grade ? ' g-'+s.grade : (s.read ? ' g-open' : '');
    const title = new Date(s.t).toLocaleString()+(s.read ? ' — '+s.read.tag+' '+s.read.score+' ('+s.read.why[0]+')'+
      (s.grade ? ' → '+s.grade+' at 24h ('+ctPct(s.later)+')' : ' → still open') : ' — no read');
    return '<i class="'+cls+g+'" title="'+nvEsc(title)+'"></i>';
  }).join('');
  const kinds = Object.keys(tally.byKind).map(k=>{
    const x = tally.byKind[k];
    return k+' '+x.n+(x.rate!=null ? ' ('+x.rate+'%)' : '');
  });
  $('ct-tally').textContent = tally.n
    ? 'Last 7 days: a read on '+tally.n+' of '+last.length+' hours — '+tally.right+' pointed the right way at 24h, '+tally.wrong+' the wrong way'+
      (tally.flat ? ', '+tally.flat+' flat' : '')+(tally.open ? ', '+tally.open+' still open' : '')+
      (tally.rate!=null ? ' → '+tally.rate+'% of decided' : '')+'. '+
      (kinds.length ? 'By kind: '+kinds.join(' · ')+'. ' : '')+
      'Hours overlap — a crowd that lasts a day is one crowd, not 24 calls — so read this as the coin\'s recent character, not a sample.'
    : 'Last 7 days: no hour on '+sym+' produced a read.';

  // the chart only when its panel is open — it is the heavy part
  const cs = $('crowdchart');
  if(!cs || !cs.classList.contains('folded')) crowdTermChartShow();
}

/* ---------- the chart ----------
   A trading chart, not a picture of one: every Bybit interval from a minute
   to a month, candles / bars / line / area, and the positioning series each
   in a pane of its own with its own axis — drag an axis to scale it, drag
   the separator between panes to resize them, wheel to zoom, drag to pan,
   log scale, and a reset when it has been pulled about. Volume, open
   interest, funding and the share of accounts long can each be switched
   off and on.

   Panes are what make it flexible, and panes arrived in Lightweight Charts
   5. The rest of the app pins 4.1.3 through a script tag, and the two
   builds cannot share the page's global — so this view imports the v5
   ES-module build on demand, the way cloud.js imports the Firebase SDK,
   and never touches the global the Terminal's charts use. Offline, the
   chart says so; the read and the numbers above are unaffected.

   Everything under the candles is sampled AT the bar: funding as the rate
   in force when the bar opened, OI and the share as the latest print at or
   inside the bar — so on any frame a bar and the numbers under it are the
   same moment by construction. Bybit's OI and account-ratio come at 5min,
   15min, 30min, 1h, 4h and 1d; a frame in between takes the print just
   below it, stepped.                                                     */
const CX_LIB = 'https://unpkg.com/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.mjs';
const CX_FRAMES = [
  {key:'1m',  label:'1 minute',   bybit:'1',   ms:60e3,      bars:1500, oi:'5min',  ratio:'5min'},
  {key:'3m',  label:'3 minutes',  bybit:'3',   ms:180e3,     bars:1500, oi:'5min',  ratio:'5min'},
  {key:'5m',  label:'5 minutes',  bybit:'5',   ms:300e3,     bars:2000, oi:'5min',  ratio:'5min'},
  {key:'15m', label:'15 minutes', bybit:'15',  ms:900e3,     bars:2000, oi:'15min', ratio:'15min'},
  {key:'30m', label:'30 minutes', bybit:'30',  ms:1800e3,    bars:2000, oi:'30min', ratio:'30min'},
  {key:'1h',  label:'1 hour',     bybit:'60',  ms:3600e3,    bars:3000, oi:'1h',    ratio:'1h'},
  {key:'2h',  label:'2 hours',    bybit:'120', ms:7200e3,    bars:3000, oi:'1h',    ratio:'1h'},
  {key:'4h',  label:'4 hours',    bybit:'240', ms:14400e3,   bars:3000, oi:'4h',    ratio:'4h'},
  {key:'6h',  label:'6 hours',    bybit:'360', ms:21600e3,   bars:3000, oi:'4h',    ratio:'4h'},
  {key:'12h', label:'12 hours',   bybit:'720', ms:43200e3,   bars:3000, oi:'4h',    ratio:'4h'},
  {key:'D',   label:'Daily',      bybit:'D',   ms:86400e3,   bars:3000, oi:'1d',    ratio:'1d'},
  {key:'W',   label:'Weekly',     bybit:'W',   ms:604800e3,  bars:1000, oi:'1d',    ratio:'1d'},
  {key:'M',   label:'Monthly',    bybit:'M',   ms:0,         bars:1000, oi:'1d',    ratio:'1d'},
];
const CX_PAGES = 30;                                                          // request cap per series
const cxState = {frame:'4h', type:'candles', log:false, tall:false, show:{vol:true, oi:true, fund:true, ls:true},
                 cache:{}, chart:null, lib:null, loading:null, s:null};

async function cxLib(){
  if(cxState.lib) return cxState.lib;
  cxState.lib = await import(CX_LIB);
  return cxState.lib;
}

// page a Bybit history endpoint backwards until it reaches `since` or runs dry
async function cxPage(path, since, pick, opts){
  const o = opts || {};
  const out = [];
  let cursor = '', end = null;
  for(let i = 0; i < CX_PAGES; i++){
    const q = path + (cursor ? '&cursor='+encodeURIComponent(cursor) : '') + (end && !o.cursor ? '&endTime='+end : '');
    const res = await bybit(q);
    const list = (res.list||[]).map(pick).filter(x=>x && isFinite(x.t) && isFinite(x.v)).sort((a,b)=>a.t-b.t);
    if(!list.length) break;
    out.unshift(...list);
    const oldest = list[0].t;
    if(oldest <= since) break;
    if(o.cursor){ cursor = res.nextPageCursor || ''; if(!cursor) break; }
    else { end = oldest - 1; }
  }
  const m = new Map(out.map(x=>[x.t, x.v]));
  return [...m.entries()].map(([t,v])=>({t,v})).sort((a,b)=>a.t-b.t);
}

async function crowdTermDeep(sym, frameKey){
  const key = sym+'|'+frameKey;
  if(cxState.cache[key] && Date.now() - cxState.cache[key].at < 120e3) return cxState.cache[key];
  const meta = symbolOf(sym);
  const tf = CX_FRAMES.find(x=>x.key===frameKey);
  const kl = await pull(meta, tf, tf.bars);
  const since = kl[0].t;
  const base = '&category=linear&symbol='+meta.bybit;
  const soft = p => p.catch(() => []);        // a series Bybit refuses is an empty pane, not a dead chart
  const [oi, fund, ratio] = await Promise.all([
    soft(cxPage('/open-interest?intervalTime='+tf.oi+'&limit=200'+base, since, x=>({t:+x.timestamp, v:+x.openInterest}), {cursor:true})),
    soft(cxPage('/funding/history?limit=200'+base, since, x=>({t:+x.fundingRateTimestamp, v:+x.fundingRate}), {cursor:false})),
    soft(cxPage('/account-ratio?period='+tf.ratio+'&limit=500'+base, since, x=>({t:+x.timestamp, v:+x.buyRatio}), {cursor:true})),
  ]);
  const d = {kl, oi, fund, ratio, tf, at: Date.now()};
  cxState.cache[key] = d;
  return d;
}

/*  The latest sample at or before each candle's open (funding: the rate in
    force when the bar opened). Pure, two pointers, both ascending.       */
function cxStep(kl, samples, tol){
  const out = new Array(kl.length).fill(null);
  let j = 0, last = null;
  for(let i = 0; i < kl.length; i++){
    const t = kl[i].t + (tol||0);
    while(j < samples.length && samples[j].t <= t){ last = samples[j].v; j++; }
    out[i] = last;
  }
  return out;
}

function cxDispose(){
  if(cxState.chart){ try{ cxState.chart.remove(); }catch(e){} }
  cxState.chart = null; cxState.s = null;
  const el = $('cx-pane'); if(el) el.innerHTML = '';
}

/* ---------- the toolbar ---------- */
function buildCrowdTools(){
  const box = $('cx-tools'); if(!box) return;
  box.innerHTML = '';
  const group = (label, items, isOn, onPick) => {
    const g = document.createElement('div'); g.className = 'cxgrp';
    if(label){ const l = document.createElement('span'); l.className = 'lab'; l.textContent = label; g.appendChild(l); }
    items.forEach(([val, text, title])=>{
      const b = document.createElement('button');
      b.className = 'tfbtn'; b.textContent = text; if(title) b.title = title;
      b.setAttribute('aria-pressed', isOn(val));
      b.onclick = ()=>{ onPick(val); };
      g.appendChild(b);
    });
    box.appendChild(g);
  };
  group('', CX_FRAMES.map(f=>[f.key, f.key, f.label]), v=>cxState.frame===v, v=>{ cxState.frame=v; buildCrowdTools(); crowdTermChartShow(); });
  group('', [['candles','Candles'],['bars','Bars'],['line','Line'],['area','Area']], v=>cxState.type===v, v=>{ cxState.type=v; buildCrowdTools(); cxRedraw(); });
  group('', [['vol','Vol'],['oi','OI'],['fund','Funding'],['ls','L/S']], v=>cxState.show[v], v=>{ cxState.show[v]=!cxState.show[v]; buildCrowdTools(); cxRedraw(); });
  group('', [['log','Log','logarithmic price scale'],['tall','Tall','a taller chart'],['reset','Reset','undo any scaling and fit the data']],
    v=> v==='log' ? cxState.log : v==='tall' ? cxState.tall : false,
    v=>{ if(v==='log') cxState.log=!cxState.log; else if(v==='tall') cxState.tall=!cxState.tall; buildCrowdTools(); if(v==='reset') cxReset(); else cxRedraw(); });
}

function cxReset(){
  const c = cxState.chart, s = cxState.s; if(!c || !s) return;
  Object.values(s).forEach(x=>{ try{ x.priceScale().applyOptions({autoScale:true}); }catch(e){} });
  c.timeScale().fitContent();
  cxDefaultView();
}
function cxDefaultView(){
  const c = cxState.chart, d = cxState.last; if(!c || !d) return;
  const show = Math.min(d.kl.length, 220);
  c.timeScale().setVisibleLogicalRange({from: d.kl.length - show, to: d.kl.length + 6});
}
function cxRedraw(){ if(cxState.last) crowdTermChartDraw(cxState.last, cxState.lastSym); }

async function crowdTermChartShow(){
  const sym = ctState.sym || active, frame = cxState.frame;
  const note = $('cx-note'); if(!$('cx-pane')) return;
  buildCrowdTools();
  const token = sym+'|'+frame;
  cxState.loading = token;
  if(note) note.textContent = 'Loading '+sym+' '+frame+' — price, open interest, funding and the long/short share, as far back as Bybit has them…';
  let d;
  try{
    await cxLib();
    d = await crowdTermDeep(sym, frame);
  }catch(e){
    if(cxState.loading === token && note) note.textContent = 'Could not load the chart: '+e.message+
      (/import|module|fetch dynamically|Failed to fetch/i.test(e.message) ? ' — the chart library is fetched from unpkg.com the first time; the read and the numbers above do not need it.' : '');
    return;
  }
  if(cxState.loading !== token) return;       // the coin or frame changed while this loaded
  cxState.last = d; cxState.lastSym = sym;
  crowdTermChartDraw(d, sym);
}

function crowdTermChartDraw(d, sym){
  cxDispose();
  const L = cxState.lib; if(!L) return;
  const tf = d.tf, kl = d.kl;
  const el = $('cx-pane');
  el.style.height = (cxState.tall ? 960 : 640)+'px';
  const intraday = tf.ms && tf.ms < 86400e3;
  const chart = L.createChart(el, {
    autoSize:true,
    layout:{ background:{type:'solid', color:'transparent'}, textColor:CH.text, fontFamily:CH.font, fontSize:11, attributionLogo:false,
             panes:{ separatorColor:CH.edge, separatorHoverColor:'rgba(110,123,255,.35)', enableResize:true } },
    grid:{ vertLines:{color:CH.grid}, horzLines:{color:CH.grid} },
    rightPriceScale:{ borderColor:CH.edge, scaleMargins:{top:0.08, bottom:0.08} },
    timeScale:{ borderColor:CH.edge, timeVisible: !!intraday, secondsVisible:false, rightOffset:6, barSpacing:7, minBarSpacing:0.5 },
    crosshair:{ mode:0, vertLine:{color:'#6E7BFF', width:1, style:2, labelBackgroundColor:'#1A2130'},
                        horzLine:{color:'#6E7BFF', width:1, style:2, labelBackgroundColor:'#1A2130'} },
    handleScale:{ axisPressedMouseMove:{time:true, price:true}, mouseWheel:true, pinch:true },
    handleScroll:{ mouseWheel:true, pressedMouseMove:true, horzTouchDrag:true, vertTouchDrag:false },
    localization:{ priceFormatter: undefined },
  });
  cxState.chart = chart;
  const s = cxState.s = {};
  const times = kl.map(k=>secs(k.t));
  const tol = tf.ms ? tf.ms - 1 : 31*86400e3;
  const oiAt = cxStep(kl, d.oi, tol), fundAt = cxStep(kl, d.fund, 0), lsAt = cxStep(kl, d.ratio, tol);
  const pf = priceFormatFor(kl[kl.length-1].c);

  /* pane 0: price, with volume underneath it on its own overlay scale */
  const opts = { priceScaleId:'right', priceFormat:pf, priceLineVisible:true, lastValueVisible:true };
  if(cxState.type==='candles' || cxState.type==='bars'){
    s.px = chart.addSeries(cxState.type==='candles' ? L.CandlestickSeries : L.BarSeries,
      Object.assign(opts, { upColor:CH.up, downColor:CH.down, borderVisible:false, wickUpColor:CH.up, wickDownColor:CH.down, thinBars:false }), 0);
    s.px.setData(kl.map((k,i)=>({time:times[i], open:k.o, high:k.h, low:k.l, close:k.c})));
  } else if(cxState.type==='line'){
    s.px = chart.addSeries(L.LineSeries, Object.assign(opts, { color:'#6E7BFF', lineWidth:2 }), 0);
    s.px.setData(kl.map((k,i)=>({time:times[i], value:k.c})));
  } else {
    s.px = chart.addSeries(L.AreaSeries, Object.assign(opts, { lineColor:'#6E7BFF', topColor:'rgba(110,123,255,.35)', bottomColor:'rgba(110,123,255,.02)', lineWidth:2 }), 0);
    s.px.setData(kl.map((k,i)=>({time:times[i], value:k.c})));
  }
  s.px.priceScale().applyOptions({ mode: cxState.log ? 1 : 0, scaleMargins:{top:0.08, bottom: cxState.show.vol ? 0.22 : 0.06} });
  if(cxState.show.vol){
    s.vol = chart.addSeries(L.HistogramSeries, { priceScaleId:'vol', priceFormat:{type:'volume'}, lastValueVisible:false, priceLineVisible:false }, 0);
    s.vol.priceScale().applyOptions({ scaleMargins:{top:0.82, bottom:0}, visible:false });
    s.vol.setData(kl.map((k,i)=>({time:times[i], value:k.v, color: k.c>=k.o ? 'rgba(8,153,129,.35)' : 'rgba(242,54,69,.35)'})));
  }

  /* the positioning panes — each its own pane, its own axis */
  let pane = 1;
  if(cxState.show.oi){
    s.oi = chart.addSeries(L.LineSeries, { priceScaleId:'right', color:'#6E7BFF', lineWidth:2, priceLineVisible:false, lastValueVisible:true,
      crosshairMarkerVisible:true, priceFormat:{type:'custom', formatter: v => fmtVol(v), minMove:1} }, pane++);
    s.oi.setData(kl.map((k,i)=> oiAt[i]==null ? null : {time:times[i], value:oiAt[i]}).filter(Boolean));
    s.oi.priceScale().applyOptions({ scaleMargins:{top:0.12, bottom:0.08} });
  }
  if(cxState.show.fund){
    s.fund = chart.addSeries(L.HistogramSeries, { priceScaleId:'right', lastValueVisible:true, priceLineVisible:false, base:0,
      priceFormat:{type:'custom', formatter: v => (v>0?'+':'')+v.toFixed(3)+'%', minMove:0.0001} }, pane++);
    s.fund.setData(kl.map((k,i)=> fundAt[i]==null ? null : {time:times[i], value:fundAt[i]*100,
      color: fundAt[i]*100 >= CROWD.fundLong ? CH.down : fundAt[i]*100 <= CROWD.fundShort ? CH.up : 'rgba(124,135,155,.6)'}).filter(Boolean));
    s.fund.priceScale().applyOptions({ scaleMargins:{top:0.12, bottom:0.08} });
    [CROWD.fundLong, CROWD.fundShort].forEach(v=> s.fund.createPriceLine({ price:v, color:'rgba(124,135,155,.5)', lineWidth:1, lineStyle:L.LineStyle.Dashed, axisLabelVisible:true, title:'' }));
  }
  if(cxState.show.ls){
    s.ls = chart.addSeries(L.LineSeries, { priceScaleId:'right', color:CH.pend, lineWidth:2, priceLineVisible:false, lastValueVisible:true,
      priceFormat:{type:'custom', formatter: v => v.toFixed(1)+'%', minMove:0.1} }, pane++);
    s.ls.setData(kl.map((k,i)=> lsAt[i]==null ? null : {time:times[i], value:lsAt[i]*100}).filter(Boolean));
    s.ls.priceScale().applyOptions({ scaleMargins:{top:0.12, bottom:0.08} });
    [CROWD.ratioLong*100, CROWD.ratioShort*100].forEach(v=> s.ls.createPriceLine({ price:v, color:'rgba(124,135,155,.5)', lineWidth:1, lineStyle:L.LineStyle.Dashed, axisLabelVisible:true, title:'' }));
  }
  // the price pane gets the room; the others share the rest and can be dragged
  try{ const ps = chart.panes(); ps[0].setStretchFactor(3); for(let i=1;i<ps.length;i++) ps[i].setStretchFactor(1); }catch(e){}

  /* the legend, TradingView-style: one line per pane, following the crosshair */
  const legend = $('cx-legend');
  const f = v => v==null ? '·' : fmtUsd(v).replace('$','');
  const paint = param => {
    if(!legend) return;
    let i = kl.length-1;
    if(param && param.time != null){ const found = times.indexOf(param.time); if(found >= 0) i = found; }
    const k = kl[i];
    const fp = fundAt[i]==null ? null : fundAt[i]*100;
    const fr = crowdFundingRead(fp), rr = crowdRatioRead(lsAt[i]);
    const tone = x => x.side==='long' ? 'down' : x.side==='short' ? 'up' : 'mute';
    legend.innerHTML =
      '<span>'+nvEsc(sym)+' <b>'+nvEsc(tf.key)+'</b> <em>'+new Date(k.t).toLocaleString()+'</em></span>'+
      '<span class="'+(k.c>=k.o?'up':'down')+'">O '+f(k.o)+'  H '+f(k.h)+'  L '+f(k.l)+'  C '+f(k.c)+
        '  <em>'+((k.c-k.o)/k.o*100>=0?'+':'')+((k.c-k.o)/k.o*100).toFixed(2)+'%</em></span>'+
      (cxState.show.vol ? '<span class="mute">Vol '+fmtVol(k.v)+'</span>' : '')+
      (cxState.show.oi ? '<span class="ev">OI '+(oiAt[i]==null ? '·' : fmtVol(oiAt[i]))+'</span>' : '')+
      (cxState.show.fund ? '<span class="'+tone(fr)+'">Funding '+(fp==null ? '·' : (fp>0?'+':'')+fp.toFixed(4)+'%')+'</span>' : '')+
      (cxState.show.ls ? '<span class="'+tone(rr)+'">Long '+(lsAt[i]==null ? '·' : (lsAt[i]*100).toFixed(1)+'%')+'</span>' : '');
  };
  chart.subscribeCrosshairMove(paint);
  paint(null);
  chart.timeScale().fitContent();
  cxDefaultView();

  const note = $('cx-note');
  const first = t => t ? new Date(t).toLocaleDateString() : '—';
  if(note) note.textContent = kl.length+' bars ('+tf.label.toLowerCase()+') from '+first(kl[0].t)+
    ' · OI ('+tf.oi+') from '+first(d.oi.length && d.oi[0].t)+' · funding from '+first(d.fund.length && d.fund[0].t)+
    ' · accounts ('+tf.ratio+') from '+first(d.ratio.length && d.ratio[0].t)+
    '. Wheel zooms, drag pans, drag an axis to scale it, drag a pane separator to resize it; Reset undoes all of that. '+
    'Bybit keeps less positioning history than price, so the far left of a long chart may be price alone.';
}
