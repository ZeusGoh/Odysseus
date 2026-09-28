/* charts.js — Charts. Lightweight Charts v5 (vendored) in three panes, a hand-drawn canvas fallback when it does not load.
   part of Odysseus */

/* ---------- chart picker ---------- */
function buildPicker(){
  const box = $('tfpick');
  box.innerHTML = '';
  TFS.forEach(tf=>{
    const b = document.createElement('button');
    b.className = 'tfbtn';
    b.textContent = tf.key;
    b.title = tf.label;
    b.setAttribute('aria-pressed', shown.includes(tf.key));
    b.onclick = ()=>{
      shown = shown.includes(tf.key) ? shown.filter(x=>x!==tf.key) : [...shown, tf.key];
      buildPicker(); buildCharts();
    };
    box.appendChild(b);
  });
  $('pickall').textContent = shown.length===5 ? 'Daily only' : 'All frames';
}

/* ---------- TradingView Lightweight Charts ---------- */
/*  Lightweight Charts v5, vendored (vendor/lightweight-charts.standalone.production.js).
    Three panes on one time axis, the way tradingview.com lays a chart out: price
    with the EMA on top, volume as a thin band, the stochastic underneath on its own
    0–100 scale. The crosses, divergence lines, backtest notes and rejected-line
    diagnostics are the app's own and draw exactly as before; what is new is the
    chart chrome — candles/bars/line, log scale, fit, horizontal and trend lines
    that are remembered per coin and frame, and a full-screen view.               */
const LWC = () => (typeof LightweightCharts !== 'undefined' && !window.__lwcFailed &&
                   typeof LightweightCharts.createSeriesMarkers === 'function') ? LightweightCharts : null;
const panes = {};

const CHART_KEY = 'vl.chart.v1';          // {type, log} — shared by every frame
const DRAW_KEY  = 'vl.draw.v1';           // {"BTC|linear|1D": {h:[price…], t:[[t1,p1,t2,p2]…]}}
const chartPrefs = (() => {
  try { return Object.assign({type:'candles', log:false}, JSON.parse(localStorage.getItem(CHART_KEY)||'{}')); }
  catch(e){ return {type:'candles', log:false}; }
})();
function savePrefs(){ try{ localStorage.setItem(CHART_KEY, JSON.stringify(chartPrefs)); }catch(e){} }
function drawStore(){ try{ return JSON.parse(localStorage.getItem(DRAW_KEY)||'{}'); }catch(e){ return {}; } }
function drawSave(all){ try{ localStorage.setItem(DRAW_KEY, JSON.stringify(all)); }catch(e){} }
function drawKey(key){ return symbolOf(active).sym+'|'+MARKET+'|'+key; }
function drawGet(key){ const d = drawStore()[drawKey(key)]; return Array.isArray(d) ? d : []; }   // [{k:'h',p} | {k:'t',a:[t,p],b:[t,p]}], oldest first
function drawPut(key, list){ const all = drawStore(); if(list.length) all[drawKey(key)] = list; else delete all[drawKey(key)]; drawSave(all); }

function disposePanes(){
  Object.values(panes).forEach(p=>{ if(p.fitFull) window.removeEventListener('resize', p.fitFull); try{ p.chart.remove(); }catch(e){} });
  Object.keys(panes).forEach(k=> delete panes[k]);
  document.body.classList.remove('chart-expanded');
}

/* TradingView's own dark-theme palette — up/down candles, grid and axis
   borders match tradingview.com exactly, so a chart lifted out of this app
   and one opened there read as the same instrument. */
const CH = {
  up:'#089981', down:'#F23645', pend:'#F5A524', mute:'#7C879B',
  grid:'#151B26', edge:'#232B38', text:'#7C879B', draw:'#6E7BFF',
  font:'"Geist","Inter Tight",system-ui,sans-serif'
};
const secs = t => Math.floor(t/1000);

function priceFormatFor(v){
  // decimals a price axis can afford: none above 1,000 (84,240 says it), and a
  // narrower axis is the whole chart's width on a phone
  const dp = v>=1000 ? 0 : v>=100 ? 1 : v>=1 ? 3 : v>=0.01 ? 5 : 7;
  return {type:'price', precision:dp, minMove:Math.pow(10,-dp)};
}

/*  The price series is whichever shape the toolbar asks for; it is rebuilt in
    place when the shape changes, and the drawings that hang off it come back. */
