/* scanner.js — Scanner. Sweeps the whole perpetual board for setups turning right now.
   part of VL */

/* ---------- scanner ---------- */
const SCAN_BARS = 320;          // 5,3,3 and divergence need little, but EMA 200 needs 200+
const SCAN_POOL = 8;            // parallel requests

const scanCfg = {frames:['1D','4H'], side:'both', depth:100, fresh:3, btc:'any', ema:'any'};
let scanRows = [], scanning = false, scanAbort = false, scanRan = false;
let lastScan = null;

// run `fn` over `items` with a fixed number of workers, reporting progress
async function pool(items, limit, fn, onProgress){
  let next = 0, done = 0;
  const out = new Array(items.length);
  const worker = async () => {
    while(next < items.length && !scanAbort){
      const i = next++;
      try{ out[i] = await fn(items[i]); }catch(e){ out[i] = null; }
      done++;
      if(onProgress) onProgress(done, items.length);
    }
  };
  await Promise.all(Array.from({length:Math.min(limit, items.length)}, worker));
  return out;
}

// the whole perp board in one request, with turnover so we can rank by liquidity
async function scanUniverse(){
  const res = await bybit('/tickers?category='+MARKET);
  return (res.list||[])
    .filter(t=>/USDT$/.test(t.symbol))
    .map(t=>({
      sym: t.symbol.replace(/USDT$/,''), bybit: t.symbol,
      price:+t.lastPrice, chg:(+t.price24hPcnt)*100, turnover:+t.turnover24h
    }))
    .filter(t=>isFinite(t.turnover) && t.turnover>0)
    .sort((a,b)=>b.turnover-a.turnover);
}

/*  Scoring, kept deliberately legible — every point is traceable to one of
    these five things, and the row shows you which ones fired.               */
function scoreSetup(frames){
  const order = TFS.filter(t=>scanCfg.frames.includes(t.key));   // slowest first
  let trigger = null;
  for(const tf of order){
    const f = frames[tf.key];
    if(!f || !f.state) continue;
    const st = f.state;
    const isCross = st.type==='bull'||st.type==='bear'||st.pending;
    if(isCross && st.barsAgo<=scanCfg.fresh){ trigger = {tf, f, st}; break; }
  }
  if(!trigger) return null;

  const dir = trigger.st.dir;
  if(scanCfg.side==='long'  && dir!=='bull') return null;
  if(scanCfg.side==='short' && dir!=='bear') return null;
  if(scanCfg.btc==='with' && btcVerdict(dir, trigger.tf.key).tone!=='up') return null;
  if(scanCfg.ema==='with'){
    const e = trigger.f.ema;
    if(!e || !e.ok) return null;
    if(dir==='bull' ? !e.above : e.above) return null;
  }

  const why = [];
  let score = 0;

  // 1. how much of the scanned board agrees with the trigger
  let sum=0, tot=0;
  order.forEach(tf=>{
    const f = frames[tf.key];
    tot += tf.weight;
    if(f && f.state) sum += sideOf(f.state)*tf.weight;
  });
  const align = tot ? (sum/tot)*100 : 0;
  const agree = dir==='bull' ? align : -align;
  score += Math.max(0, agree) * 0.45;
  if(agree>50) why.push('frames aligned');

  // 2. turning from an extreme beats turning mid-range
  const z = zoneOf(trigger.st.level);
  if((dir==='bull'&&z==='oversold')||(dir==='bear'&&z==='overbought')){ score+=28; why.push('from '+z); }
  else if(z==='middle'){ score+=8; why.push('mid-range'); }

  // 3. fresher is better
  score += Math.max(0, 10 - trigger.st.barsAgo*3);

  // 4. a settled cross is worth more than one that can still unwind
  if(!trigger.st.pending){ score+=10; why.push('settled'); }
  else why.push('unsettled');

  // 5. divergence backing the same direction
  const dv = trigger.f.div;
  if(dv && dv.dir===dir && (dv.pending || dv.barsAgo<=12)){ score+=16; why.push(dv.dir+' divergence'); }

  // 6. the 200 as a regime filter: a bull cross under it is counter-trend
  const er = trigger.f.ema;
  if(er && er.ok){
    if((dir==='bull' && er.above) || (dir==='bear' && !er.above)){ score+=18; why.push('with the 200'); }
    else { score-=14; why.push('against the 200'); }
  }

  // 7. does the market itself agree — the rule the whole strategy rests on
  const bv = btcVerdict(dir, trigger.tf.key);
  if(bv.tone==='up'){ score+=20; why.push('BTC agrees'); }
  else if(bv.tone==='down'){ score-=15; why.push('against BTC'); }

  return {
    dir, score: Math.round(score), align: Math.round(align),
    frame: trigger.tf.key, zone: z, barsAgo: trigger.st.barsAgo,
    pending: trigger.st.pending, why, level: trigger.st.level, btc: bv.tone,
    ema: er && er.ok ? (er.above?'above':'below') : null
  };
}

