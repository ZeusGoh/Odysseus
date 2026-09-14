/* charts.js — Charts. Lightweight Charts when it loads, a hand-drawn canvas fallback when it does not.
   part of VL */

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
/*  One chart, two price scales — candles on the right, stochastic on the left,
    separated vertically by scale margins. Two stacked charts could never be
    made to line up reliably because each sizes its own axis; sharing a single
    time axis removes the problem entirely.                                   */
const LWC = () => (typeof LightweightCharts !== 'undefined' && !window.__lwcFailed) ? LightweightCharts : null;
const panes = {};

function disposePanes(){
  Object.values(panes).forEach(p=>{ try{ p.chart.remove(); }catch(e){} });
  Object.keys(panes).forEach(k=> delete panes[k]);
}

/* TradingView's own dark-theme palette — up/down candles, grid and axis
   borders match tradingview.com exactly, so a chart lifted out of this app
   and one opened there read as the same instrument. */
const CH = {
  up:'#089981', down:'#F23645', pend:'#F5A524', mute:'#7C879B',
  grid:'#151B26', edge:'#232B38', text:'#7C879B',
  font:'"Geist","Inter Tight",system-ui,sans-serif'
};

const PRICE_TOP = 0.04, PRICE_BOTTOM = 0.44;   // candles occupy the upper 56%
const STOCH_TOP = 0.62, STOCH_BOTTOM = 0.04;   // stochastic the lower 34%
const secs = t => Math.floor(t/1000);

function priceFormatFor(v){
  const dp = v>=100 ? 2 : v>=1 ? 3 : v>=0.01 ? 5 : 7;
  return {type:'price', precision:dp, minMove:Math.pow(10,-dp)};
}

function buildPane(tf, el, H){
  const L = LWC();
  el.style.height = H+'px';
  const chart = L.createChart(el, {
    autoSize:true,
    layout:{ background:{type:'solid', color:'transparent'}, textColor:CH.text,
             fontFamily:CH.font, fontSize:10.5, attributionLogo:false },
    grid:{ vertLines:{color:CH.grid}, horzLines:{color:CH.grid} },
    rightPriceScale:{ visible:true, borderColor:CH.edge,
                      scaleMargins:{top:PRICE_TOP, bottom:PRICE_BOTTOM} },
    leftPriceScale:{  visible:true, borderColor:CH.edge,
                      scaleMargins:{top:STOCH_TOP, bottom:STOCH_BOTTOM} },
    timeScale:{ borderColor:CH.edge, timeVisible:true, secondsVisible:false, rightOffset:4 },
    crosshair:{ mode:1,
      vertLine:{color:'#6E7BFF', width:1, style:2, labelBackgroundColor:'#1A2130'},
      horzLine:{color:'#6E7BFF', width:1, style:2, labelBackgroundColor:'#1A2130'} },
    handleScale:{ axisPressedMouseMove:{time:true, price:false} }
  });

  const candles = chart.addCandlestickSeries({
    priceScaleId:'right',
    upColor:CH.up, downColor:CH.down, borderVisible:false,
    wickUpColor:CH.up, wickDownColor:CH.down, priceLineVisible:false
  });
  const emaLine = chart.addLineSeries({priceScaleId:'right', color:'#6E7BFF', lineWidth:1.5,
    priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false});
  const kLine = chart.addLineSeries({priceScaleId:'left', color:CH.up,   lineWidth:2,
    priceLineVisible:false, lastValueVisible:true, crosshairMarkerRadius:3});
  const dLine = chart.addLineSeries({priceScaleId:'left', color:CH.pend, lineWidth:1,
    priceLineVisible:false, lastValueVisible:true, crosshairMarkerRadius:3});

  const pin = () => ({ priceRange:{ minValue:0, maxValue:100 } });
  kLine.applyOptions({autoscaleInfoProvider:pin});
  dLine.applyOptions({autoscaleInfoProvider:pin});
  [20,50,80].forEach(v=> kLine.createPriceLine({
    price:v, color: v===50 ? CH.grid : CH.edge, lineWidth:1,
    lineStyle: v===50 ? 2 : 0, axisLabelVisible:false, title:''
  }));

  // volume in the band between the panes, the way a trading chart reads
  const vol = chart.addHistogramSeries({
    priceScaleId:'vol', priceFormat:{type:'volume'},
    lastValueVisible:false, priceLineVisible:false
  });
  // margins must sum below 1 — keep volume as a thin band above the stochastic pane
  chart.priceScale('vol').applyOptions({scaleMargins:{top:0.62, bottom:0.36}, visible:false});

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

  return {chart, candles, emaLine, kLine, dLine, vol, divs:[], lastT:0, paint};
}

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
    const common = { color:col, lineWidth:2, lineStyle:L.LineStyle.Dashed,
                     priceLineVisible:false, lastValueVisible:false,
                     crosshairMarkerVisible:false, pointMarkersVisible:true };
    const pPts = dv.points.map(pt=>({
      time:secs(st.candles[pt.priceIdx].t),
      value: dv.dir==='bull' ? st.candles[pt.priceIdx].l : st.candles[pt.priceIdx].h
    }));
    const sPts = dv.points.map(pt=>({time:secs(st.candles[pt.kIdx].t), value:st.k[pt.kIdx]}))
                          .filter(x=>x.value!=null);
    if(pPts.length>1){
      const sr = pane.chart.addLineSeries({...common, priceScaleId:'right'});
      sr.setData(pPts); pane.divs.push(sr);
    }
    if(sPts.length>1){
      const sr = pane.chart.addLineSeries({...common, priceScaleId:'left',
        autoscaleInfoProvider:()=>({priceRange:{minValue:0,maxValue:100}})});
      sr.setData(sPts); pane.divs.push(sr);
    }
  });
}

