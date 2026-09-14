/* app.js — The app loop. What changed since last paint, the per-second light update, and load(),
   which pulls every shown frame and re-analyses it.
   part of Odysseus */

/* ---------- boot ---------- */
// A fingerprint of everything that would change the table's wording.
// Prices tick constantly; signals don't. Only redraw the table when this moves.
function signature(sym){
  return TFS.map(tf=>{
    const st = states[sym] && states[sym][tf.key], dv = divNow[sym] && divNow[sym][tf.key];
    return [tf.key, st&&st.type, st&&st.barsAgo, st&&st.pending,
            dv&&dv.dir, dv&&dv.pending, dv&&dv.legs].join(':');
  }).join('|');
}
let lastSig = '';

// Update the numbers that move every second without rebuilding the DOM.
let lastPx = null, flashTimer = null;
function paintPrice(){
  const daily = data[active] && data[active]['1D'];
  if(!daily || daily.length<2) return;
  const last = daily[daily.length-1], prev = daily[daily.length-2];
  const pct = (last.c-prev.c)/prev.c*100;
  const el = $('px');
  el.textContent = fmtUsd(last.c);
  // the one piece of motion in the app: show which way the last tick moved
  if(lastPx !== null && last.c !== lastPx){
    el.classList.remove('up','down');
    void el.offsetWidth;
    el.classList.add(last.c > lastPx ? 'up' : 'down');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(()=> el.classList.remove('up','down'), 600);
  }
  lastPx = last.c;
  if(!tickerOK){
    const chg = document.querySelector('.chg');
    chg.textContent = (pct>=0?'+':'') + pct.toFixed(2) + '%';
    chg.style.color = pct>=0 ? 'var(--up)' : 'var(--down)';
  }
}

function fmtVol(v){
  if(v>=1e9) return (v/1e9).toFixed(2)+'B';
  if(v>=1e6) return (v/1e6).toFixed(2)+'M';
  if(v>=1e3) return (v/1e3).toFixed(1)+'K';
  return v.toFixed(0);
}

let tickerTimer = 0;
async function refreshTicker(){
  const sym = active;
  try{
    const t = await pullTicker(symbolOf(sym));
    if(!t || sym !== active) return;
    $('st-hi').textContent  = fmtUsd(+t.highPrice24h);
    $('st-lo').textContent  = fmtUsd(+t.lowPrice24h);
    $('st-vol').textContent = '$'+fmtVol(+t.turnover24h);
    const perp = MARKET==='linear';
    $('st-fund-wrap').style.display = perp ? '' : 'none';
    $('st-oi-wrap').style.display   = perp ? '' : 'none';
    if(perp){
      const fr = +t.fundingRate;
      const fEl = $('st-fund');
      fEl.textContent = isFinite(fr) ? (fr>=0?'+':'')+(fr*100).toFixed(4)+'%' : '—';
      fEl.style.color = !isFinite(fr) ? '' : fr>0 ? 'var(--down)' : fr<0 ? 'var(--up)' : '';
      $('st-oi').textContent = t.openInterestValue ? '$'+fmtVol(+t.openInterestValue) : '—';
    }
    const pct = (+t.price24hPcnt)*100;
    const chg = document.querySelector('.chg');
    chg.textContent = (pct>=0?'+':'')+pct.toFixed(2)+'%';
    chg.style.color = pct>=0 ? 'var(--up)' : 'var(--down)';
    tickerOK = true;
  }catch(e){ /* the candle feed still carries the price */ }
}
let tickerOK = false;

function lightUpdate(){
  const sym = active;
  paintPrice();
  for(const tf of TFS){
    const st = stoch[sym] && stoch[sym][tf.key];
    if(!st) continue;
    const cell = $('kd-'+tf.key), sp = $('sp-'+tf.key);
    const k = st.k[st.k.length-1], d = st.d[st.d.length-1];
    if(cell) cell.innerHTML = kdCell(tf.key);
    if(sp) sp.innerHTML = deltaCell(tf.key);
  }
  renderStance();
  renderBtcStrip();
  const score = bias(states[sym], WEIGHTS);
  const sc = $('score');
  sc.textContent = (score>0?'+':'') + score;
  sc.style.color = score>8 ? 'var(--up)' : score<-8 ? 'var(--down)' : 'var(--mute)';
}

let busy = false;
async function load(){
  if(busy || scanning) return;      // a scan is saturating the connection; the tape can wait
  busy = true;
  const sym = active, meta = symbolOf(sym);
  const first = !data[sym] || (dataDepth[sym]||0) < BARS;
  try{
    const n = first ? BARS : TAIL;
    const res = await Promise.all(TFS.map(tf=>pull(meta, tf, n)));
    if(sym !== active) return;               // symbol changed mid-fetch — discard, the new call is in flight
    if(first) data[sym] = {};
    TFS.forEach((tf,i)=>{
      data[sym][tf.key] = first ? res[i] : mergeCandles(data[sym][tf.key], res[i]);
    });
    dataDepth[sym] = BARS;
    lastOk = Date.now();
    $('err').hidden = true;
    analyse(sym);

    const sig = signature(sym);
    if(first || sig !== lastSig){
      lastSig = sig;
      render();
      if(first) buildCharts(); else redraw();
    } else {
      lightUpdate(); nudgeCharts(); tick();
    }
  }catch(e){
    if(sym !== active) return;
    if(!data[sym]) $('rows').innerHTML = '';
    $('err').hidden = false;
    $('err').textContent = symbolOf(sym).sym+' feed unreachable ('+e.message+'). Retrying every second — if your network blocks exchange APIs, open this file through a VPN, or check the ticker is a real Binance/Bybit/OKX pair.';
    $('pulse').classList.add('stale');
    $('livetxt').textContent = 'Reconnecting…';
  }finally{ busy = false; }
}