async function scanSymbol(t){
  const frames = {};
  for(const key of scanCfg.frames){
    const tf = TFS.find(x=>x.key===key);
    const rows = await pull({bybit:t.bybit}, tf, SCAN_BARS);
    const high=rows.map(r=>r.h), low=rows.map(r=>r.l), close=rows.map(r=>r.c);
    const st = stochastic(high, low, close, 5, 3, 3);
    const openT = rows[rows.length-1].t;
    const liveBar = Date.now() < barClose(tf, openT) ? rows.length-1 : -1;
    const all = divergences(st.k, st.d, high, low, {});
    all.forEach(x=> x.pending = (x.crossTo===liveBar));
    const er = emaRead(close);
    frames[key] = {
      state: crossState(st.k, st.d, 4, liveBar),
      div: currentDivergence(all, st.k),
      K: st.k[st.k.length-1], D: st.d[st.d.length-1],
      ema: {ok:er.ok, above:er.above, dist:er.dist}    // the series itself is not kept
    };
    // candles are deliberately not kept — a few hundred coins would be a lot of memory
  }
  const setup = scoreSetup(frames);
  return setup ? {...t, frames, setup} : null;
}

async function runScan(){
  if(scanning) return;
  scanning = true; scanAbort = false;
  $('sc-run').hidden = true; $('sc-stop').hidden = false;
  $('sc-bar').hidden = false;
  $('scrows').innerHTML = '<div class="loading">Pulling the board…</div>';
  try{
    await ensureBtc();                       // every score leans on the BTC reference
    const all = await scanUniverse();
    const uni = scanCfg.depth>=9999 ? all : all.slice(0, scanCfg.depth);
    const reqs = uni.length * scanCfg.frames.length;
    const started = Date.now();
    let failed = 0;
    const hits = await pool(uni, SCAN_POOL, scanSymbol, (done, total)=>{
      const pc = Math.round(done/total*100);
      $('sc-fill').style.width = pc+'%';
      const el = (Date.now()-started)/1000;
      const eta = done ? Math.round(el/done*(total-done)) : 0;
      $('sc-prog').textContent = done+' / '+total+' coins · '+reqs+' requests'+
        (eta>2 ? ' · about '+eta+'s left' : '');
    });
    failed = hits.filter(h=>h===undefined).length;
    scanRows = hits.filter(Boolean).sort((a,b)=>b.setup.score-a.setup.score);
    scanRan = true;
    lastScan = {scanned:uni.length, board:all.length, failed, secs:Math.round((Date.now()-started)/1000)};
    renderScan(uni.length);
  }catch(e){
    $('scrows').innerHTML = '<div class="loading">Scan failed: '+e.message+'</div>';
  }finally{
    scanning = false; scanAbort = false;
    $('sc-run').hidden = false; $('sc-stop').hidden = true;
    $('sc-bar').hidden = true; $('sc-fill').style.width = '0%';
  }
}

function scanFrameCell(row, key){
  const f = row.frames[key];
  if(!f || !f.state) return '<span class="fc idle">·</span>';
  const v = sideOf(f.state);
  const tone = v>0.15?'up':v<-0.15?'down':'flat';
  let g = '–';
  if(f.state.type==='bull'||f.state.type==='potential-bull') g='▲';
  else if(f.state.type==='bear'||f.state.type==='potential-bear') g='▼';
  else if(f.state.type==='nearing-bull') g='↗';
  else if(f.state.type==='nearing-bear') g='↘';
  return '<span class="fc '+tone+(f.state.pending||f.state.nearing?' un':'')+'" title="'+key+'">'+g+'</span>';
}

