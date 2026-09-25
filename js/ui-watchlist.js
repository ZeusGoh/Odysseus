/* ui-watchlist.js — Watchlist view.
   part of Odysseus */

/* ---------- nav menu ---------- */
// what the collapsed nav trigger calls each view — it is the only place the current
// view is named on screen now that the buttons live in a dropdown
const VIEW_LABELS = {btc:'Bitcoin', terminal:'Terminal', watch:'Watchlist', scan:'Scanner', crowd:'Crowd', news:'Anomaly',
                     alerts:'Alerts', hist:'Backtest', sessions:'Sessions',
                     journal:'Journal', anomhist:'Anomaly History',
                     cloud:'Cloud',
                     analyst:'Analyst', anhist:'Analyst History'};

// no argument toggles; true/false forces
function navOpen(on){
  const panel = $('navpanel'), btn = $('navbtn');
  const show = on === undefined ? panel.hidden : on;
  panel.hidden = !show;
  btn.setAttribute('aria-expanded', show);
}

/* ---------- watchlist ---------- */
function setView(next){
  // the Crowd terminal lives on the Terminal now; a link to it lands on that panel
  const jumpTo = next==='crowdterm' ? 'crowdpanel' : null;
  if(jumpTo) next = 'terminal';
  view = next;
  $('btcview').hidden      = next!=='btc';
  $('terminalview').hidden = next!=='terminal';
  $('watchview').hidden    = next!=='watch';
  $('anomhistview').hidden = next!=='anomhist';
  $('scanview').hidden     = next!=='scan';
  $('crowdview').hidden    = next!=='crowd';
  $('histview').hidden     = next!=='hist';
  $('sessionsview').hidden = next!=='sessions';
  $('alertsview').hidden   = next!=='alerts';
  $('newsview').hidden     = next!=='news';
  $('journalview').hidden  = next!=='journal';
  $('analystview').hidden  = next!=='analyst';
  $('anhistview').hidden   = next!=='anhist';
  $('cloudview').hidden    = next!=='cloud';
  $('scanview').hidden     = next!=='scan';
  $('nav-btc').setAttribute('aria-pressed', next==='btc');
  $('nav-terminal').setAttribute('aria-pressed', next==='terminal');
  $('nav-watch').setAttribute('aria-pressed', next==='watch');
  $('nav-anomhist').setAttribute('aria-pressed', next==='anomhist');
  $('nav-scan').setAttribute('aria-pressed', next==='scan');
  $('nav-crowd').setAttribute('aria-pressed', next==='crowd');
  $('nav-hist').setAttribute('aria-pressed', next==='hist');
  $('nav-sessions').setAttribute('aria-pressed', next==='sessions');
  $('nav-alerts').setAttribute('aria-pressed', next==='alerts');
  $('nav-news').setAttribute('aria-pressed', next==='news');
  $('nav-journal').setAttribute('aria-pressed', next==='journal');
  $('nav-analyst').setAttribute('aria-pressed', next==='analyst');
  $('nav-anhist').setAttribute('aria-pressed', next==='anhist');
  $('nav-cloud').setAttribute('aria-pressed', next==='cloud');
  $('nav-scan').setAttribute('aria-pressed', next==='scan');
  $('navlabel').textContent = VIEW_LABELS[next] || next;
  navOpen(false);                  // picking a view is the end of the menu's job
  if(next==='btc'){ btcShow(); }
  else if(next==='watch'){ renderWatch(); scanWatch(); }
  else if(next==='anomhist'){ renderAnomHistory(); }
  else if(next==='cloud'){ cloudRender(); }
  else if(next==='scan'){ buildScanControls(); renderScan(scanRows.length); }
  else if(next==='crowd'){ buildCrowdControls(); renderCrowd(); }
  else if(next==='hist'){ buildHistScope(); buildHistory(); }
  else if(next==='sessions'){ renderSessions(); }
  else if(next==='alerts'){ buildAlertControls(); renderAlertLog(); }
  else if(next==='news'){ buildNewsControls(); renderNews(); renderAnomPanels();
                          if(!newsRan) newsScan(); }
  else if(next==='journal'){ renderJournal(); jRefreshPrices(); bybitShow(); }
  else if(next==='analyst'){ buildAnalystControls(); renderAnalyst(); }
  // the history reads through the same relay poll the Analyst view runs, so
  // entering it wires those controls the same way and asks for a fresh copy
  else if(next==='anhist'){ buildAnalystControls(); anRelay.histAt = 0; analystRelayTick(); renderAnalystHistory(); }
  else if(next==='scan'){ /* results persist between visits */ }
  else { buildCharts(); if(next==='terminal'){ if(typeof lsrShow === 'function') lsrShow(); if(typeof oicvdShow === 'function') oicvdShow(); if(typeof crowdTermShow === 'function') crowdTermShow(); } }   // charts need a visible container to size to
  if(jumpTo && $(jumpTo)) requestAnimationFrame(()=> $(jumpTo).scrollIntoView({behavior:'smooth', block:'start'}));
}

