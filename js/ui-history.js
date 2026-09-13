/* ui-history.js — History view — the backtest tables.
   part of VL */

/* ---------- history view ---------- */
let histScope = 'coin', histData = null, histBusy = false;

function pctCell(v, n){
  if(v==null) return '<span class="hnum dim">·</span>';
  const cls = v>0 ? 'up' : v<0 ? 'down' : 'dim';
  return '<span class="hnum '+cls+'">'+(v>0?'+':'')+v.toFixed(2)+'%</span>';
}
function winCell(w){
  if(w==null) return '<span class="hnum dim">·</span>';
  const cls = w>=55 ? 'up' : w<=45 ? 'down' : 'dim';
  return '<span class="hnum '+cls+'">'+w+'%</span>';
}

async function buildHistory(){
  if(histBusy) return;
  histBusy = true;
  $('hframes').innerHTML = '<div class="loading">Replaying crosses…</div>';
  try{
    if(histScope==='coin'){
      histData = {label: symbolOf(active).sym, per: historyFor(active)};
    } else {
      // pool every tracked coin so the sample is big enough to mean something
      const merged = {frames:{}, buckets:{}, total:0};
      for(const code of watch){
        if(!stoch[code]){
          try{
            const meta = symbolOf(code);
            const res = await Promise.all(TFS.map(tf=>pull(meta, tf, BARS)));
            data[code] = data[code] || {};
            TFS.forEach((tf,i)=> data[code][tf.key] = mergeCandles(data[code][tf.key], res[i]));
            analyse(code);
          }catch(e){ continue; }
        }
        const h = historyFor(code);
        merged.total += h.total;
        TFS.forEach(tf=>{
          const f = h.frames[tf.key];
          if(!f) return;
          merged.frames[tf.key] = merged.frames[tf.key] || {rows:[]};
          merged.frames[tf.key].rows = merged.frames[tf.key].rows.concat(f.rows);
        });
      }
      Object.keys(merged.frames).forEach(key=>{
        const rows = merged.frames[key].rows;
        const baseline = frameBaseline(rows);
        merged.frames[key].all = summarise(rows);
        merged.frames[key].baseline = baseline;
        ['bull','bear'].forEach(dir=>['oversold','middle','overbought'].forEach(zone=>{
          const sel = rows.filter(r=>r.dir===dir && r.zone===zone);
          if(sel.length<3) return;
          merged.buckets[key+'|'+dir+'|'+zone] = {frame:key, dir, zone, baseline,
            sum:summarise(sel), backed:summarise(sel.filter(r=>r.backed))};
        }));
      });
      histData = {label: watch.length+' tracked coins', per: merged};
    }
    renderHistory();
  } finally { histBusy = false; }
}