function makePriceSeries(pane){
  const L = LWC();
  const base = { priceScaleId:'right', priceLineVisible:true, priceLineColor:CH.mute, priceLineStyle:2, lastValueVisible:true };
  let s;
  if(chartPrefs.type === 'line'){
    s = pane.chart.addSeries(L.LineSeries, {...base, color:'#C9D1E3', lineWidth:2, crosshairMarkerRadius:3}, 0);
  } else if(chartPrefs.type === 'bars'){
    s = pane.chart.addSeries(L.BarSeries, {...base, upColor:CH.up, downColor:CH.down, thinBars:false, openVisible:true}, 0);
  } else {
    s = pane.chart.addSeries(L.CandlestickSeries, {...base, upColor:CH.up, downColor:CH.down, borderVisible:false,
                                                    wickUpColor:CH.up, wickDownColor:CH.down}, 0);
  }
  s.priceScale().applyOptions({ mode: chartPrefs.log ? L.PriceScaleMode.Logarithmic : L.PriceScaleMode.Normal,
                                borderColor:CH.edge, scaleMargins:{top:0.08, bottom:0.04} });
  return s;
}
const priceRow = c => chartPrefs.type === 'line'
  ? {time:secs(c.t), value:c.c}
  : {time:secs(c.t), open:c.o, high:c.h, low:c.l, close:c.c};

function buildPane(tf, el, H){
  const L = LWC();
  el.style.height = H+'px';
  const phone = window.innerWidth < 640;
  const chart = L.createChart(el, {
    autoSize:true,
    layout:{ background:{type:'solid', color:'transparent'}, textColor:CH.text,
             fontFamily:CH.font, fontSize:phone ? 9.5 : 10.5, attributionLogo:true,
             panes:{ separatorColor:CH.edge, separatorHoverColor:'rgba(110,123,255,.22)', enableResize:true } },
    grid:{ vertLines:{color:CH.grid}, horzLines:{color:CH.grid} },
    rightPriceScale:{ borderColor:CH.edge },
    timeScale:{ borderColor:CH.edge, timeVisible:true, secondsVisible:false, rightOffset:4 },
    crosshair:{ mode:1,
      vertLine:{color:CH.draw, width:1, style:2, labelBackgroundColor:'#1A2130'},
      horzLine:{color:CH.draw, width:1, style:2, labelBackgroundColor:'#1A2130'} },
    handleScale:{ axisPressedMouseMove:{time:true, price:true} }
  });
  const pane = {chart, tf, divs:[], lastT:0, tool:null, pending:null, hlines:[], trends:[], legend:null};

  pane.price = makePriceSeries(pane);
  pane.emaLine = chart.addSeries(L.LineSeries, {priceScaleId:'right', color:CH.draw, lineWidth:1.5,
    priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false}, 0);

  // volume: its own thin pane, coloured by the bar
  pane.vol = chart.addSeries(L.HistogramSeries, { priceFormat:{type:'volume'},
    lastValueVisible:false, priceLineVisible:false }, 1);
  pane.vol.priceScale().applyOptions({ scaleMargins:{top:0.15, bottom:0}, borderColor:CH.edge });

  // the stochastic: %K and %D on a pinned 0–100 scale, 20/50/80 ruled
  const pin = () => ({ priceRange:{ minValue:0, maxValue:100 } });
  const pct = { type:'price', precision:1, minMove:0.1 };
  pane.kLine = chart.addSeries(L.LineSeries, {color:CH.up, lineWidth:2, priceLineVisible:false, priceFormat:pct,
    lastValueVisible:true, crosshairMarkerRadius:3, autoscaleInfoProvider:pin}, 2);
  pane.dLine = chart.addSeries(L.LineSeries, {color:CH.pend, lineWidth:1, priceLineVisible:false, priceFormat:pct,
    lastValueVisible:true, crosshairMarkerRadius:3, autoscaleInfoProvider:pin}, 2);
  pane.kLine.priceScale().applyOptions({ scaleMargins:{top:0.06, bottom:0.06}, borderColor:CH.edge });
  [20,50,80].forEach(v=> pane.kLine.createPriceLine({
    price:v, color: v===50 ? CH.grid : CH.edge, lineWidth:1,
    lineStyle: v===50 ? 2 : 0, axisLabelVisible:false, title:''
  }));
  pane.markers = L.createSeriesMarkers(pane.kLine, []);

  // the price pane gets the room, the stochastic a third, volume a sliver
  const ps = chart.panes();
  if(ps[0]) ps[0].setStretchFactor(56);
  if(ps[1]) ps[1].setStretchFactor(11);
  if(ps[2]) ps[2].setStretchFactor(33);

  // crosshair legend: OHLC plus every indicator value for the hovered bar
  const legend = document.getElementById('oh-'+tf.key);
  const paint = param => {
    if(!legend) return;
    const st = stoch[active] && stoch[active][tf.key];
    if(!st || !st.candles.length) return;
    let idx = st.candles.length-1;
    if(param && param.time){
      const t = param.time*1000;
      const found = st.candles.findIndex(c=>c.t===t);
      if(found>=0) idx = found;
    }
    const c = st.candles[idx];
    if(!c) return;
    const f = v => v==null ? '·' : fmtUsd(v).replace('$','');
    const e = (st.ema && st.ema.ok) ? st.ema.arr[idx] : null;
    legend.innerHTML =
      '<span>'+symbolOf(active).sym+' <b>'+tf.label+'</b></span>'+
      '<span class="'+(c.c>=c.o?'up':'down')+'">O '+f(c.o)+'  H '+f(c.h)+'  L '+f(c.l)+'  C '+f(c.c)+'</span>'+
      '<span class="ev">EMA200 '+(e==null?'n/a':f(e))+'</span>'+
      '<span><span class="kv">%K '+(st.k[idx]==null?'·':st.k[idx].toFixed(1))+'</span>'+
      '  <span class="dv">%D '+(st.d[idx]==null?'·':st.d[idx].toFixed(1))+'</span></span>';
  };
  chart.subscribeCrosshairMove(paint);
  pane.paint = paint;

  // drawing: a click (or a tap) on the price pane places what the toolbar chose
  chart.subscribeClick(param => {
    if(!pane.tool || !param.point || param.time == null) return;
    if(param.paneIndex !== undefined && param.paneIndex !== 0) return;
    const price = pane.price.coordinateToPrice(param.point.y);
    if(price == null || !isFinite(price)) return;
    const d = drawGet(tf.key);
    if(pane.tool === 'h'){
      d.push({k:'h', p:+price}); drawPut(tf.key, d); applyDrawings(pane);
      setTool(pane, null);
    } else if(pane.tool === 't'){
      if(!pane.pending){ pane.pending = {t:param.time, p:+price}; paintToolbar(pane); return; }
      const a = pane.pending, b = {t:param.time, p:+price};
      pane.pending = null;
      if(a.t === b.t) { setTool(pane, null); return; }
      const [f, l] = a.t < b.t ? [a, b] : [b, a];
      d.push({k:'t', a:[f.t, f.p], b:[l.t, l.p]});
      drawPut(tf.key, d); applyDrawings(pane);
      setTool(pane, null);
    }
  });

  return pane;
}