function addWatch(code){
  code = (code||'').trim().toUpperCase();
  if(!code) return;
  const sm = symbolOf(code);
  if(watch.includes(sm.sym)) return;
  watch = [...watch, sm.sym];
  store.write(watch);
  $('wsearch').value = '';
  $('wsugg').hidden = true;
  renderWatch(); scanWatch(); updateWatchCount(); renderTrackBtn();
}

function removeWatch(code){
  watch = watch.filter(c=>c!==code);
  store.write(watch);
  renderWatch(); updateWatchCount(); renderTrackBtn();
}

function updateWatchCount(){ $('watch-count').textContent = watch.length; }

function renderTrackBtn(){
  const b = $('trackbtn');
  if(!b) return;
  const on = watch.includes(active);
  b.classList.toggle('on', on);
  b.textContent = on ? 'Tracking' : 'Track';
  b.title = on ? 'Remove '+active+' from the watchlist' : 'Add '+active+' to the watchlist';
}

/*  Pull every frame for each tracked coin. Deliberately sequential and on a
    slow cadence — this is a background scan, not the live tape.             */
async function scanWatch(){
  // a coin added while a scan is running must not be skipped — mark and loop again
  if(watchBusy){ watchDirty = true; return; }
  if(!watch.length) return;
  watchBusy = true;
  try{
    do{
      watchDirty = false;
      for(const code of [...watch]){
        if(!watch.includes(code)) continue;          // removed mid-scan
        const meta = symbolOf(code);
        const first = !data[code];
        try{
          const res = await Promise.all(TFS.map(tf=>pull(meta, tf, first?BARS:TAIL)));
          if(first) data[code] = {};
          TFS.forEach((tf,i)=> data[code][tf.key] = first ? res[i] : mergeCandles(data[code][tf.key], res[i]));
          analyse(code);
        }catch(e){ markWatchRow(code, e.message||'unavailable'); }
        if(view!=='watch') break;
      }
      if(view==='watch') renderWatch();
    } while(watchDirty && view==='watch');
  } finally { watchBusy = false; }
}

function markWatchRow(code, err){
  const el = document.getElementById('wr-'+code);
  if(el && err) el.classList.add('bad');
}

// one compact cell per frame: colour is stance, glyph is what fired
function frameCell(code, tfKey){
  const st = states[code] && states[code][tfKey];
  const dv = divNow[code] && divNow[code][tfKey];
  if(!st) return '<span class="fc idle">·</span>';
  const v = sideOf(st);
  const tone = v>0.15 ? 'up' : v<-0.15 ? 'down' : 'flat';
  let glyph = '–';
  if(st.type==='bull' || st.type==='potential-bull') glyph = '▲';
  else if(st.type==='bear' || st.type==='potential-bear') glyph = '▼';
  const un = st.pending ? ' un' : '';
  const div = dv && (dv.pending || dv.barsAgo<=12) ? '<i class="dvdot '+(dv.dir==='bull'?'up':'down')+'"></i>' : '';
  return '<span class="fc '+tone+un+'" title="'+tfKey+' '+(st.type||'')+'">'+glyph+div+'</span>';
}