function renderHistory(){
  const per = histData && histData.per;
  const fbox = $('hframes'), bbox = $('hbuckets');
  if(!per || !per.total){
    fbox.innerHTML = '<div class="loading">No completed signals yet. A cross needs '+
      HORIZONS[HORIZONS.length-1]+' bars of history after it before it can be scored.</div>';
    bbox.innerHTML = '';
    $('hsub').textContent = 'Every cross in the loaded history, scored by what price did next.';
    return;
  }
  fbox.innerHTML = '';
  TFS.forEach(tf=>{
    const f = per.frames[tf.key];
    if(!f || !f.all) return;
    const a = f.all.byH;
    const el = document.createElement('div');
    el.className = 'mrow hrow' + (f.all.n < 30 ? ' thinsample' : '');
    el.title = 'On '+tf.key+': '+spanBreakdown(tf.key)+
               (f.all.n < 30 ? '\nOnly '+f.all.n+' signals — too few to lean on.' : '');
    el.innerHTML =
      '<div><span class="tfk">'+tf.key+'</span>'+
        '<span class="tspan">'+spanRange(tf.key)+'</span></div>'+
      '<div class="hnum dim">'+f.all.n+'</div>'+
      HORIZONS.map(h=>'<div>'+winCell(a[h]&&a[h].win)+'</div>'+
                      '<div>'+pctCell(a[h]&&a[h].med)+'</div>').join('');
    fbox.appendChild(el);
  });

  /*  Ranked by how far each setup beats its own frame's ordinary cross, not by
      raw percentage — otherwise the monthly rows win every time purely because
      a monthly bar is a month.                                               */
  const keys = Object.keys(per.buckets)
    .sort((x,y)=>bucketEdge(per.buckets[y]) - bucketEdge(per.buckets[x]));
  bbox.innerHTML = keys.length ? '' : '<div class="loading">No group has enough samples yet.</div>';
  keys.forEach(k=>{
    const b = per.buckets[k], sm = b.sum.byH;
    const col = b.dir==='bull' ? 'var(--up)' : 'var(--down)';
    const el = document.createElement('div');
    el.className = 'mrow brow' + (b.sum.n < 30 ? ' thinsample' : '');
    const bk = b.backed && b.backed.byH[H_MAIN];
    const wMain = sm[H_MAIN] ? sm[H_MAIN].win : null;
    const ex = bucketEdge(b);
    el.title = (wMain!=null ? 'Hit rate '+spanLabel(b.frame,H_MAIN)+' after the cross: '+wMain+'%.\n' : '')+
               (isFinite(ex) ? 'Beats an ordinary '+b.frame+' cross by '+ex.toFixed(1)+
                 '× (frame typically moves '+b.baseline.toFixed(2)+'% in '+spanLabel(b.frame,H_MAIN)+
                 '). Rows are ranked on this, not on raw %.\n' : '')+
               'On '+b.frame+': '+spanBreakdown(b.frame)+
               (b.sum.n<30 ? '\nOnly '+b.sum.n+' signals — treat as a rumour.' : '');
    el.innerHTML =
      '<div class="bsetup"><b style="color:'+col+'">'+b.frame+' '+(b.dir==='bull'?'bull':'bear')+
        '</b><em>from '+b.zone+'</em>'+
        '<span class="tspan inline">'+spanRange(b.frame)+'</span></div>'+
      '<div class="hnum dim">'+b.sum.n+'</div>'+
      HORIZONS.map(h=>'<div>'+pctCell(sm[h]&&sm[h].med)+'</div>').join('')+
      '<div>'+(bk && bk.n>=3 ? pctCell(bk.med)+'<span class="samp">n='+bk.n+'</span>'
                  : '<span class="thin">too few</span>')+'</div>';
    bbox.appendChild(el);
  });

  const strong = Object.values(per.frames).filter(f=>f && f.all && f.all.n>=30).length;
  $('hsub').textContent = per.total+' scored signals across '+histData.label+
    ' · '+strong+' of 5 frames have a usable sample';
  $('hnote').textContent = 'Dimmed rows have fewer than 30 signals behind them. This measures only the coins and '+
    'the period currently loaded, on one exchange, and past behaviour is not a promise about the next trade — '+
    'read it as a lean, not proof.';
}

/*  Both tables are laid out per horizon, so their column counts and widths are
    generated rather than written down — a different HORIZONS array reshapes
    them on the next render instead of silently misaligning the headers.     */
function applyHistGrid(){
  let el = document.getElementById('histgrid');
  if(!el){ el = document.createElement('style'); el.id = 'histgrid'; document.head.appendChild(el); }
  const n = HORIZONS.length;
  el.textContent =
    '.hhead,.hrow{grid-template-columns:92px 54px repeat('+(n*2)+',minmax(0,1fr))}' +
    '.hhead2,.brow{grid-template-columns:minmax(0,1fr) 44px repeat('+n+',minmax(0,1fr)) 120px}';
}

function buildHistHeads(){
  applyHistGrid();
  const f = $('hhead-frames');
  if(f) f.innerHTML = '<span>Frame</span><span>Signals</span>' +
    HORIZONS.map(h=>'<span>'+barsLabel(h)+' hit</span><span>'+barsLabel(h)+' move</span>').join('');
  const b = $('hhead-setup');
  if(b) b.innerHTML = '<span>Setup</span><span>Signals</span>' +
    HORIZONS.map(h=>'<span>'+barsLabel(h)+'</span>').join('') +
    '<span>'+barsLabel(H_MAIN)+', divergence backed</span>';
  const e1 = $('hexp-h');
  if(e1) e1.textContent = HORIZONS.slice(0,-1).map(barsLabel).join(', ') +
    ' and ' + barsLabel(HORIZONS[HORIZONS.length-1]);
  const e2 = $('hexp-max');
  if(e2) e2.textContent = HORIZONS[HORIZONS.length-1];
}

function buildHistScope(){
  buildHistHeads();
  const box = $('h-scope'); box.innerHTML = '';
  [['coin','This coin'],['watch','Watchlist']].forEach(([v,label])=>{
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-pressed', histScope===v);
    b.onclick = ()=>{ histScope=v; buildHistScope(); buildHistory(); };
    box.appendChild(b);
  });
}