/* ---- drawings: horizontal lines are price lines on the price series, trend
        lines are two-point series on the price pane; both come from the store ---- */
function applyDrawings(pane){
  const L = LWC();
  pane.hlines.forEach(pl=>{ try{ pane.price.removePriceLine(pl); }catch(e){} });
  pane.trends.forEach(sr=>{ try{ pane.chart.removeSeries(sr); }catch(e){} });
  pane.hlines = []; pane.trends = [];
  drawGet(pane.tf.key).forEach(it=>{
    if(it.k === 'h'){
      pane.hlines.push(pane.price.createPriceLine({ price:it.p, color:CH.draw, lineWidth:1, lineStyle:0,
        axisLabelVisible:true, title:'' }));
    } else if(it.k === 't'){
      const sr = pane.chart.addSeries(L.LineSeries, { priceScaleId:'right', color:CH.draw, lineWidth:1.5,
        priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
        autoscaleInfoProvider:()=>null }, 0);
      sr.setData([{time:it.a[0], value:it.a[1]}, {time:it.b[0], value:it.b[1]}]);
      pane.trends.push(sr);
    }
  });
  paintToolbar(pane);
}
function setTool(pane, tool){
  pane.tool = pane.tool === tool ? null : tool;
  pane.pending = null;
  const el = pane.chart.chartElement ? pane.chart.chartElement() : null;
  if(el) el.style.cursor = pane.tool ? 'crosshair' : '';
  paintToolbar(pane);
}
function undoDrawing(pane){ const d = drawGet(pane.tf.key); d.pop(); drawPut(pane.tf.key, d); applyDrawings(pane); }
function clearDrawings(pane){ drawPut(pane.tf.key, []); applyDrawings(pane); }