function paintMarkers(pane, key){
  const st = stoch[active][key];
  if(!st) return;
  pane.kLine.setMarkers(crossPoints(st.k, st.d).map(p=>{
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
  pane.candles.applyOptions({priceFormat: priceFormatFor(cs[cs.length-1].c)});
  pane.candles.setData(cs.map(c=>({time:secs(c.t), open:c.o, high:c.h, low:c.l, close:c.c})));
  const line = arr => cs.map((c,i)=> arr[i]==null ? null : ({time:secs(c.t), value:arr[i]})).filter(Boolean);
  pane.kLine.setData(line(st.k));
  pane.dLine.setData(line(st.d));
  if(pane.vol) pane.vol.setData(cs.map(c=>({
    time:secs(c.t), value:c.v||0,
    color: c.c>=c.o ? 'rgba(62,207,142,.28)' : 'rgba(240,97,109,.28)'
  })));
  if(pane.paint) pane.paint(null);
  pane.emaLine.setData(st.ema && st.ema.ok ? line(st.ema.arr) : []);
  paintMarkers(pane, key);
  paintDivergences(pane, key);
  pane.lastT = cs[cs.length-1].t;
  // a thousand bars fitted to the pane is unreadable — open on the recent window
  const n = cs.length;
  pane.chart.timeScale().setVisibleLogicalRange({from: Math.max(0, n-160), to: n+4});
}

function nudgePane(pane, key){
  const st = stoch[active][key];
  if(!st) return;
  const cs = st.candles, last = cs[cs.length-1], n = st.k.length-1;
  pane.candles.update({time:secs(last.t), open:last.o, high:last.h, low:last.l, close:last.c});
  if(st.k[n]!=null) pane.kLine.update({time:secs(last.t), value:st.k[n]});
  if(st.d[n]!=null) pane.dLine.update({time:secs(last.t), value:st.d[n]});
  if(pane.vol) pane.vol.update({time:secs(last.t), value:last.v||0,
    color: last.c>=last.o ? 'rgba(62,207,142,.28)' : 'rgba(240,97,109,.28)'});
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
  const H = order.length>2 ? 380 : 470;
  const live = !!LWC();

  order.forEach(tf=>{
    const box = document.createElement('section');
    box.className = 'mod chartmod';
    box.innerHTML =
      '<header><h2 id="ct-'+tf.key+'">'+symbolOf(active).sym+'/USDT <em>'+tf.label+'</em></h2>'+
      '<div class="legend"><span><i style="background:var(--up)"></i>%K</span>'+
      '<span><i style="background:var(--pend)"></i>%D</span>'+
      '<span><i style="background:#6E7BFF"></i>EMA 200</span>'+
      '<span>arrows mark crosses</span><span>dashed marks divergence</span></div></header>'+
      (live ? '<div class="panewrap"><div class="ohlc" id="oh-'+tf.key+'"></div>'+
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
        feedPane(panes[tf.key], tf.key);
      }catch(e){
        // charting library present but unusable here — swap this pane for the built-in renderer
        console.warn('falling back to the built-in chart for '+tf.key, e);
        anyFailed = true;
        delete panes[tf.key];
        const box = $('pp-'+tf.key).parentNode;
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
  const H = order.length>2 ? 380 : 470;
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
    g.strokeStyle=col; g.lineWidth=1.6; g.setLineDash([5,4]); g.globalAlpha = dv.pending ? .55 : .95;

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
        '<b>'+(r.dir==='bull'?'bullish':'bearish')+'</b> '+(n-r.from)+'→'+(n-r.to)+
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