function renderWatch(){
  const host = $('wrows');
  updateWatchCount();
  if(!watch.length){
    host.innerHTML = '<div class="loading">No coins tracked yet. Add one above.</div>';
    $('wsub').textContent = 'Coins you are tracking, across all five frames.';
    return;
  }
  host.innerHTML = '';
  watch.forEach(code=>{
    const meta = symbolOf(code);
    const daily = data[code] && data[code]['1D'];
    const last = daily && daily[daily.length-1];
    const prev = daily && daily[daily.length-2];
    const pct = last && prev ? (last.c-prev.c)/prev.c*100 : null;
    const score = states[code] ? bias(states[code], WEIGHTS) : null;
    const tone = score==null ? 'flat' : score>8 ? 'up' : score<-8 ? 'down' : 'flat';

    const row = document.createElement('div');
    row.className = 'mrow wrow';
    row.id = 'wr-'+code;
    row.innerHTML =
      '<div class="wsym">'+nvIcon(meta.sym)+'<span class="tfk">'+meta.sym+'</span><em>'+
        nvEsc(nvCoinName(meta.sym, meta.name===meta.sym ? '' : meta.name))+'</em></div>'+
      '<div class="wlast num">'+(last?fmtUsd(last.c):'·')+'</div>'+
      '<div class="wchg num '+(pct==null?'':pct>=0?'up':'down')+'">'+
        (pct==null?'·':(pct>=0?'+':'')+pct.toFixed(2)+'%')+'</div>'+
      TFS.map(tf=>'<div class="wf">'+frameCell(code, tf.key)+'</div>').join('')+
      '<div class="wbias num '+tone+'">'+(score==null?'·':(score>0?'+':'')+score)+'</div>'+
      '<div class="wbtc">'+(()=>{
        if(code===BTC) return '<span class="btcpill">self</span>';
        const al = alignBtc(states[code]);
        if(!al.n) return '<span class="btcpill">·</span>';
        const cls = al.pct>=40 ? 'with' : al.pct<=-40 ? 'against' : '';
        const txt = al.pct>=40 ? al.agree+'/'+al.n : al.pct<=-40 ? '✕'+al.clash : '~';
        return '<span class="btcpill '+cls+'" title="'+al.agree+' frames with BTC, '+al.clash+' against">'+txt+'</span>';
      })()+'</div>'+
      '<div class="wema">'+(()=>{
        const st = stoch[code];
        if(!st) return '<span class="tpill">·</span>';
        const has = TFS.filter(t=>st[t.key] && st[t.key].ema && st[t.key].ema.ok);
        if(!has.length) return '<span class="tpill">n/a</span>';
        const up = has.filter(t=>st[t.key].ema.above).length;
        const cls = up===has.length ? 'above' : up===0 ? 'below' : '';
        return '<span class="tpill '+cls+'" title="above the 200 on '+up+' of '+has.length+' frames">'+
               up+'/'+has.length+'</span>';
      })()+'</div>'+
      '<div class="wdel"><button class="x" data-code="'+code+'" title="Stop tracking">×</button></div>';

    row.addEventListener('click', e=>{
      if(e.target.closest('.x')) return;
      switchSymbol(code);
      setView('terminal');
    });
    host.appendChild(row);
  });
  host.querySelectorAll('.x').forEach(b=>{
    b.onclick = e=>{ e.stopPropagation(); removeWatch(b.dataset.code); };
  });
  const aligned = watch.filter(c=>{
    const sc = states[c] ? bias(states[c], WEIGHTS) : 0;
    return Math.abs(sc)>8;
  }).length;
  $('wsub').textContent = watch.length+' tracked · '+aligned+' with a clear directional read';
  $('wnote').textContent = store.durable()
    ? 'Saved on this machine. Your list will be here next time you open ODYSSEUS.'
    : 'This preview cannot save to disk, so the list lasts only for this session. Open the downloaded file to keep it.';
}