/* ---- the toolbar under each chart's header ---- */
function buildToolbar(tf){
  const b = (act, label, title) => '<button class="cbtn" data-act="'+act+'" title="'+title+'">'+label+'</button>';
  return '<div class="cbar" id="cb-'+tf.key+'">'+
    '<span class="cbgrp cbtype">'+b('type:candles','Candles','Candlesticks')+b('type:bars','Bars','OHLC bars')+b('type:line','Line','Close line')+'</span>'+
    '<span class="cbgrp">'+b('log','Log','Logarithmic price scale')+b('fit','Fit','Fit every loaded bar')+b('now','Now','Back to the latest bars')+'</span>'+
    '<span class="cbgrp cbdraw">'+b('tool:h','— Line','Horizontal line: click the price where it goes')+
      b('tool:t','⟋ Trend','Trend line: click its two ends')+b('undo','Undo','Remove the last drawing')+b('clear','Clear','Remove every drawing on this frame')+'</span>'+
    '<span class="cbgrp cbright">'+b('expand','⤢ Full','Fill the screen')+'</span>'+
    '</div>';
}
function paintToolbar(pane){
  const bar = document.getElementById('cb-'+pane.tf.key);
  if(!bar) return;
  const d = drawGet(pane.tf.key);
  bar.querySelectorAll('[data-act]').forEach(btn=>{
    const a = btn.getAttribute('data-act');
    let on = false, dis = false, label = null;
    if(a.startsWith('type:')) on = chartPrefs.type === a.slice(5);
    else if(a === 'log') on = chartPrefs.log;
    else if(a === 'tool:h') on = pane.tool === 'h';
    else if(a === 'tool:t'){ on = pane.tool === 't'; label = pane.tool === 't' && pane.pending ? '⟋ 2nd end' : '⟋ Trend'; }
    else if(a === 'undo' || a === 'clear') dis = !d.length;
    else if(a === 'expand'){ const box = bar.closest('.chartmod'); label = box && box.classList.contains('expanded') ? '✕ Close' : '⤢ Full'; }
    btn.classList.toggle('on', on);
    btn.disabled = dis;
    if(label) btn.textContent = label;
  });
}
function toolbarAction(pane, act){
  if(act.startsWith('type:')){ chartPrefs.type = act.slice(5); savePrefs(); Object.values(panes).forEach(rebuildPrice); }
  else if(act === 'log'){ chartPrefs.log = !chartPrefs.log; savePrefs();
    Object.values(panes).forEach(p=>{ p.price.priceScale().applyOptions({mode: chartPrefs.log ? LWC().PriceScaleMode.Logarithmic : LWC().PriceScaleMode.Normal}); paintToolbar(p); }); }
  else if(act === 'fit'){ pane.chart.timeScale().fitContent(); }
  else if(act === 'now'){ const st = stoch[active] && stoch[active][pane.tf.key]; const n = st ? st.candles.length : 0;
    pane.chart.timeScale().setVisibleLogicalRange({from: Math.max(0, n-160), to: n+4}); }
  else if(act === 'tool:h'){ setTool(pane, 'h'); }
  else if(act === 'tool:t'){ setTool(pane, 't'); }
  else if(act === 'undo'){ undoDrawing(pane); }
  else if(act === 'clear'){ clearDrawings(pane); }
  else if(act === 'expand'){ expandChart(pane); }
}
function rebuildPrice(pane){
  const st = stoch[active] && stoch[active][pane.tf.key];
  try{ pane.chart.removeSeries(pane.price); }catch(e){}
  pane.hlines = [];                            // they went with the series
  pane.price = makePriceSeries(pane);
  if(st){ pane.price.applyOptions({priceFormat: priceFormatFor(st.candles[st.candles.length-1].c)});
          pane.price.setData(st.candles.map(priceRow)); }
  applyDrawings(pane);
}