function renderScan(scanned){
  const host = $('scrows');
  const SHOW = 25;
  if(!scanRows.length){
    host.innerHTML = '<div class="loading">Nothing matched. Try a wider cross window or more depth.</div>';
  } else {
    host.innerHTML = '';
    scanRows.slice(0, SHOW).forEach((r,i)=>{
      const su = r.setup;
      const col = su.dir==='bull' ? 'var(--up)' : 'var(--down)';
      const el = document.createElement('div');
      el.className = 'scrow';
      el.innerHTML =
        '<div class="scrank">'+(i+1)+'</div>'+
        '<div class="scsym">'+nvIcon(r.sym)+'<b>'+r.sym+'</b><em>'+fmtVol(r.turnover)+'</em></div>'+
        '<div class="sclast num">'+fmtUsd(r.price)+'</div>'+
        '<div class="scchg num '+(r.chg>=0?'up':'down')+'">'+(r.chg>=0?'+':'')+r.chg.toFixed(1)+'%</div>'+
        '<div class="scsetup"><span style="color:'+col+'">'+
          (su.dir==='bull'?'Bull':'Bear')+' cross '+su.frame+
          (su.pending?' (live)':' · '+su.barsAgo+'b')+'</span>'+
          '<em>'+su.why.join(', ')+'</em></div>'+
        '<div class="scframes">'+scanCfg.frames.map(k=>scanFrameCell(r,k)).join('')+'</div>'+
        '<div class="scbtc"><span class="btcpill '+(su.btc==='up'?'with':su.btc==='down'?'against':'')+'">'+
          (su.btc==='up'?'with':su.btc==='down'?'against':'~')+'</span></div>'+
        '<div class="scema">'+(()=>{
          const f = r.frames[su.frame], e = f && f.ema;
          if(!e || !e.ok) return '<span class="tpill">n/a</span>';
          return '<span class="tpill '+(e.above?'above':'below')+'">'+(e.above?'over':'under')+'</span>';
        })()+'</div>'+
        '<div class="scdiv">'+(()=>{
          const f = r.frames[su.frame], dv = f && f.div;
          if(!dv) return '<span class="none">·</span>';
          return '<span style="color:'+(dv.dir==='bull'?'var(--up)':'var(--down)')+'">'+
                 (dv.dir==='bull'?'B':'S')+(dv.legs+1)+'</span>';
        })()+'</div>'+
        '<div class="scscore" style="color:'+col+'">'+su.score+'</div>'+
        '<div class="sctrack"><button class="x'+(watch.includes(r.sym)?' on':'')+
          '" data-sym="'+r.sym+'" title="Track">★</button></div>';
      el.addEventListener('click', e=>{
        if(e.target.closest('.x')) return;
        switchSymbol(r.sym); setView('terminal');
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
  const longs = scanRows.filter(r=>r.setup.dir==='bull').length;
  $('scsub').textContent = scanRan && lastScan
    ? scanRows.length+' of '+lastScan.scanned+' scanned match · '+longs+' long, '+
      (scanRows.length-longs)+' short · '+lastScan.secs+'s'+
      (lastScan.failed ? ' · '+lastScan.failed+' unavailable' : '')
    : 'Sweeps the perp board for coins turning right now.';
  $('scnote').textContent = scanRan
    ? (scanRows.length>25 ? 'Showing the top 25 of '+scanRows.length+' matches. ' : '')+
      'Ranked by: how much of the scanned board agrees, whether the turn came from an extreme, how fresh it is, whether it has settled, and whether divergence backs it.'
    : '';
}

function buildScanControls(){
  const chip = (host, items, isOn, onPick) => {
    const box = $(host); box.innerHTML = '';
    items.forEach(([val,label])=>{
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', isOn(val));
      b.onclick = ()=>{ onPick(val); buildScanControls(); };
      box.appendChild(b);
    });
  };
  chip('sc-frames', TFS.map(t=>[t.key,t.key]),
       v=>scanCfg.frames.includes(v),
       v=>{ scanCfg.frames = scanCfg.frames.includes(v)
              ? scanCfg.frames.filter(x=>x!==v)
              : TFS.filter(t=>t.key===v||scanCfg.frames.includes(t.key)).map(t=>t.key);
            if(!scanCfg.frames.length) scanCfg.frames=[v]; });
  chip('sc-side', [['both','Both'],['long','Long'],['short','Short']],
       v=>scanCfg.side===v, v=>{scanCfg.side=v;});
  chip('sc-depth', [[50,'Top 50'],[100,'Top 100'],[250,'Top 250'],[9999,'Every coin']],
       v=>scanCfg.depth===v, v=>{scanCfg.depth=v;});
  chip('sc-fresh', [[1,'1 bar'],[3,'3 bars'],[6,'6 bars']],
       v=>scanCfg.fresh===v, v=>{scanCfg.fresh=v;});
  chip('sc-btc', [['any','Any'],['with','With BTC only']],
       v=>scanCfg.btc===v, v=>{scanCfg.btc=v;});
  chip('sc-ema', [['any','Any'],['with','With the 200 only']],
       v=>scanCfg.ema===v, v=>{scanCfg.ema=v;});
}