/* ---- full screen: the panel takes the viewport, the chart takes the panel ---- */
function expandChart(pane){
  const box = document.getElementById('cb-'+pane.tf.key).closest('.chartmod');
  const el = document.getElementById('pp-'+pane.tf.key);
  const open = !box.classList.contains('expanded');
  document.querySelectorAll('.chartmod.expanded').forEach(b=>{ if(b!==box) b.classList.remove('expanded'); });
  box.classList.toggle('expanded', open);
  document.body.classList.toggle('chart-expanded', open);
  if(open){
    const fit = () => { const used = Array.from(box.children).filter(c=>c!==el.parentNode).reduce((a,c)=>a+c.getBoundingClientRect().height, 0)
                        + (document.getElementById('oh-'+pane.tf.key)||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height;
                        el.style.height = Math.max(240, window.innerHeight - used - 2)+'px'; };
    fit(); pane.fitFull = fit; window.addEventListener('resize', fit);
  } else {
    if(pane.fitFull) window.removeEventListener('resize', pane.fitFull);
    el.style.height = pane.H+'px';
  }
  paintToolbar(pane);
}
document.addEventListener('keydown', e=>{
  if(e.key !== 'Escape') return;
  const open = document.querySelector('.chartmod.expanded');
  if(!open) return;
  const key = open.querySelector('.cbar').id.slice(3);
  if(panes[key]) expandChart(panes[key]);
});

function paintDivergences(pane, key){
  const L = LWC();
  pane.divs.forEach(sr=>{ try{ pane.chart.removeSeries(sr); }catch(e){} });
  pane.divs = [];
  const st = stoch[active][key];
  if(!st) return;
  // with a thousand bars loaded there can be dozens of historic runs; draw only
  // the recent window so the chart stays readable
  const cutoff = st.candles.length - 260;
  (divsAll[active][key]||[]).filter(dv=>dv.to >= cutoff).forEach(dv=>{
    const col = dv.dir==='bull' ? CH.up : CH.down;
    const common = { color:col, lineWidth:2, lineStyle: dv.hidden ? L.LineStyle.Dotted : L.LineStyle.Dashed,
                     priceLineVisible:false, lastValueVisible:false,
                     crosshairMarkerVisible:false, pointMarkersVisible:true };
    const pPts = dv.points.map(pt=>({
      time:secs(st.candles[pt.priceIdx].t),
      value: dv.dir==='bull' ? st.candles[pt.priceIdx].l : st.candles[pt.priceIdx].h
    }));
    const sPts = dv.points.map(pt=>({time:secs(st.candles[pt.kIdx].t), value:st.k[pt.kIdx]}))
                          .filter(x=>x.value!=null);
    if(pPts.length>1){
      const sr = pane.chart.addSeries(L.LineSeries, {...common, priceScaleId:'right', autoscaleInfoProvider:()=>null}, 0);
      sr.setData(pPts); pane.divs.push(sr);
    }
    if(sPts.length>1){
      const sr = pane.chart.addSeries(L.LineSeries, {...common, autoscaleInfoProvider:()=>({priceRange:{minValue:0,maxValue:100}})}, 2);
      sr.setData(sPts); pane.divs.push(sr);
    }
  });
}

function paintMarkers(pane, key){
  const st = stoch[active][key];
  if(!st) return;
  pane.markers.setMarkers(crossPoints(st.k, st.d).map(p=>{
    const open = p.i === st.liveBar;
    return { time: secs(st.candles[p.i].t),
             position: p.dir==='bull' ? 'belowBar' : 'aboveBar',
             color: open ? CH.pend : (p.dir==='bull' ? CH.up : CH.down),
             shape: p.dir==='bull' ? 'arrowUp' : 'arrowDown', size:0.7 };
  }));
}

function feedPane(pane, key){
  const st = stoch[active][key];
  if(!st) return;
  const cs = st.candles;
  pane.price.applyOptions({priceFormat: priceFormatFor(cs[cs.length-1].c)});
  pane.price.setData(cs.map(priceRow));
  const line = arr => cs.map((c,i)=> arr[i]==null ? null : ({time:secs(c.t), value:arr[i]})).filter(Boolean);
  pane.kLine.setData(line(st.k));
  pane.dLine.setData(line(st.d));
  pane.vol.setData(cs.map(c=>({
    time:secs(c.t), value:c.v||0,
    color: c.c>=c.o ? 'rgba(8,153,129,.45)' : 'rgba(242,54,69,.45)'
  })));
  if(pane.paint) pane.paint(null);
  pane.emaLine.setData(st.ema && st.ema.ok ? line(st.ema.arr) : []);
  paintMarkers(pane, key);
  paintDivergences(pane, key);
  applyDrawings(pane);
  pane.lastT = cs[cs.length-1].t;
  // a thousand bars fitted to the pane is unreadable — open on the recent window
  const n = cs.length;
  pane.chart.timeScale().setVisibleLogicalRange({from: Math.max(0, n-160), to: n+4});
}

function nudgePane(pane, key){
  const st = stoch[active][key];
  if(!st) return;
  const cs = st.candles, last = cs[cs.length-1], n = st.k.length-1;
  pane.price.update(priceRow(last));
  if(st.k[n]!=null) pane.kLine.update({time:secs(last.t), value:st.k[n]});
  if(st.d[n]!=null) pane.dLine.update({time:secs(last.t), value:st.d[n]});
  pane.vol.update({time:secs(last.t), value:last.v||0,
    color: last.c>=last.o ? 'rgba(8,153,129,.45)' : 'rgba(242,54,69,.45)'});
  if(pane.paint) pane.paint(null);
  if(st.ema && st.ema.ok){
    const ev = st.ema.arr[st.ema.arr.length-1];
    if(ev!=null) pane.emaLine.update({time:secs(last.t), value:ev});
  }
}

function buildCharts(){
  const host = $('charts');
  disposePanes();
  host.innerHTML = '';
  const order = TFS.filter(t=>shown.includes(t.key));
  if(!order.length){
    host.innerHTML = '<p class="empty">No frames selected.</p>';
    return;
  }
  const phone = window.innerWidth < 640;
  const H = phone ? 480 : (order.length>2 ? 460 : 560);
  const live = !!LWC();

  order.forEach(tf=>{
    const box = document.createElement('section');
    box.className = 'mod chartmod';
    box.innerHTML =
      '<header><h2 id="ct-'+tf.key+'">'+symbolOf(active).sym+'/USDT <em>'+tf.label+'</em></h2>'+
      '<div class="legend"><span><i style="background:var(--up)"></i>%K</span>'+
      '<span><i style="background:var(--pend)"></i>%D</span>'+
      '<span><i style="background:#6E7BFF"></i>EMA 200</span>'+
      '<span>arrows mark crosses</span><span>dashed marks divergence</span><span>dotted marks hidden divergence</span></div></header>'+
      (live ? buildToolbar(tf)+'<div class="panewrap"><div class="ohlc" id="oh-'+tf.key+'"></div>'+
              '<div class="pane" id="pp-'+tf.key+'"></div></div>'
            : '<canvas id="cv-'+tf.key+'" height="'+H+'"></canvas>')+
      '<div class="whylist" id="why-'+tf.key+'" hidden></div>';
    host.appendChild(box);
  });

  let anyFailed = false;
  order.forEach(tf=>{
    if(live){
      try{
        panes[tf.key] = buildPane(tf, $('pp-'+tf.key), H);
        panes[tf.key].H = H;
        feedPane(panes[tf.key], tf.key);
        $('cb-'+tf.key).addEventListener('click', e=>{
          const btn = e.target.closest('[data-act]');
          if(btn && panes[tf.key]) toolbarAction(panes[tf.key], btn.getAttribute('data-act'));
        });
      }catch(e){
        // charting library present but unusable here — swap this pane for the built-in renderer
        console.warn('falling back to the built-in chart for '+tf.key, e);
        anyFailed = true;
        delete panes[tf.key];
        const box = $('pp-'+tf.key).parentNode;
        const bar = $('cb-'+tf.key); if(bar) bar.remove();
        $('pp-'+tf.key).remove();
        const cv = document.createElement('canvas');
        cv.id = 'cv-'+tf.key; cv.height = H;
        box.insertBefore(cv, $('why-'+tf.key));
        drawCanvas(tf.key, H);
      }
    } else {
      drawCanvas(tf.key, H);
    }
  });
  if(!live || anyFailed) redrawWhy();
}

// full repaint — used when signals change or the window resizes
function redraw(){
  const order = TFS.filter(t=>shown.includes(t.key));
  const H = order.length>2 ? 460 : 560;
  if(LWC()){
    order.forEach(tf=>{
      const pane = panes[tf.key];
      if(!pane){ drawCanvas(tf.key, H); return; }   // this one fell back
      const st = stoch[active] && stoch[active][tf.key];
      if(!st) return;
      const lastT = st.candles[st.candles.length-1].t;
      if(lastT !== pane.lastT){        // a bar closed: reload and re-anchor overlays
        feedPane(pane, tf.key);
      } else {
        nudgePane(pane, tf.key);
        paintMarkers(pane, tf.key);
        paintDivergences(pane, tf.key);
      }
      const h2 = $('ct-'+tf.key);
      if(h2) h2.innerHTML = symbolOf(active).sym+'/USDT <em>'+tf.label+'</em>';
    });
  } else {
    order.forEach(tf=>drawCanvas(tf.key, H));
  }
  redrawWhy();
}

// the cheap per-second path: nothing but the last candle moves
function nudgeCharts(){
  if(!LWC()) return;
  TFS.filter(t=>shown.includes(t.key)).forEach(tf=>{
    const pane = panes[tf.key];
    if(!pane) return;
    const st = stoch[active] && stoch[active][tf.key];
    if(!st) return;
    const lastT = st.candles[st.candles.length-1].t;
    if(lastT !== pane.lastT) feedPane(pane, tf.key); else nudgePane(pane, tf.key);
  });
}

// rejected-line diagnostics live outside the chart canvas now
function redrawWhy(){
  TFS.filter(t=>shown.includes(t.key)).forEach(tf=>{
    const box = $('why-'+tf.key);
    if(!box) return;
    const st = stoch[active] && stoch[active][tf.key];
    const all = (divsAll[active] && divsAll[active][tf.key]) || [];
    const rs = (all.rejected||[]);
    if(!$('why').checked || !rs.length || !st){ box.innerHTML=''; box.hidden = true; return; }
    const n = st.candles.length-1;
    box.hidden = false;
    box.innerHTML = rs.slice(-8).map(r=>
      '<b>'+(r.dir==='bull'?'bullish':'bearish')+'</b> '+(n-r.from)+' to '+(n-r.to)+
      ' bars back, %K '+r.level[0].toFixed(0)+' to '+r.level[1].toFixed(0)+' — '+r.why).join('<br>');
  });
}

/* ---------- chart ---------- */
function drawCanvas(key, H){
  const cv = document.getElementById('cv-'+key), st = stoch[active] && stoch[active][key];
  if(!cv || !st) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth;
  cv.width = W*dpr; cv.height = H*dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr,0,0,dpr,0,0);
  g.clearRect(0,0,W,H);

  const show = Math.min(100, st.candles.length);
  const s0 = st.candles.length - show;
  const cs = st.candles.slice(s0);
  const k = st.k.slice(s0), d = st.d.slice(s0);

  const padL = 6, padR = 54, padT = 8, gapY = 22;
  const pH = Math.round((H-padT-gapY)*0.56), sH = H-padT-gapY-pH;
  const pTop = padT, sTop = padT+pH+gapY;
  const plotW = W-padL-padR, step = plotW/show;
  const x = i => padL + (i+0.5)*step;
  const cw = Math.max(2, step*0.62);

  let hi=-Infinity, lo=Infinity;
  cs.forEach(c=>{ if(c.h>hi)hi=c.h; if(c.l<lo)lo=c.l; });
  const pd=(hi-lo)*0.06; hi+=pd; lo-=pd;
  const py = v => pTop + (hi-v)/(hi-lo)*pH;
  const sy = v => sTop + (100-Math.max(0,Math.min(100,v)))/100*sH;

  const css = getComputedStyle(document.documentElement);
  const C = n => css.getPropertyValue(n).trim();

  g.fillStyle = 'rgba(62,207,142,.06)'; g.fillRect(padL, sy(20), plotW, sH*0.20);
  g.fillStyle = 'rgba(240,97,109,.06)'; g.fillRect(padL, sy(100), plotW, sH*0.20);
  g.lineWidth = 1; g.font = '11px Geist, system-ui, sans-serif'; g.textBaseline='middle';
  [0,20,50,80,100].forEach(v=>{
    g.strokeStyle = C('--edge');
    g.beginPath(); g.setLineDash(v===50?[3,4]:[]);
    g.moveTo(padL,sy(v)+.5); g.lineTo(padL+plotW,sy(v)+.5); g.stroke();
    g.fillStyle = C('--mute'); g.fillText(v, padL+plotW+8, sy(v));
  });
  g.setLineDash([]);

  for(let n=0;n<=3;n++){
    const v = lo + (hi-lo)*n/3;
    g.strokeStyle = C('--edge');
    g.beginPath(); g.moveTo(padL,py(v)+.5); g.lineTo(padL+plotW,py(v)+.5); g.stroke();
    g.fillStyle = C('--mute');
    const label = hi>=100 ? Math.round(v).toLocaleString('en-US')
                : hi>=1  ? v.toFixed(2)
                         : v.toFixed(hi>=0.01?4:6);
    g.fillText(label, padL+plotW+8, py(v));
  }

  cs.forEach((c,i)=>{
    const up = c.c>=c.o, col = up ? C('--up') : C('--down');
    g.strokeStyle = col; g.fillStyle = col;
    g.beginPath(); g.moveTo(Math.round(x(i))+.5, py(c.h)); g.lineTo(Math.round(x(i))+.5, py(c.l)); g.stroke();
    const yo=py(c.o), yc=py(c.c);
    g.globalAlpha = up ? 0.85 : 1;
    g.fillRect(x(i)-cw/2, Math.min(yo,yc), cw, Math.max(1.5,Math.abs(yc-yo)));
    g.globalAlpha = 1;
  });

  // every divergence in view — a run across 3+ crosses draws as one line
  (divsAll[active][key]||[]).forEach(dv=>{
    const pp = dv.points.filter(p=>p.priceIdx>=s0);
    if(pp.length<2) return;
    const col = dv.dir==='bull' ? C('--up') : C('--down');
    const price = dv.dir==='bull' ? c=>c.l : c=>c.h;
    // regular divergence dashes; hidden (continuation) dots — same colour, different claim
    g.strokeStyle=col; g.lineWidth=1.6; g.setLineDash(dv.hidden ? [1.5,3.5] : [5,4]); g.globalAlpha = dv.pending ? .55 : .95;

    g.beginPath();
    pp.forEach((pt,i)=>{
      const xi = pt.priceIdx-s0, yy = py(price(cs[xi]));
      i ? g.lineTo(x(xi),yy) : g.moveTo(x(xi),yy);
    });
    g.stroke();

    const kp = dv.points.filter(pt=>pt.kIdx>=s0 && k[pt.kIdx-s0]!=null);
    if(kp.length>1){
      g.beginPath();
      kp.forEach((pt,i)=>{
        const xi = pt.kIdx-s0, yy = sy(k[xi]);
        i ? g.lineTo(x(xi),yy) : g.moveTo(x(xi),yy);
      });
      g.stroke();
      g.setLineDash([]);
      kp.forEach(pt=>{
        const xi = pt.kIdx-s0;
        g.fillStyle = col; g.globalAlpha = .9;
        g.beginPath(); g.arc(x(xi), sy(k[xi]), 2.6, 0, Math.PI*2); g.fill();
      });
    }
    g.setLineDash([]); g.globalAlpha=1;
  });

  const box = document.getElementById('why-'+key);
  if(box){
    const rs = ((divsAll[active][key]||[]).rejected||[]).filter(r=>r.from>=s0);
    if($('why').checked && rs.length){
      g.strokeStyle = C('--mute'); g.lineWidth = 1; g.setLineDash([2,4]); g.globalAlpha=.7;
      rs.forEach(r=>{
        g.beginPath();
        g.moveTo(x(r.from-s0), sy(r.level[0]));
        g.lineTo(x(r.to-s0),   sy(r.level[1]));
        g.stroke();
      });
      g.setLineDash([]); g.globalAlpha=1;
      const n = st.candles.length-1;
      box.innerHTML = rs.slice(-8).map(r=>
        '<b>'+(r.dir==='bull'?'bullish':'bearish')+(r.hidden?' hidden':'')+'</b> '+(n-r.from)+'→'+(n-r.to)+
        ' bars back, %K '+r.level[0].toFixed(0)+'→'+r.level[1].toFixed(0)+' — '+r.why).join('<br>');
      box.hidden = false;
    } else { box.innerHTML = ''; box.hidden = true; }
  }

  const line = (arr,col,w)=>{
    g.strokeStyle=col; g.lineWidth=w; g.beginPath();
    let started=false;
    arr.forEach((v,i)=>{ if(v===null) return; started ? g.lineTo(x(i),sy(v)) : (g.moveTo(x(i),sy(v)), started=true); });
    g.stroke();
  };
  line(d, C('--pend'), 1.4);
  line(k, C('--up'), 2);

  // crosses: filled once the bar has closed, hollow while it is still open
  const liveIdx = st.liveBar - s0;
  crossPoints(st.k, st.d).forEach(p=>{
    const i = p.i - s0;
    if(i<0 || i>=k.length) return;
    const open = (p.i === st.liveBar);
    const col = open ? C('--pend') : (p.dir==='bull' ? C('--up') : C('--down'));
    marker(g, x(i), sy(k[i]) + (p.dir==='bull'?11:-11), col, p.dir==='bull', open);
  });
  if(liveIdx>=0 && liveIdx<k.length){
    g.strokeStyle = 'rgba(110,123,255,.40)'; g.setLineDash([2,3]); g.lineWidth=1;
    g.beginPath(); g.moveTo(x(liveIdx), pTop); g.lineTo(x(liveIdx), sTop+sH); g.stroke();
    g.setLineDash([]);
  }

  const meta = TFS.find(t=>t.key===key);
  const h2 = document.getElementById('ct-'+key);
  if(h2) h2.textContent = symbolOf(active).sym+'/USDT  '+meta.label+'  last '+show+' bars';
}

function marker(g,cx,cy,col,up,hollow){
  g.beginPath();
  if(up){ g.moveTo(cx,cy-6); g.lineTo(cx-5,cy+3); g.lineTo(cx+5,cy+3); }
  else  { g.moveTo(cx,cy+6); g.lineTo(cx-5,cy-3); g.lineTo(cx+5,cy-3); }
  g.closePath();
  if(hollow){ g.strokeStyle=col; g.lineWidth=1.6; g.stroke(); }
  else      { g.fillStyle=col; g.fill(); }
}
